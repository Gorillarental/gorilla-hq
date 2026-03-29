// ============================================================
// GORILLA IQ — Master Orchestrator
// Receives all Telegram messages, classifies intent,
// routes to the correct agent, returns a clean reply.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';
import { dbGetConversation, dbSaveConversation, dbClearConversation } from './db.js';
import { createTask } from './logger.js';
import { MEMORY_TOOLS, dispatchMemoryTool } from './memory.js';

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

// ─── Agents with unlimited persistent memory (DB-backed) ─────
const PERSISTENT_AGENTS = new Set(['marketing', 'knowledge', 'chip']);
const MAX_HISTORY = 40; // 20 turns for non-persistent agents

// ─── In-memory context (fallback / non-persistent agents) ────
const contexts = new Map(); // chatId → { history, agent, lastAt, lastAgentReplyEndsWithQuestion }

const STICKY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getContext(chatId) {
  if (!contexts.has(chatId)) {
    contexts.set(chatId, { history: [], agent: null, lastAt: Date.now(), awaitingReply: false });
  }
  const ctx = contexts.get(chatId);
  ctx.lastAt = Date.now();
  return ctx.history;
}

// Returns the sticky agent if the conversation is mid-flow, otherwise null
function getStickyAgent(chatId) {
  const ctx = contexts.get(chatId);
  if (!ctx || !ctx.agent) return null;
  const age = Date.now() - ctx.lastAt;
  if (age > STICKY_TIMEOUT_MS) return null;   // conversation timed out
  if (!ctx.awaitingReply) return null;         // agent didn't ask a question
  return ctx.agent;
}

