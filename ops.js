// ============================================================
// OPS AGENT — Gorilla Rental AI
// SMS via GoHighLevel (no Twilio)
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import { logActivity, createTask } from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, DRIVERS } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { sendSMS, getOrCreateContact, addNote } from './ghl.js';
import { getPipeline, updateJob, getJob, dbUpsertDelivery, dbGetDeliveries, dbUpdateDelivery } from './db.js';
import { BOOQABLE_TOOLS, dispatchBooqableTool } from './booqable.js';
import { MEMORY_TOOLS, dispatchMemoryTool } from './memory.js';

function extractActionJSON(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  const actionIdx = clean.indexOf('"action"');
  if (actionIdx === -1) return null;
  let start = actionIdx - 1;
  while (start >= 0 && /[\s]/.test(clean[start])) start--;
  if (start < 0 || clean[start] !== '{') return null;
  let depth = 0, i = start;
  while (i < clean.length) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') { depth--; if (depth === 0) return clean.slice(start, i + 1); }
    i++;
  }
  return null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client    = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

const DATA = {
  deliveries:   path.join(__dirname, 'data/deliveries.json'),
  handoffs:     path.join(__dirname, 'data/handoffs.json'),
  reservations: path.join(__dirname, 'data/reservations.json'),
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }
function getDriver(id) { return DRIVERS.find(d => d.id === id) || DRIVERS[0]; }

async function loadDeliveries(filter = {}) {
  try {
    const dbRows = await dbGetDeliveries(filter);
    if (dbRows.length) return dbRows;
  } catch {}
  let rows = readJSON(DATA.deliveries);
  if (filter.date)   rows = rows.filter(d => d.scheduledDate === filter.date);
  if (filter.status) rows = rows.filter(d => d.status === filter.status);
  return rows;
}

function formatJobSheet(delivery) {
  return `🦍 GORILLA RENTAL — JOB SHEET
=====================================
JOB ID:    ${delivery.jobId}
TYPE:      ${delivery.type.toUpperCase()} (${delivery.type === 'delivery' ? '🚚 DROP-OFF' : '📦 PICKUP'})
DATE:      ${delivery.scheduledDate}
TIME:      ${delivery.scheduledTime || 'TBC'}
CUSTOMER:  ${delivery.customerName}
PHONE:     ${delivery.customerPhone}
ADDRESS:   ${delivery.deliveryAddress}
EQUIPMENT:
${(delivery.equipment || []).map(e => `  • ${e.name} (${e.quantity}x)`).join('\n')}
NOTES:     ${delivery.notes || 'None'}
=====================================
Questions? Call Andrei: ${CONFIG.BRAND.PHONE}`.trim();
}

export async function scheduleDelivery(jobId, options = {}) {
  let res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) {
    // Fall back to DB pipeline job
    const job = await getJob(jobId).catch(() => null);
    if (!job) throw new Error(`Reservation ${jobId} not found`);
    res = { ...job, equipment: job.equipment || [] };
  }
  const driver   = getDriver(options.driverId || 'DRV-001');
  const delivery = {
    id: `DEL-${jobId}`, jobId, type: 'delivery',
    driverId: driver.id, driverName: driver.name, driverPhone: driver.phone,
    customerName: res.customerName, customerPhone: res.customerPhone, customerEmail: res.customerEmail,
    deliveryAddress: options.address || res.deliveryAddress,
    scheduledDate:   options.date    || res.startDate,
    scheduledTime:   options.time    || '08:00 AM',
    equipment: res.equipment, notes: options.notes || '',
    status: 'scheduled', createdAt: new Date().toISOString(),
  };
  const deliveries = readJSON(DATA.deliveries);
  deliveries.push(delivery);
  writeJSON(DATA.deliveries, deliveries);
  await dbUpsertDelivery(delivery).catch(() => {});
  await updateJob(jobId, { stage: 'delivery_scheduled', deliveryScheduledAt: new Date().toISOString() });
  await logActivity({ agent: 'ops', action: 'delivery_scheduled', description: `Delivery scheduled for ${jobId}`, jobId, status: 'success', notify: false }).catch(()=>{});
  console.log(`[Ops] ✅ Delivery scheduled: ${jobId} → ${driver.name} on ${delivery.scheduledDate}`);
  return delivery;
}

