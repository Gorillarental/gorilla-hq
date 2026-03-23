// ============================================================
// GORILLA IQ — Master Orchestrator
// Receives all Telegram messages, classifies intent,
// routes to the correct agent, returns a clean reply.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';
import { dbGetConversation, dbSaveConversation, dbClearConversation } from './db.js';
import { createTask } from './logger.js';

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

// ─── Agents with unlimited persistent memory (DB-backed) ─────
const PERSISTENT_AGENTS = new Set(['marketing', 'knowledge', 'chip']);
const MAX_HISTORY = 40; // 20 turns for non-persistent agents

// ─── In-memory context (fallback / non-persistent agents) ────
const contexts = new Map(); // chatId → { history, agent, lastAt }

function getContext(chatId) {
  if (!contexts.has(chatId)) {
    contexts.set(chatId, { history: [], lastAt: Date.now() });
  }
  const ctx = contexts.get(chatId);
  ctx.lastAt = Date.now();
  return ctx.history;
}

export async function clearContext(chatId) {
  contexts.delete(chatId);
  await dbClearConversation(chatId).catch(() => {});
}

async function loadHistory(chatId, agent) {
  if (PERSISTENT_AGENTS.has(agent)) {
    const dbHistory = await dbGetConversation(chatId, agent).catch(() => []);
    if (dbHistory.length) return dbHistory;
  }
  return getContext(chatId);
}

async function pushContext(chatId, agent, role, content) {
  if (PERSISTENT_AGENTS.has(agent)) {
    // Load current, append, save — no cap for persistent agents
    const current = await dbGetConversation(chatId, agent).catch(() => []);
    current.push({ role, content });
    await dbSaveConversation(chatId, agent, current).catch(() => {});
  } else {
    const ctx = contexts.get(chatId);
    if (!ctx) return;
    ctx.history.push({ role, content });
    if (ctx.history.length > MAX_HISTORY) ctx.history.splice(0, 2);
    ctx.lastAt = Date.now();
  }
}

// ─── Agent routing map ────────────────────────────────────────
const ROUTING_SYSTEM = `You are Gorilla IQ, the master AI orchestrator for Gorilla Rental.

Classify each incoming message into ONE of these agents:

- quote: Creating quotes, pricing questions, equipment availability, new client intake, rental inquiries
- admin: Contracts, Stripe payment links, reservations, deposits, invoices, receipts, approvals, cash flow
- finance: Revenue reports, overdue rentals, 48h reminders, extensions, billing, bank reconciliation
- ops: Deliveries, pickups, driver assignments, daily schedule, dispatch, equipment status, maintenance
- marketing: Leads, social media, GHL CRM, outreach, competitor research, content
- chip: Client-facing messages, ETA updates, maintenance acknowledgements, customer service
- knowledge: Learning new information, research, knowledge base, teach the system

Respond ONLY with valid JSON: {"agent":"<name>","intent":"<one sentence description>"}`;

async function classifyMessage(text) {
  try {
    const res = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system:     ROUTING_SYSTEM,
      messages:   [{ role: 'user', content: text }],
    });
    const raw = res.content[0]?.text?.trim() ?? '';
    // Extract JSON even if there's surrounding text
    const match = raw.match(/\{[^}]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return { agent: 'admin', intent: text };
}

// ─── Route to correct agent ───────────────────────────────────
async function callAgent(agent, message, history) {
  try {
    switch (agent) {
      case 'quote': {
        const { quoteChat } = await import('./quotes.js');
        return await quoteChat(message, history);
      }
      case 'finance': {
        const { financeChat } = await import('./finance.js');
        return await financeChat(message, history);
      }
      case 'ops': {
        const { opsChat } = await import('./ops.js');
        return await opsChat(message, history);
      }
      case 'marketing': {
        const { marketingChat } = await import('./marketing.js');
        return await marketingChat(message, history);
      }
      case 'knowledge': {
        const { teach, queryKnowledge } = await import('./knowledge.js');
        // Simple knowledge query via Claude
        const res = await client.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 600,
          system:     'You are the Gorilla Rental knowledge agent. Answer concisely based on what you know about the rental business.',
          messages:   [...history, { role: 'user', content: message }],
        });
        return { reply: res.content[0]?.text ?? 'No answer found.' };
      }
      case 'chip': {
        // Customer service — Chip drafts the client message
        const res = await client.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 400,
          system:     `You are Chip, a professional customer service agent for Gorilla Rental.
Write short, warm, professional responses. Sign off as "Chip | Gorilla Rental".
Reply only with the message text — no extra commentary.`,
          messages: [...history, { role: 'user', content: message }],
        });
        return { reply: res.content[0]?.text ?? '' };
      }
      default: {
        const { adminChat } = await import('./admin.js');
        return await adminChat(message, history);
      }
    }
  } catch (e) {
    console.error(`[Gorilla IQ] Agent "${agent}" error:`, e.message);
    return { reply: `⚠️ The ${agent} agent ran into an issue: ${e.message}` };
  }
}