function setContextAgent(chatId, agent, awaitingReply) {
  const ctx = contexts.get(chatId);
  if (!ctx) return;
  ctx.agent        = agent;
  ctx.awaitingReply = awaitingReply;
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
const ROUTING_SYSTEM = `You are Gorilla IQ, the master AI orchestrator for Gorilla Rental — a heavy equipment rental company in South Florida.

Classify each incoming message into ONE of these agents:

- quote: ANY request involving pricing, equipment availability, new rental inquiries, quote creation or revision, rate questions, "how much", "do you have", "I need a lift/boom/scissor", "can you quote me", "send pricing", extend a rental quote, or convert a quote to a booking
- admin: Contracts, Stripe payment links, deposit collection, reservations, invoices, receipts, approvals, cash flow, booking confirmations
- finance: Revenue reports, overdue rentals, 48h reminders, billing issues, bank reconciliation, payment tracking
- ops: Deliveries, pickups, driver assignments, daily schedule, dispatch, equipment status, maintenance, site logistics
- marketing: Leads, social media, GHL CRM, outreach, competitor research, content creation
- chip: Client-facing messages, ETA updates, maintenance acknowledgements, general customer service replies
- knowledge: Learning new information, research, knowledge base updates, teach the system something new

IMPORTANT: When in doubt between quote and admin — if it involves pricing or equipment inquiry, route to quote. If it involves payment execution or contract signing, route to admin.

Respond ONLY with valid JSON: {"agent":"<name>","intent":"<one sentence description>"}`;

async function classifyMessage(text, recentHistory = []) {
  try {
    // Include last 4 messages as context so the classifier understands follow-up replies
    const contextMessages = recentHistory.slice(-4).map(m => ({
      role:    m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    contextMessages.push({ role: 'user', content: text });

    const res = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system:     ROUTING_SYSTEM,
      messages:   contextMessages,
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
        const { query } = await import('./knowledge.js');
        const result = await query(message);
        return { reply: result.answer ?? 'No answer found.' };
      }
      case 'chip': {
        const chipSystem = `You are Chip, the customer-facing voice of Gorilla Rental. Every message you write goes directly to a real customer — make it count.

Your job is to respond fast, sound human, and make the customer feel taken care of. You represent the company.

ALWAYS search memory first (MEMORY_SEARCH) to recall who this customer is and any past interactions before you respond.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 1 — QUOTE FOLLOW-UP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After a quote is sent:
  Same day (if urgent): "Hi [name], just wanted to make sure you received our quote. Let me know if you have any questions or want to make any changes."
  24h no response: "Hi [name], following up on the quote we sent. Happy to adjust anything — just say the word."
  3 days no response: "Hi [name], last follow-up on your equipment quote. Pricing and availability are subject to change — let me know if you'd like to lock it in."
Keep it short. Never be pushy. Give them one clear action to take.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 2 — DELIVERY NOTIFICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Day before delivery: "Hi [name], confirming your [equipment] delivery tomorrow. Our driver will call you about 30 minutes before arrival. Any questions, call us at [phone]."
Day of (driver on the way): "Hi [name], your driver is on the way — estimated arrival around [time]. He'll call when close."
After delivery confirmed: "Hi [name], your equipment is set up and ready to go. Let us know if you need anything."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 3 — EXTENSION REQUESTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer asks to extend:
  1. Confirm: "Of course — how long do you need to extend?"
  2. Collect new end date
  3. Let Finance handle the repricing and Booqable update
  4. Confirm back: "Done, you're extended through [date]. Updated invoice on its way."
Do not quote prices yourself — hand off to Finance for extension pricing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 4 — COMPLAINTS + PROBLEMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer reports a problem:
  1. Acknowledge immediately: "I'm sorry to hear that — let me get this sorted for you right away."
  2. Equipment issue → escalate to OPS
  3. Billing issue → escalate to Admin or Finance
  4. Always follow up after resolution: "Just wanted to make sure everything got taken care of. Let us know if there's anything else."
Never leave a complaint without a response.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 5 — PICKUP COORDINATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Day before pickup: "Hi [name], just a reminder that we'll be picking up your [equipment] tomorrow. Our driver will reach out to coordinate the time. Anything we should know about site access?"
After pickup: "Hi [name], we've picked up the equipment. Thanks for choosing Gorilla Rental — hope the project went well!"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 6 — REVIEW REQUESTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After a rental closes cleanly, send one review request:
  "Hi [name], glad we could help with your project! If you have a moment, we'd really appreciate a Google review — it helps us a lot. [link] Thanks!"
Only send this once. Never follow up on a review request.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Short and direct — never more than 3–4 sentences per message
- Warm but professional — not robotic, not overly casual
- Always give one clear next step
- Sign every message as: Chip | Gorilla Rental
- Reply only with the message text — no commentary, no labels

MEMORY: Search before every response. Save important notes after every interaction — customer preferences, site access details, complaints, anything that matters next time.`;
        const res = await client.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     chipSystem,
          messages:   [...history, { role: 'user', content: message }],
          tools:      MEMORY_TOOLS,
        });
        if (res.stop_reason === 'tool_use') {
          const toolUseBlocks = res.content.filter(b => b.type === 'tool_use');
          const toolResults   = await Promise.all(toolUseBlocks.map(async tu => ({
            type: 'tool_result', tool_use_id: tu.id,
            content: JSON.stringify(await dispatchMemoryTool(tu.name, tu.input).catch(e => ({ error: e.message }))),
          })));
          const followUp = await client.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 1024, system: chipSystem, tools: MEMORY_TOOLS,
            messages: [...history, { role: 'user', content: message }, { role: 'assistant', content: res.content }, { role: 'user', content: toolResults }],
          });
          return { reply: followUp.content.filter(b => b.type === 'text').map(b => b.text).join('') };
        }
        return { reply: res.content.filter(b => b.type === 'text').map(b => b.text).join('') };
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
  // Ensure context exists so getStickyAgent can read it
  getContext(chatId);

  // Use sticky agent if mid-conversation, otherwise classify fresh
  const stickyAgent = getStickyAgent(chatId);
  let agent, intent;
  if (stickyAgent) {
    agent  = stickyAgent;
    intent = `(follow-up) ${message}`;
    console.log(`[Gorilla IQ] Chat ${chatId} → Sticky: ${agent} | "${message}"`);
  } else {
    const recentHistory = getContext(chatId);
    ({ agent, intent } = await classifyMessage(message, recentHistory));
    console.log(`[Gorilla IQ] Chat ${chatId} → Agent: ${agent} | Intent: ${intent}`);
  }

  // Get conversation history (DB-backed for persistent agents)
  const history = await loadHistory(chatId, agent);

  // Call agent
  const result = await callAgent(agent, message, history);
  const reply  = result?.reply || result?.text || result?.message
    || (typeof result === 'string' ? result : null)
    || '⚠️ No response from agent';

  // Update context (only store if we have real content)
  await pushContext(chatId, agent, 'user', message);
  if (reply && reply !== '⚠️ No response from agent') {
    await pushContext(chatId, agent, 'assistant', reply);
    // Mark whether agent asked a follow-up question so next reply stays sticky
    const awaitingReply = reply.trimEnd().endsWith('?');
    setContextAgent(chatId, agent, awaitingReply);
  }

  // Auto-create a task whenever an agent takes an action
  if (result?.action) {
    autoCreateTask(agent, result.action, result.result).catch(() => {});
  }

  return { agent, intent, reply, action: result?.action || null, agentResult: result?.result || null };
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