export async function schedulePickup(jobId, options = {}) {
  let res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) {
    const job = await getJob(jobId).catch(() => null);
    if (!job) throw new Error(`Reservation ${jobId} not found`);
    res = { ...job, equipment: job.equipment || [] };
  }
  const driver = getDriver(options.driverId || 'DRV-001');
  const pickup = {
    id: `PCK-${jobId}`, jobId, type: 'pickup',
    driverId: driver.id, driverName: driver.name, driverPhone: driver.phone,
    customerName: res.customerName, customerPhone: res.customerPhone, customerEmail: res.customerEmail,
    deliveryAddress: options.address || res.deliveryAddress,
    scheduledDate:   options.date    || res.endDate,
    scheduledTime:   options.time    || '08:00 AM',
    equipment: res.equipment, notes: options.notes || '',
    status: 'scheduled', createdAt: new Date().toISOString(),
  };
  const deliveries = readJSON(DATA.deliveries);
  deliveries.push(pickup);
  writeJSON(DATA.deliveries, deliveries);
  await dbUpsertDelivery(pickup).catch(() => {});
  await updateJob(jobId, { stage: 'pickup_scheduled', pickupScheduledAt: new Date().toISOString() });
  console.log(`[Ops] ✅ Pickup scheduled: ${jobId} → ${driver.name} on ${pickup.scheduledDate}`);
  return pickup;
}

export async function notifyDriver(jobId, type = 'delivery') {
  const deliveries = await loadDeliveries();
  const delivery   = deliveries.find(d => d.jobId === jobId && d.type === type);
  if (!delivery) throw new Error(`No ${type} found for ${jobId}`);
  const driver   = getDriver(delivery.driverId);
  const jobSheet = formatJobSheet(delivery);
  const sms      = await sendSMS(driver.phone, jobSheet, { name: driver.name, tags: ['gorilla-driver'] });
  await sendEmailWithPDF({ to: driver.email || CONFIG.BRAND.EMAIL, subject: `🦍 Job Sheet — ${jobId} — ${type.toUpperCase()} — ${delivery.scheduledDate}`, body: jobSheet, attachments: [] });
  const updates = { driverNotifiedAt: new Date().toISOString(), status: 'driver_notified' };
  const fileDeliveries = readJSON(DATA.deliveries);
  const idx = fileDeliveries.findIndex(d => d.jobId === jobId && d.type === type);
  if (idx >= 0) { Object.assign(fileDeliveries[idx], updates); writeJSON(DATA.deliveries, fileDeliveries); }
  await dbUpdateDelivery(delivery.id, updates).catch(() => {});
  console.log(`[Ops] ✅ Driver ${driver.name} notified — ${jobId}`);
  return { sms };
}

export async function notifyCustomerDelivery(jobId) {
  const allDels  = await loadDeliveries();
  const delivery = allDels.find(d => d.jobId === jobId && d.type === 'delivery');
  if (!delivery) throw new Error(`No delivery found for ${jobId}`);
  const sms = await sendSMS(delivery.customerPhone,
    `Hi ${delivery.customerName}! Your Gorilla Rental equipment (${jobId}) is scheduled for delivery on ${delivery.scheduledDate} at ${delivery.scheduledTime}. Driver ${delivery.driverName} will call 30 min before arrival. Questions? ${CONFIG.BRAND.PHONE}`,
    { name: delivery.customerName, email: delivery.customerEmail, tags: ['gorilla-rental', 'active-rental'] }
  );
  await sendEmailWithPDF({
    to: delivery.customerEmail,
    subject: `Delivery Scheduled — ${jobId} — ${delivery.scheduledDate}`,
    body: `Dear ${delivery.customerName},\n\nDelivery confirmed:\n📅 ${delivery.scheduledDate} at ${delivery.scheduledTime}\n🚚 Driver: ${delivery.driverName}\n📍 ${delivery.deliveryAddress}\n\nDriver calls 30 min before arrival.\n\n— Gorilla Rental\n${CONFIG.BRAND.PHONE}`,
    attachments: [],
  });
  console.log(`[Ops] ✅ Customer notified — ${jobId}`);
  return { sms };
}

