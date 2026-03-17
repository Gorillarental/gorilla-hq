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
dotenv.config();

import { quoteRoutes, quoteChat } from './quotes.js';
import { adminRoutes, adminChat } from './admin.js';
import { opsRoutes, opsChat, getTodaysJobs, getUpcomingJobs } from './ops.js';
import { financeRoutes, financeChat, runReminderSweep, checkActiveRentals, getRevenueReport } from './finance.js';
import { marketingRoutes, marketingChat, captureLead, getMarketingStats } from './marketing.js';
import { knowledgeRoutes } from './knowledge.js';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;

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
    try { pipeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/pipeline.json'), 'utf8')); } catch {}

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

// ─── Register all agent routes ─────────────────────────────────
quoteRoutes(app);
adminRoutes(app);
opsRoutes(app);
financeRoutes(app);
marketingRoutes(app);
knowledgeRoutes(app);

// ─── Cron jobs ─────────────────────────────────────────────────
function startCronJobs() {
  console.log('[Cron] Starting scheduled jobs...');

  // Reminder sweep every 6 hours
  setInterval(async () => {
    console.log('[Cron] Running reminder sweep...');
    try {
      const result = await runReminderSweep();
      console.log(`[Cron] Sweep: ${result.sent48h?.length || 0} 48h, ${result.sent24h?.length || 0} 24h sent`);
    } catch (e) {
      console.error('[Cron] Sweep error:', e.message);
    }
  }, 6 * 60 * 60 * 1000);

  // Morning briefing at 7 AM
  function getMsUntil7am() {
    const now    = new Date();
    const target = new Date(now);
    target.setHours(7, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target - now;
  }

  setTimeout(async () => {
    await sendMorningBriefing();
    setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
  }, getMsUntil7am());

  console.log('[Cron] ✅ Jobs scheduled');
}

async function sendMorningBriefing() {
  try {
    const [active, today, report] = await Promise.all([
      checkActiveRentals(),
      getTodaysJobs(),
      getRevenueReport('month'),
    ]);

    const lines = [
      `🦍 GORILLA RENTAL — MORNING BRIEFING`,
      `📅 ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
      ``,
      `📦 TODAY'S JOBS: ${today.length}`,
      ...today.map(j => `  ${j.type.toUpperCase()} | ${j.jobId} | ${j.customerName} | ${j.scheduledTime}`),
      ``,
      `⏰ ENDING SOON: 48h: ${active.endingIn48h.length} | Overdue: ${active.overdue.length}`,
      ``,
      `💰 THIS MONTH:`,
      `  Closed: $${(report.totalRevenue || 0).toFixed(2)}`,
      `  Active: $${(report.activeRevenue || 0).toFixed(2)}`,
      `  Pipeline: $${(report.pipelineRevenue || 0).toFixed(2)}`,
    ].join('\n');

    console.log('[Morning Briefing]\n' + lines);
  } catch (e) {
    console.error('[Morning Briefing] Error:', e.message);
  }
}

// ─── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ─── Start ─────────────────────────────────────────────────────
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