// ─── Auto-task creation after any agent action ────────────────
async function autoCreateTask(agent, action, result) {
  if (!action?.action) return;
  const jobId = action.jobId || result?.jobId || result?.reservation?.jobId || null;
  const taskMap = {
    build_quote:              `Follow up — Quote ${jobId} — deposit needed`,
    send_quote:               `Quote sent ${jobId} — await deposit confirmation`,
    lookup_customer:          null, // no task for lookups
    create_reservation:       `Reservation created ${jobId} — send contract`,
    send_confirmation:        `Confirmation sent ${jobId} — await contract signature`,
    send_contract:            `Contract sent ${jobId} — await signed return`,
    create_invoice:           `Invoice created for ${jobId}`,
    request_deposit_approval: `Deposit approval pending — ${jobId}`,
    request_balance_approval: `Balance approval pending — ${jobId}`,
    create_payment_link:      `Payment link created — collect $${action.amount || '?'}`,
    schedule_delivery:        `Delivery scheduled ${jobId} — notify driver + customer`,
    schedule_pickup:          `Pickup scheduled ${jobId} — notify driver`,
    notify_driver:            `Driver notified ${jobId} — confirm day-of`,
    notify_customer:          `Customer notified ${jobId}`,
    mark_delivered:           `Equipment delivered ${jobId} — schedule pickup`,
    mark_picked_up:           `Pickup complete ${jobId} — create final invoice`,
    send_48h:                 `48h reminder sent — ${jobId} — monitor response`,
    send_24h:                 `24h alert sent — ${jobId} — escalate if no reply`,
    extend:                   `Extension confirmed ${jobId} → ${action.newEndDate}`,
    reminder_sweep:           `Reminder sweep done — review overdue list`,
    capture_lead:             `New lead captured — follow up within 24h`,
    send_outreach:            `Outreach sent — follow up in 3 days`,
  };
  const title = taskMap[action.action];
  if (title === null) return; // explicitly skipped
  await createTask({
    title:       title || `${agent}: ${action.action}${jobId ? ` — ${jobId}` : ''}`,
    agent,
    jobId,
    priority:    'medium',
    createdBy:   'gorilla-iq',
    description: `Auto-created after ${action.action}`,
  }).catch(() => {});
}

// ─── Main entry point ─────────────────────────────────────────
export async function gorillaIQ(message, chatId) {
  // Classify
  const { agent, intent } = await classifyMessage(message);
  console.log(`[Gorilla IQ] Chat ${chatId} → Agent: ${agent} | Intent: ${intent}`);

  // Get conversation history (DB-backed for persistent agents)
  const history = await loadHistory(chatId, agent);

  // Call agent
  const result = await callAgent(agent, message, history);
  const reply  = result?.reply || result?.text || result?.message
    || (typeof result === 'string' ? result : null)
    || '⚠️ No response from agent';

  // Update context (only store if we have real content)
  await pushContext(chatId, agent, 'user', message);
  if (reply && reply !== '⚠️ No response from agent') await pushContext(chatId, agent, 'assistant', reply);

  // Auto-create a task whenever an agent takes an action
  if (result?.action) {
    autoCreateTask(agent, result.action, result.result).catch(() => {});
  }

  return { agent, intent, reply };
}

// ─── Quick status summary (used by /status command) ───────────
export async function getStatusSummary() {
  try {
    const [
      { checkActiveRentals }  = await import('./finance.js').catch(() => ({})),
      { getTodaysJobs }       = await import('./ops.js').catch(() => ({})),
    ] = await Promise.all([
      import('./finance.js').catch(() => ({})),
      import('./ops.js').catch(() => ({})),
    ]);

    const [rentals, jobs] = await Promise.all([
      typeof checkActiveRentals === 'function'
        ? checkActiveRentals().catch(() => ({ total: 0, endingIn48h: [], overdue: [] }))
        : { total: 0, endingIn48h: [], overdue: [] },
      typeof getTodaysJobs === 'function'
        ? getTodaysJobs().catch(() => [])
        : [],
    ]);

    const lines = [
      '🦍 <b>Gorilla IQ — System Status</b>',
      '',
      `📦 Active rentals: <b>${rentals.total}</b>`,
      rentals.endingIn48h?.length ? `⏳ Ending in 48h: <b>${rentals.endingIn48h.length}</b>` : null,
      rentals.overdue?.length     ? `🔴 Overdue: <b>${rentals.overdue.length}</b>` : null,
      `🚛 Today's jobs: <b>${jobs.length}</b>`,
      '',
      `⏰ ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    ].filter(Boolean);

    return lines.join('\n');
  } catch {
    return '🦍 <b>Gorilla IQ Online</b>\nAll agents running.';
  }
}