export async function markDeliveryComplete(jobId, notes = '') {
  const allDels = await loadDeliveries();
  const delivery = allDels.find(d => d.jobId === jobId && d.type === 'delivery');
  if (!delivery) throw new Error(`No delivery found for ${jobId}`);
  const updates = { status: 'completed', completedAt: new Date().toISOString(), completionNotes: notes };
  const fileDeliveries = readJSON(DATA.deliveries);
  const idx = fileDeliveries.findIndex(d => d.jobId === jobId && d.type === 'delivery');
  if (idx >= 0) { Object.assign(fileDeliveries[idx], updates); writeJSON(DATA.deliveries, fileDeliveries); }
  await dbUpdateDelivery(delivery.id, updates).catch(() => {});
  await updateJob(jobId, { stage: 'in_progress', deliveredAt: new Date().toISOString() });
  try { const { contact } = await getOrCreateContact(delivery.customerPhone, { name: delivery.customerName }); if (contact?.id) await addNote(contact.id, `✅ Equipment delivered for ${jobId} on ${new Date().toLocaleDateString()}. ${notes}`); } catch {}
  console.log(`[Ops] ✅ Delivery complete: ${jobId}`);
  return { ...delivery, ...updates };
}

export async function markPickupComplete(jobId, inspectionNotes = '') {
  const allDels  = await loadDeliveries();
  const pickup   = allDels.find(d => d.jobId === jobId && d.type === 'pickup');
  if (!pickup) throw new Error(`No pickup found for ${jobId}`);
  const updates = { status: 'completed', completedAt: new Date().toISOString(), inspectionNotes };
  const fileDeliveries = readJSON(DATA.deliveries);
  const idx = fileDeliveries.findIndex(d => d.jobId === jobId && d.type === 'pickup');
  if (idx >= 0) { Object.assign(fileDeliveries[idx], updates); writeJSON(DATA.deliveries, fileDeliveries); }
  await dbUpdateDelivery(pickup.id, updates).catch(() => {});
  await updateJob(jobId, { stage: 'returned', returnedAt: new Date().toISOString() });
  const handoffs = readJSON(DATA.handoffs);
  handoffs.push({ jobId, type: 'return_inspection', notes: inspectionNotes, driverId: pickup.driverId, timestamp: new Date().toISOString() });
  writeJSON(DATA.handoffs, handoffs);
  try { const { contact } = await getOrCreateContact(pickup.customerPhone, { name: pickup.customerName }); if (contact?.id) await addNote(contact.id, `📦 Equipment picked up for ${jobId} on ${new Date().toLocaleDateString()}. Inspection: ${inspectionNotes || 'OK'}`); } catch {}
  console.log(`[Ops] ✅ Pickup complete: ${jobId}`);
  return { ...pickup, ...updates };
}

export async function getTodaysJobs(dateOverride) {
  const today = dateOverride || new Date().toISOString().split('T')[0];
  const rows  = await loadDeliveries({ date: today });
  return rows.filter(d => d.status !== 'completed').sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));
}

export async function getUpcomingJobs(days = 7) {
  const today  = new Date();
  const future = new Date(today.getTime() + days * 86400000);
  const rows   = await loadDeliveries();
  return rows.filter(d => { const dt = new Date(d.scheduledDate); return dt >= today && dt <= future && d.status !== 'completed'; }).sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
}

