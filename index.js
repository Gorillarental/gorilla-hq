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
dotenv.config();

import { quoteRoutes, quoteChat } from './quotes.js';
import { adminRoutes, adminChat } from './admin.js';
import { opsRoutes, opsChat, getTodaysJobs, getUpcomingJobs } from './ops.js';
import { financeRoutes, financeChat, runReminderSweep, checkActiveRentals, getRevenueReport } from './finance.js';
import { marketingRoutes, marketingChat, captureLead, getMarketingStats } from './marketing.js';
import { knowledgeRoutes } from './knowledge.js';
import { CONFIG } from './config.js';
import { getPipeline, initDB } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;
const upload    = multer({ storage: multer.memoryStorage() });

// ─── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    service:   'Gorilla Rental AI',
    version:   '2.0.0',
    timestamp: new Date().toISOString(),
    agents:    ['quote', 'admin', 'ops', 'finance', 'marketing', 'knowledge', 'chip'],
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
app.post('/chat', async (req, res) => {
  try {
    const { message, agent, history } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    const target = agent || detectAgent(message);
    let result;

    if (target === 'admin')      result = await adminChat(message, history || []);
    else if (target === 'ops')   result = await opsChat(message, history || []);
    else if (target === 'finance')    result = await financeChat(message, history || []);
    else if (target === 'marketing')  result = await marketingChat(message, history || []);
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
app.post('/lead', async (req, res) => {
  try {
    const result = await captureLead({ ...req.body, source: 'website' });
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
  } catch (err) {
    console.error('[Webhook] WhatsApp error:', err.message);
  }
});

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
    try { await fn(); } catch (e) { console.error(`[Cron] ${label} error:`, e.message); }
    setInterval(async () => {
      console.log(`[Cron] Running ${label}...`);
      try { await fn(); } catch (e) { console.error(`[Cron] ${label} error:`, e.message); }
    }, 24 * 60 * 60 * 1000);
  }, msUntil(hour, minute));
}

// ─── Cron jobs ─────────────────────────────────────────────────
function startCronJobs() {
  console.log('[Cron] Starting scheduled jobs...');

  // Reminder sweep every 6 hours (existing)
  setInterval(async () => {
    console.log('[Cron] Running reminder sweep...');
    try {
      const result = await runReminderSweep();
      console.log(`[Cron] Sweep: ${result.sent48h?.length || 0} 48h, ${result.sent24h?.length || 0} 24h sent`);
    } catch (e) { console.error('[Cron] Sweep error:', e.message); }
  }, 6 * 60 * 60 * 1000);

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
    console.log('[Cron] Running Monthly Report...');
    try {
      const { sendMonthlyReport } = await import('./admin.js');
      await sendMonthlyReport();
    } catch (e) { console.error('[Cron] Monthly report error:', e.message); }
    // Schedule next one (1st of following month)
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 1);
    next.setHours(8, 0, 0, 0);
    setTimeout(monthlyTick, next - Date.now());
  }, firstOfNext - Date.now());

  // Every hour — approval reminders (stale approval alerts)
  setInterval(async () => {
    const { sendReminderIfStale } = await import('./whatsapp.js');
    sendReminderIfStale().catch(e => console.error('[Cron] Approval reminder error:', e.message));
  }, 60 * 60 * 1000);

  console.log('[Cron] ✅ Jobs scheduled');
}

// ─── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ─── Start ─────────────────────────────────────────────────────
await initDB();
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
╚══════════════════════════════════════════════╝
  `);
  startCronJobs();
});

export default app;
