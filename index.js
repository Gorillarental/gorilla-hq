// ============================================================
// INDEX.JS — Gorilla Rental AI — Main Server
// Port 3000 | All agents | Cron jobs
// ============================================================

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
dotenv.config();

import { sendTelegram, telegramWebhookHandler, notifyAll } from './telegram.js';
import { quoteRoutes, quoteChat } from './quotes.js';
import { adminRoutes, adminChat } from './admin.js';
import { opsRoutes, opsChat, getTodaysJobs, getUpcomingJobs } from './ops.js';
import { financeRoutes, financeChat, runReminderSweep, checkActiveRentals, getRevenueReport } from './finance.js';
import { marketingRoutes, marketingChat, captureLead, getMarketingStats } from './marketing.js';
import { knowledgeRoutes } from './knowledge.js';
import { loggerRoutes } from './logger.js';
import { CONFIG } from './config.js';
import { getPipeline, initDB, checkDBHealth } from './db.js';
import { ghlRoutes, getOpportunities, getPipelineId } from './ghl.js';
import { scraperRoutes } from './google-scraper.js';
import { getOutcomeSummary } from './outcomes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;
const upload    = multer({ storage: multer.memoryStorage() });

// ─── Rate limiters ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Chat rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Webhook rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.includes('/telegram'),
});

// ─── Input validation middleware ───────────────────────────────
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid input', details: result.error.flatten() });
    }
    req.body = result.data;
    next();
  };
}

const leadSchema = z.object({
  name:     z.string().min(1).max(200).optional(),
  phone:    z.string().regex(/^[\d\s\-\+\(\)]{7,20}$/).optional(),
  email:    z.string().email().optional(),
  interest: z.string().max(500).optional(),
  source:   z.string().max(100).optional(),
  equipment: z.string().max(500).optional(),
  message:  z.string().max(2000).optional(),
}).passthrough();  // allow extra fields (e.g. customerName, customerEmail)

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  chatId:  z.string().max(100).optional(),
  agent:   z.string().max(50).optional(),
  history: z.array(z.any()).optional(),
}).passthrough();

const depositSchema = z.object({
  quoteNumber: z.string().regex(/^GR-\d{4}-\d{4}$/),
}).passthrough();

// ─── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiters
app.use('/api/', apiLimiter);
app.use('/chat', chatLimiter);
app.use('/quote/chat', chatLimiter);
app.use('/admin/chat', chatLimiter);
app.use('/ops/chat', chatLimiter);
app.use('/finance/chat', chatLimiter);
app.use('/marketing/chat', chatLimiter);
app.use('/knowledge/chat', chatLimiter);
app.use('/chip/chat', chatLimiter);
app.use('/webhook/', webhookLimiter);

// ─── Health ───────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { getBreakerStatus } = await import('./circuit-breaker.js');
  const { getDataSource } = await import('./db.js');
  res.json({
    ok:         true,
    service:    'Gorilla Rental AI',
    version:    '2.0.0',
    timestamp:  new Date().toISOString(),
    agents:     ['quote', 'admin', 'ops', 'finance', 'marketing', 'knowledge', 'chip'],
    dataSource: getDataSource(),
    breakers:   getBreakerStatus(),
  });
});