export async function opsChat(message, history = []) {
  const pipeline  = await getPipeline();
  const today     = new Date().toISOString().split('T')[0];
  const allDeliveries = await loadDeliveries();
  const todayJobs = allDeliveries.filter(d => d.scheduledDate === today);
  const upcoming  = allDeliveries.filter(d => d.scheduledDate > today && d.status !== 'completed').slice(0, 5);

  let knowledgeContext = '';
  try {
    const { getAgentContext } = await import('./knowledge.js');
    knowledgeContext = await getAgentContext('ops');
  } catch {}

  const systemPrompt = `You are the OPS Agent for Gorilla Rental — the field execution layer. You own everything that happens between the yard and the job site.

You have one driver. Your job is to make sure he has everything he needs, knows exactly where to go and when, and that every machine that leaves the yard comes back accounted for.

═══════════════════════════════════════════════════
DRIVER: ${DRIVERS.map(d => `${d.name} — ${d.phone}`).join(' | ')}
TODAY (${today}): ${todayJobs.map(d => `${d.type.toUpperCase()} | ${d.jobId} | ${d.customerName} | ${d.scheduledTime}`).join(' | ') || 'Nothing scheduled'}
UPCOMING: ${upcoming.map(d => `${d.scheduledDate} | ${d.type.toUpperCase()} | ${d.jobId}`).join(' | ') || 'None'}
ACTIVE JOBS: ${pipeline.filter(j=>['reserved','contract_sent','delivery_scheduled','in_progress'].includes(j.stage)).map(j=>`${j.jobId} | ${j.customerName} | ${j.stage}`).join(' | ') || 'None'}
═══════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 1 — DELIVERY SCHEDULING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When a new confirmed job comes in:
  1. Pull the delivery date from the Booqable order using BOOQABLE_GET_ORDER
  2. Confirm equipment, delivery address, customer name and phone are all present
  3. Schedule the delivery → {"action":"schedule_delivery","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD","time":"08:00 AM"}

The day before every delivery, send the driver an SMS via GHL with:
━━━━━━━━━━━━━━━━━━━━
JOB TOMORROW — [Job ID]
Equipment: [type] — [equipment code/asset number]
Deliver to: [full address]
Date: [date] at [time]
Customer: [name] — [phone]
Call customer 30 min before arrival.
━━━━━━━━━━━━━━━━━━━━
Use → {"action":"notify_driver","jobId":"GR-2026-XXXX","type":"delivery"}

The driver coordinates timing directly with the customer using their phone number.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 2 — PRE-DELIVERY INSPECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before any machine leaves the yard, driver completes a pre-delivery inspection in Gorilla Ops.
Inspection covers: oil level, fuel level, all functions operational, visible damage check.

If inspection passes → machine goes out, mark delivery scheduled.
If inspection fails → create a work order before the machine leaves. Do not send a machine in bad condition.

A work order for the driver contains:
  Equipment type + equipment code (asset number)
  Description of the issue found
  Priority level
  What needs to be done before delivery

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 3 — MARK DELIVERY COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When driver confirms delivery is done:
  → {"action":"mark_delivered","jobId":"GR-2026-XXXX","notes":"any site notes"}

This updates the job status to In Progress and timestamps the delivery.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 4 — PICKUP SCHEDULING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When a rental is ending:
  1. Finance or Admin triggers pickup coordination
  2. Pull return date from Booqable order
  3. Schedule the pickup → {"action":"schedule_pickup","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD"}
  4. Day before pickup, send driver same SMS format with: equipment code, address, customer name + phone
  5. Use → {"action":"notify_driver","jobId":"GR-2026-XXXX","type":"pickup"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 5 — POST-RENTAL INSPECTION + DAMAGE HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After pickup, driver does a post-rental inspection in Gorilla Ops.
Same checks: oil, fuel, all functions, visible damage.

CASE A — Equipment comes back clean:
  → {"action":"mark_picked_up","jobId":"GR-2026-XXXX","notes":"clean return"}
  Asset status updates to Available.

CASE B — Damage found on return:
  1. Document the damage in the inspection
  2. Customer fills in what happened via the QR code on the machine (Gorilla Ops QR report)
  3. QR report creates an issue automatically in Gorilla Ops
  4. From that issue, create a work order for the driver with:
     - Equipment type and code
     - Description of damage
     - Priority (HIGH if machine cannot go back out, MEDIUM if cosmetic)
  5. Machine status stays OUT OF ROTATION until work order is resolved
  6. Notify Admin so they can handle any damage billing with the customer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 6 — HOBBS METER + MAINTENANCE SCHEDULING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every piece of equipment has a Hobbs meter (hours tracker) logged in Gorilla Ops.
Whenever hours are updated for a machine, log it on the asset.

Maintenance threshold: 300 hours (soft warning — flag it, do not hard-stop)

When a machine reaches 250 hours → send soft warning:
"[Equipment name — code] is approaching 300h service interval. Schedule maintenance soon."

When a machine reaches 300 hours → trigger a maintenance request:
  Equipment type + code
  Current hours
  Type: Scheduled 300h Service
  Priority: HIGH
  Assign to driver

Machine does not need to be pulled immediately — coordinate timing with the schedule to minimize downtime.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW 7 — GPS TRACKING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GPS devices (Traccar) are installed on equipment. Gorilla Ops shows live positions.
Use GPS data to:
  - Confirm equipment arrived at the right job site
  - Monitor equipment location during active rentals
  - Flag if a machine moves when it shouldn't (after hours, wrong location)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BOOQABLE — ALWAYS PULL FROM THE SOURCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All delivery dates, customer names, phones, addresses, and equipment details come from Booqable.
Always pull the live order before scheduling or notifying — never use old cached info.
QUIET HOURS (6pm–8am ET) — Do NOT send driver SMS, customer delivery notifications, or any outbound messages. If something is scheduled or urgent, notify Andrei and ask if he wants to send it now or hold until 8am.
Use BOOQABLE_GET_ORDER to get the full order details.
Use BOOQABLE_SEARCH_CUSTOMERS if you need customer contact info separately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NON-NEGOTIABLE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Never send a machine out without a passed pre-delivery inspection
2. Always pull delivery date and customer phone from Booqable — do not guess or use old data
3. Driver always gets the SMS the day before — not the morning of
4. Damaged machines stay out of rotation until the work order is resolved
5. Every QR damage report must become a work order or inspection record
6. Hobbs warnings go out at 250h — maintenance requests at 300h
7. No end-of-day report required from driver

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE ACTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{"action":"schedule_delivery","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD","time":"08:00 AM"}
{"action":"schedule_pickup","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD"}
{"action":"notify_driver","jobId":"GR-2026-XXXX","type":"delivery"}
{"action":"notify_driver","jobId":"GR-2026-XXXX","type":"pickup"}
{"action":"notify_customer","jobId":"GR-2026-XXXX"}
{"action":"mark_delivered","jobId":"GR-2026-XXXX","notes":"..."}
{"action":"mark_picked_up","jobId":"GR-2026-XXXX","notes":"clean return / damage noted"}
{"action":"todays_jobs"}
{"action":"upcoming_jobs","days":7}

BOOQABLE TOOLS: Use BOOQABLE_GET_ORDER, BOOQABLE_LIST_ORDERS, BOOQABLE_SEARCH_CUSTOMERS to pull live job and customer data before every dispatch. Do not say you lack Booqable access — call the tool.

MEMORY TOOLS: Use MEMORY_SEARCH to recall site access notes, customer preferences, or past delivery issues for a job. Use MEMORY_ADD to save anything important the driver reported — access issues, gate codes, special site conditions.${knowledgeContext ? '\n\nKNOWLEDGE BASE:\n' + knowledgeContext : ''}`
  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, messages, tools: [...BOOQABLE_TOOLS, ...MEMORY_TOOLS] });

  // ── Tool calls (Booqable + Memory) ───────────────────────────
  const allToolCalls = [];
  let   current      = response;
  let   thread       = [...messages];
  for (let round = 0; round < 6 && current.stop_reason === 'tool_use'; round++) {
    const toolUseBlocks = current.content.filter(b => b.type === 'tool_use');
    allToolCalls.push(...toolUseBlocks.map(t => ({ name: t.name, input: t.input })));
    const toolResults = await Promise.all(toolUseBlocks.map(async tu => ({
      type:        'tool_result',
      tool_use_id: tu.id,
      content:     JSON.stringify(await (
        tu.name.startsWith('MEMORY_')   ? dispatchMemoryTool(tu.name, tu.input) :
        tu.name.startsWith('BOOQABLE_') ? dispatchBooqableTool(tu.name, tu.input) :
        Promise.resolve({ error: `Unknown tool: ${tu.name}` })
      ).catch(e => ({ error: e.message }))),
    })));
    thread  = [...thread, { role: 'assistant', content: current.content }, { role: 'user', content: toolResults }];
    current = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, tools: [...BOOQABLE_TOOLS, ...MEMORY_TOOLS], messages: thread });
  }
  if (allToolCalls.length > 0) {
    const text = current.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { text, toolCalls: allToolCalls };
  }

  // ── Internal action dispatch ─────────────────────────────────
  const text    = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched); let result = null;
      if (action.action === 'schedule_delivery')      result = await scheduleDelivery(action.jobId, action);
      else if (action.action === 'schedule_pickup')   result = await schedulePickup(action.jobId, action);
      else if (action.action === 'notify_driver')     result = await notifyDriver(action.jobId, action.type || 'delivery');
      else if (action.action === 'notify_customer')   result = await notifyCustomerDelivery(action.jobId);
      else if (action.action === 'mark_delivered')    result = await markDeliveryComplete(action.jobId, action.notes);
      else if (action.action === 'mark_picked_up')    result = await markPickupComplete(action.jobId, action.notes);
      else if (action.action === 'todays_jobs')       result = await getTodaysJobs();
      else if (action.action === 'upcoming_jobs')     result = await getUpcomingJobs(action.days || 7);
      return { text, action, result };
    } catch (e) { return { text, error: e.message }; }
  }
  return { text };
}

export function opsRoutes(app) {
  app.post('/ops/chat',            async (req, res) => { try { res.json({ ok: true, ...await opsChat(req.body.message, req.body.history || []) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/delivery',        async (req, res) => { try { res.json({ ok: true, delivery: await scheduleDelivery(req.body.jobId, req.body) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/pickup',          async (req, res) => { try { res.json({ ok: true, pickup: await schedulePickup(req.body.jobId, req.body) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/notify-driver',   async (req, res) => { try { res.json({ ok: true, ...await notifyDriver(req.body.jobId, req.body.type || 'delivery') }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/notify-customer', async (req, res) => { try { res.json({ ok: true, ...await notifyCustomerDelivery(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/delivered',       async (req, res) => { try { res.json({ ok: true, delivery: await markDeliveryComplete(req.body.jobId, req.body.notes) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/ops/picked-up',       async (req, res) => { try { res.json({ ok: true, pickup: await markPickupComplete(req.body.jobId, req.body.notes) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/ops/today',            async (req, res) => { try { res.json({ ok: true, jobs: await getTodaysJobs() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/ops/upcoming',         async (req, res) => { try { res.json({ ok: true, jobs: await getUpcomingJobs(parseInt(req.query.days) || 7) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  console.log('[Ops] ✅ Routes registered');
}