// ─── Dashboard API ─────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [activeRentals, todaysJobs, upcomingJobs, monthReport] = await Promise.all([
      checkActiveRentals().catch(() => ({ total: 0, endingIn48h: [], endingIn24h: [], overdue: [] })),
      getTodaysJobs().catch(() => []),
      getUpcomingJobs(7).catch(() => []),
      getRevenueReport('month').catch(() => ({})),
    ]);

    let pipeline = [];
    try { pipeline = await getPipeline(); } catch {}

    res.json({
      ok:        true,
      timestamp: new Date().toISOString(),
      pipeline: {
        total:   pipeline.length,
        byStage: pipeline.reduce((acc, j) => { acc[j.stage] = (acc[j.stage] || 0) + 1; return acc; }, {}),
        recent:  pipeline.slice(-5).reverse(),
      },
      rentals: {
        active:          activeRentals.total,
        endingIn48h:     activeRentals.endingIn48h?.length || 0,
        overdue:         activeRentals.overdue?.length     || 0,
        endingIn48hJobs: activeRentals.endingIn48h         || [],
        overdueJobs:     activeRentals.overdue             || [],
      },
      ops: {
        todaysJobs:   todaysJobs.length,
        upcomingJobs: upcomingJobs.length,
        today:        todaysJobs,
        upcoming:     upcomingJobs.slice(0, 5),
      },
      finance: {
        monthRevenue:    monthReport.totalRevenue    || 0,
        activeRevenue:   monthReport.activeRevenue   || 0,
        pipelineRevenue: monthReport.pipelineRevenue || 0,
        completedJobs:   monthReport.completedJobs   || 0,
        avgJobValue:     monthReport.avgJobValue      || 0,
      },
      marketing: getMarketingStats(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Master chat router ────────────────────────────────────────
app.post('/chat', validate(chatSchema), async (req, res) => {
  try {
    const { message, agent, history } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    const target = agent || detectAgent(message);
    let result;

    if (target === 'admin')           result = await adminChat(message, history || []);
    else if (target === 'ops')        result = await opsChat(message, history || []);
    else if (target === 'finance')    result = await financeChat(message, history || []);
    else if (target === 'marketing')  result = await marketingChat(message, history || []);
    else if (target === 'knowledge' || target === 'chip') {
      const { gorillaIQ } = await import('./gorilla-iq.js');
      result = await gorillaIQ(message, 'api');
    }
    else                              result = await quoteChat(message, history || []);

    res.json({ ok: true, agent: target, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function detectAgent(message) {
  const msg = message.toLowerCase();
  if (/contract|reservation|invoice|deposit|confirm|signed/.test(msg))       return 'admin';
  if (/deliver|pickup|driver|schedule|today|dispatch|nazar/.test(msg))        return 'ops';
  if (/remind|overdue|extend|revenue|report|balance due|payment/.test(msg))   return 'finance';
  if (/lead|post|social|outreach|marketing|instagram|facebook|listing/.test(msg)) return 'marketing';
  return 'quote';
}

// ─── Lead intake from website ──────────────────────────────────
app.post('/lead', validate(leadSchema), async (req, res) => {
  try {
    const result = await captureLead({ ...req.body, source: req.body.source || 'website' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── WhatsApp webhook (GHL calls this when Andrei replies) ─────
app.post('/webhook/whatsapp', async (req, res) => {
  res.json({ received: true }); // respond fast
  try {
    const body    = req.body;
    const phone   = (body.phone || body.from || body.contact?.phone || '').replace(/\D/g, '');
    const rawMsg  = (body.message || body.body || body.text || '').trim();
    const message = rawMsg.toUpperCase();

    // Only process messages from Andrei
    if (phone !== '15619286999' && phone !== '5619286999') return;

    const { listPendingApprovals, grantApproval, denyApproval, notifyAndrei } = await import('./whatsapp.js');
    const { sendPaymentLink, recordPaymentInCashflow, requestBalanceApproval } = await import('./admin.js');
    const pending = await listPendingApprovals();
    const byAge   = pending.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // ── Post-rental special replies ─────────────────────────────
    const postApproval = byAge.find(a => a.metadata?.type === 'post_rental');
    if (postApproval && (message.startsWith('DAMAGE ') || message.startsWith('DAYS ') || message.startsWith('OTHER ') || message === 'CLEAR')) {
      const jobId = postApproval.metadata?.jobId;
      await grantApproval(postApproval.id);

      if (message === 'CLEAR') {
        await notifyAndrei(`✅ Rental ${jobId} closed cleanly — no extra charges.`);
      } else {
        let amount = 0, description = '';
        if (message.startsWith('DAMAGE ')) {
          amount = parseFloat(message.split(' ')[1]) || 0;
          description = 'Damage charge';
        } else if (message.startsWith('DAYS ')) {
          const days = parseInt(message.split(' ')[1]) || 1;
          amount = days * 150;
          description = `${days} extra day${days > 1 ? 's' : ''}`;
        } else if (message.startsWith('OTHER ')) {
          const parts = rawMsg.split(' ');
          amount = parseFloat(parts[parts.length - 1]) || 0;
          description = parts.slice(1, -1).join(' ');
        }
        if (amount > 0) {
          const { requestApproval } = await import('./whatsapp.js');
          const chargeId = `APR-CHARGE-${jobId}-${Date.now()}`;
          await requestApproval(chargeId,
            `🦍 EXTRA CHARGE — ${jobId}\nAmount: $${amount.toFixed(2)}\nDescription: ${description}\n\nReply YES to send payment link to customer\nReply NO to cancel\n\nApproval ID: ${chargeId}`,
            { type: 'extra_charge', jobId, amount, description }
          );
        }
      }
      return;
    }

    // ── Standard YES / NO ───────────────────────────────────────
    if (message === 'YES' || message === 'NO') {
      const approval = byAge[0];
      if (!approval) { await notifyAndrei('No pending approvals found.'); return; }

      if (message === 'YES') {
        await grantApproval(approval.id);
        const meta = approval.metadata || {};
        if (meta.type === 'deposit' || meta.type === 'balance') {
          try { await sendPaymentLink(meta.jobId, meta.type); } catch (e) { console.error('[Webhook] sendPaymentLink error:', e.message); }
        }
        if (meta.type === 'extra_charge' && meta.jobId && meta.amount) {
          try {
            await sendPaymentLink(meta.jobId, 'extra_charge');
            await recordPaymentInCashflow(meta.jobId, meta.amount, 'income', meta.description || 'Extra charge', 'Extra Charges');
          } catch (e) { console.error('[Webhook] extra charge error:', e.message); }
        }
        await notifyAndrei(`✅ Approved — ${approval.id}`);
      } else {
        await denyApproval(approval.id);
        await notifyAndrei(`❌ Denied — ${approval.id}`);
      }
    }
    // Learning commands from Andrei
    else if (message.startsWith('LEARN ')) {
      const url = rawMsg.slice(6).trim();
      const { addToLearningQueue } = await import('./knowledge.js');
      await addToLearningQueue(url, 'andrei_whatsapp', 'high');
      await notifyAndrei(`🧠 Learning from: ${url}\nI'll send you a summary when done.`);
    }
    else if (message.startsWith('TEACH ')) {
      const content = rawMsg.slice(6).trim();
      const { teach } = await import('./knowledge.js');
      await teach('Manual: ' + content.slice(0, 50), content, 'general', 'andrei_whatsapp');
      await notifyAndrei(`✅ Taught! Added to knowledge base.`);
    }
    else if (message === 'SWEEP') {
      const { dailyLearningSweep } = await import('./knowledge.js');
      await notifyAndrei('🔄 Starting learning sweep...');
      dailyLearningSweep().then(r => notifyAndrei(`✅ Sweep done: ${r.learned?.length || 0} learned, ${r.failed?.length || 0} failed`)).catch(() => {});
    }
    else if (message === 'KNOWLEDGE REPORT') {
      const { weeklyKnowledgeReport } = await import('./knowledge.js');
      const result = await weeklyKnowledgeReport();
      await notifyAndrei('📚 KNOWLEDGE REPORT\n\n' + result.report.slice(0, 1500));
    }
  } catch (err) {
    console.error('[Webhook] WhatsApp error:', err.message);
  }
});

// Validate deposit-paid endpoint before it reaches admin routes
app.post('/admin/deposit-paid', validate(depositSchema));

// Multer-wrapped receipt upload (applied at route registration)
app.post('/admin/receipt', upload.single('file'), async (req, res) => {
  try {
    const { processReceipt } = await import('./admin.js');
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const result = await processReceipt(req.file.buffer, req.file.originalname, req.file.mimetype, req.body);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Register all agent routes ─────────────────────────────────
quoteRoutes(app);
adminRoutes(app);
opsRoutes(app);
financeRoutes(app);
marketingRoutes(app);
knowledgeRoutes(app);
loggerRoutes(app);
ghlRoutes(app);
scraperRoutes(app);

// ─── Cron error alerting helper ────────────────────────────────
async function runCronJob(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[Cron] ${label} failed:`, e.message);
    try {
      await sendTelegram(`⚠️ <b>Cron job failed</b>\nJob: ${label}\nError: ${e.message}\nTime: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET`);
    } catch {} // If Telegram also fails, we've done what we can
  }
}

// ─── Cron helpers ──────────────────────────────────────────────
function msUntil(hour, minute = 0) {
  const now = new Date();
  const t   = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

function dailyAt(hour, minute, fn, label) {
  setTimeout(async () => {
    console.log(`[Cron] Running ${label}...`);
    await runCronJob(label, fn);
    setInterval(async () => {
      console.log(`[Cron] Running ${label}...`);
      await runCronJob(label, fn);
    }, 24 * 60 * 60 * 1000);
  }, msUntil(hour, minute));
}

// ─── Cron jobs ─────────────────────────────────────────────────
function startCronJobs() {
  console.log('[Cron] Starting scheduled jobs...');

  // Reminder sweep every 6 hours (existing)
  setInterval(() => runCronJob('Finance reminder sweep', async () => {
    const result = await runReminderSweep();
    console.log(`[Cron] Sweep: ${result.sent48h?.length || 0} 48h, ${result.sent24h?.length || 0} 24h sent`);
  }), 6 * 60 * 60 * 1000);

  // 7:00 AM — Morning briefing (full version from admin.js)
  dailyAt(7, 0, async () => {
    const { sendMorningBriefing } = await import('./admin.js');
    await sendMorningBriefing();
  }, 'Morning Briefing');

  // 7:30 AM — Balance payment approvals for today's deliveries
  dailyAt(7, 30, async () => {
    const { requestBalanceApproval } = await import('./admin.js');
    const jobs = await getTodaysJobs().catch(() => []);
    for (const j of jobs) {
      if (j.type === 'delivery' && j.jobId) {
        requestBalanceApproval(j.jobId).catch(e => console.error('[Cron] Balance approval error:', e.message));
      }
    }
  }, 'Balance Approvals');

  // 9:00 AM — Late rental check
  dailyAt(9, 0, async () => {
    const { checkLateRentals } = await import('./admin.js');
    await checkLateRentals();
  }, 'Late Rental Check');

  // 8:00 AM on 1st of month — Monthly report
  const now = new Date();
  const firstOfNext = new Date(now.getFullYear(), now.getMonth() + 1, 1, 8, 0, 0, 0);
  setTimeout(async function monthlyTick() {
    await runCronJob('Monthly Report', async () => {
      const { sendMonthlyReport } = await import('./admin.js');
      await sendMonthlyReport();
    });
    // Schedule next one (1st of following month)
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 1);
    next.setHours(8, 0, 0, 0);
    setTimeout(monthlyTick, next - Date.now());
  }, firstOfNext - Date.now());

  // Every hour — approval reminders + expire stale approvals
  setInterval(() => runCronJob('Approval reminders', async () => {
    const { sendReminderIfStale, expireStaleApprovals } = await import('./whatsapp.js');
    await expireStaleApprovals();
    await sendReminderIfStale();
  }), 60 * 60 * 1000);

  // Every hour — quote expiry check + payment link expiry warnings
  setInterval(() => runCronJob('Quote & payment expiry sweep', async () => {
    const now = new Date();
    const { getPipeline, updateJob } = await import('./db.js');
    const { recordExpiry } = await import('./outcomes.js');
    const { updateGHLStage, enrollInWorkflow } = await import('./ghl.js');
    const { logActivity } = await import('./logger.js');

    const pipeline = await getPipeline().catch(() => []);
    const expiredQuotes = pipeline.filter(j =>
      j.status === 'sent' && j.expiresAt && new Date(j.expiresAt) < now
    );

    for (const quote of expiredQuotes) {
      try {
        await updateJob(quote.jobId, { status: 'expired', stage: 'expired', expiredAt: now.toISOString() });
        await recordExpiry(quote);
        await updateGHLStage(quote.jobId || quote.quoteNumber, 'expired');
        if (quote.ghlContactId) await enrollInWorkflow(quote.ghlContactId, 'expired');
        await logActivity({ agent: 'quote', action: 'quote_expired', description: `Quote expired — ${quote.customerName} — ${quote.jobId}`, jobId: quote.jobId, status: 'info', notify: false });
        console.log(`[Cron] Quote expired: ${quote.jobId} (${quote.customerName})`);
      } catch (e) {
        console.error(`[Cron] Expiry error for ${quote.jobId}: ${e.message}`);
      }
    }

    if (expiredQuotes.length > 0) console.log(`[Cron] Quote expiry sweep: ${expiredQuotes.length} expired`);

    // Check payment links expiring in next 5 days
    const plPath = new URL('./data/payment-links.json', import.meta.url).pathname;
    try {
      if (fs.existsSync(plPath)) {
        const store = JSON.parse(fs.readFileSync(plPath, 'utf8'));
        const links = store?.links || [];
        let changed = false;
        for (const link of links) {
          if (link.notified) continue;
          if (new Date(link.warningAt).getTime() < Date.now()) {
            await sendTelegram(`⚠️ <b>Payment link expiring soon!</b>\nQuote: ${link.quoteNumber}\nAmount: $${link.amount}\nExpires: ${new Date(link.expiresAt).toLocaleDateString()}\nURL: ${link.url}\n\nRegenerate if not yet paid.`);
            link.notified = true;
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(plPath, JSON.stringify(store, null, 2));
      }
    } catch (e) {
      console.warn('[Cron] Payment link check error:', e.message);
    }
  }), 60 * 60 * 1000);

  // Daily learning sweep — 2:00 AM
  dailyAt(2, 0, async () => {
    const { dailyLearningSweep } = await import('./knowledge.js');
    await dailyLearningSweep();
  }, 'Daily Learning Sweep');

  // Daily Google scrape at 5 AM
  function getMsUntilHour5() {
    const now = new Date();
    const next5am = new Date(now);
    next5am.setHours(5, 0, 0, 0);
    if (next5am <= now) next5am.setDate(next5am.getDate() + 1);
    return next5am - now;
  }

  setTimeout(() => {
    runCronJob('Daily Google scrape', async () => {
      const { scrapeAndAddToGHL } = await import('./google-scraper.js');
      await scrapeAndAddToGHL({ maxTotal: 50, maxPerSearch: 5 });
    });
    setInterval(() => runCronJob('Daily Google scrape', async () => {
      const { scrapeAndAddToGHL } = await import('./google-scraper.js');
      await scrapeAndAddToGHL({ maxTotal: 50, maxPerSearch: 5 });
    }), 24 * 60 * 60 * 1000);
  }, getMsUntilHour5());

  // Weekly knowledge report — Monday 8:00 AM
  // Check if today is Monday (day 1)
  setInterval(async () => {
    if (new Date().getDay() === 1 && new Date().getHours() === 8 && new Date().getMinutes() < 5) {
      await runCronJob('Weekly Knowledge Report', async () => {
        const { weeklyKnowledgeReport } = await import('./knowledge.js');
        const { notifyAndrei } = await import('./whatsapp.js');
        const result = await weeklyKnowledgeReport();
        await notifyAndrei('📚 WEEKLY KNOWLEDGE REPORT\n\n' + result.report).catch(() => {});
      });
    }
  }, 5 * 60 * 1000); // check every 5 minutes

  console.log('[Cron] ✅ Jobs scheduled');
}

// ─── Stats API ─────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { getActivityLog, getTasks } = await import('./logger.js');
    const pipeline = await getPipeline().catch(() => []);
    const tasks = getTasks({ status: 'pending' });
    const activity = getActivityLog({ limit: 5 });
    res.json({
      ok: true,
      pipeline: { total: pipeline.length },
      tasks: { pending: tasks.length, high: tasks.filter(t => t.priority === 'high').length },
      activity: { recent: activity },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Pipeline Stats API (GHL + outcomes) ──────────────────────
let _pipelineStatsCache = null;
let _pipelineStatsCacheTime = 0;

app.get('/pipeline-stats', async (req, res) => {
  try {
    const now = Date.now();
    // Cache for 5 minutes unless forced refresh
    if (_pipelineStatsCache && (now - _pipelineStatsCacheTime) < 5 * 60 * 1000 && !req.query.refresh) {
      return res.json({ ok: true, ..._pipelineStatsCache, cached: true });
    }

    // Get GHL opportunities
    let ghlOpps = [];
    let pipelineIdUsed = null;
    try {
      pipelineIdUsed = await getPipelineId('Gorilla Rental');
      if (pipelineIdUsed) {
        ghlOpps = await getOpportunities({ pipelineId: pipelineIdUsed, limit: 100 });
      }
    } catch (e) {
      console.warn('[Pipeline Stats] GHL fetch error:', e.message);
    }

    // Aggregate by stage
    const stageStats = {};
    let totalPipeline = 0;
    for (const opp of ghlOpps) {
      if (opp.status !== 'open') continue;
      const stage = opp.pipelineStage?.name || opp.stage || 'Unknown';
      if (!stageStats[stage]) stageStats[stage] = { count: 0, totalValue: 0 };
      stageStats[stage].count++;
      stageStats[stage].totalValue += opp.monetaryValue || 0;
      totalPipeline += opp.monetaryValue || 0;
    }

    // Win/loss from outcomes file
    const outcomes = getOutcomeSummary();

    const stats = {
      quoteSent:     stageStats['Quote Sent']   || { count: 0, totalValue: 0 },
      negotiation:   stageStats['Negotiation']  || { count: 0, totalValue: 0 },
      booked:        stageStats['Booked']        || { count: 0, totalValue: 0 },
      totalPipeline,
      wonThisMonth:  outcomes.wonThisMonth,
      lostThisMonth: 0, // tracked in outcomes
      winRate:       outcomes.winRate,
      outcomes: {
        won:     outcomes.won,
        lost:    outcomes.lost,
        expired: outcomes.expired,
        winRate: outcomes.winRate,
      },
      lastUpdated: new Date().toISOString(),
    };

    _pipelineStatsCache    = stats;
    _pipelineStatsCacheTime = now;

    res.json({ ok: true, ...stats });
  } catch (e) {
    // Return cached data on error
    if (_pipelineStatsCache) {
      return res.json({ ok: true, ..._pipelineStatsCache, cached: true, cacheError: e.message });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Company onboarding ────────────────────────────────────────
app.post('/admin/onboard', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Onboarding started — this takes 1-2 minutes' });
    const { runOnboarding } = await import('./company-onboarding.js');
    runOnboarding().catch(e => console.error('[Onboarding] Error:', e.message));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/admin/snapshot', (req, res) => {
  try {
    const snapshotPath = path.join(__dirname, 'data/company-snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      return res.json({ ok: false, message: 'No snapshot yet — run POST /admin/onboard first' });
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    res.json({ ok: true, snapshot });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Knowledge + Chip chat routes ──────────────────────────────
app.post('/knowledge/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    const { gorillaIQ } = await import('./gorilla-iq.js');
    const result = await gorillaIQ(message, 'knowledge-ui');
    res.json({ ok: true, agent: 'knowledge', text: result.reply, reply: result.reply });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/chip/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    const { gorillaIQ } = await import('./gorilla-iq.js');
    const result = await gorillaIQ(message, 'chip-ui');
    res.json({ ok: true, agent: 'chip', text: result.reply, reply: result.reply });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ─── Telegram webhook ──────────────────────────────────────────
app.post('/webhook/telegram', telegramWebhookHandler);

// ─── Start ─────────────────────────────────────────────────────
await initDB();
await checkDBHealth();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🦍 GORILLA RENTAL AI — ONLINE              ║
║                                              ║
║   Port:    ${String(PORT).padEnd(33)}║
║   Health:  http://localhost:${PORT}/health      ║
║   API:     http://localhost:${PORT}/api         ║
║                                              ║
║   ✅ Quote      ✅ Admin      ✅ Ops         ║
║   ✅ Finance    ✅ Marketing  ✅ Knowledge   ║
║   ✅ Chip (Email via Microsoft 365)          ║
║   ✅ Logger (Activity log & Task manager)    ║
╚══════════════════════════════════════════════╝
  `);
  startCronJobs();
});

export default app;
