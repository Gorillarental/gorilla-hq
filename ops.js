// ============================================================
// OPS AGENT — Gorilla Rental AI
// SMS via GoHighLevel (no Twilio)
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, DRIVERS } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { sendSMS, getOrCreateContact, addNote } from './ghl.js';

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
  pipeline:     path.join(__dirname, 'data/pipeline.json'),
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
  const res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) throw new Error(`Reservation ${jobId} not found`);
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
  const pipeline = readJSON(DATA.pipeline);
  const idx      = pipeline.findIndex(j => j.jobId === jobId);
  if (idx >= 0) { pipeline[idx].stage = 'delivery_scheduled'; pipeline[idx].deliveryScheduledAt = new Date().toISOString(); writeJSON(DATA.pipeline, pipeline); }
  console.log(`[Ops] ✅ Delivery scheduled: ${jobId} → ${driver.name} on ${delivery.scheduledDate}`);
  return delivery;
}

export async function schedulePickup(jobId, options = {}) {
  const res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) throw new Error(`Reservation ${jobId} not found`);
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
  const pipeline = readJSON(DATA.pipeline);
  const idx      = pipeline.findIndex(j => j.jobId === jobId);
  if (idx >= 0) { pipeline[idx].stage = 'pickup_scheduled'; pipeline[idx].pickupScheduledAt = new Date().toISOString(); writeJSON(DATA.pipeline, pipeline); }
  console.log(`[Ops] ✅ Pickup scheduled: ${jobId} → ${driver.name} on ${pickup.scheduledDate}`);
  return pickup;
}

export async function notifyDriver(jobId, type = 'delivery') {
  const deliveries = readJSON(DATA.deliveries);
  const delivery   = deliveries.find(d => d.jobId === jobId && d.type === type);
  if (!delivery) throw new Error(`No ${type} found for ${jobId}`);
  const driver   = getDriver(delivery.driverId);
  const jobSheet = formatJobSheet(delivery);
  const sms      = await sendSMS(driver.phone, jobSheet, { name: driver.name, tags: ['gorilla-driver'] });
  await sendEmailWithPDF({ to: driver.email || CONFIG.BRAND.EMAIL, subject: `🦍 Job Sheet — ${jobId} — ${type.toUpperCase()} — ${delivery.scheduledDate}`, body: jobSheet, attachments: [] });
  const idx = deliveries.findIndex(d => d.jobId === jobId && d.type === type);
  deliveries[idx].driverNotifiedAt = new Date().toISOString();
  deliveries[idx].status = 'driver_notified';
  writeJSON(DATA.deliveries, deliveries);
  console.log(`[Ops] ✅ Driver ${driver.name} notified — ${jobId}`);
  return { sms };
}

export async function notifyCustomerDelivery(jobId) {
  const delivery = readJSON(DATA.deliveries).find(d => d.jobId === jobId && d.type === 'delivery');
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
  const deliveries = readJSON(DATA.deliveries);
  const idx        = deliveries.findIndex(d => d.jobId === jobId && d.type === 'delivery');
  if (idx < 0) throw new Error(`No delivery found for ${jobId}`);
  deliveries[idx].status = 'completed'; deliveries[idx].completedAt = new Date().toISOString(); deliveries[idx].completionNotes = notes;
  writeJSON(DATA.deliveries, deliveries);
  const pipeline = readJSON(DATA.pipeline);
  const pIdx     = pipeline.findIndex(j => j.jobId === jobId);
  if (pIdx >= 0) { pipeline[pIdx].stage = 'in_progress'; pipeline[pIdx].deliveredAt = new Date().toISOString(); writeJSON(DATA.pipeline, pipeline); }
  try { const { contact } = await getOrCreateContact(deliveries[idx].customerPhone, { name: deliveries[idx].customerName }); if (contact?.id) await addNote(contact.id, `✅ Equipment delivered for ${jobId} on ${new Date().toLocaleDateString()}. ${notes}`); } catch {}
  console.log(`[Ops] ✅ Delivery complete: ${jobId}`);
  return deliveries[idx];
}

export async function markPickupComplete(jobId, inspectionNotes = '') {
  const deliveries = readJSON(DATA.deliveries);
  const idx        = deliveries.findIndex(d => d.jobId === jobId && d.type === 'pickup');
  if (idx < 0) throw new Error(`No pickup found for ${jobId}`);
  deliveries[idx].status = 'completed'; deliveries[idx].completedAt = new Date().toISOString(); deliveries[idx].inspectionNotes = inspectionNotes;
  writeJSON(DATA.deliveries, deliveries);
  const pipeline = readJSON(DATA.pipeline);
  const pIdx     = pipeline.findIndex(j => j.jobId === jobId);
  if (pIdx >= 0) { pipeline[pIdx].stage = 'returned'; pipeline[pIdx].returnedAt = new Date().toISOString(); writeJSON(DATA.pipeline, pipeline); }
  const handoffs = readJSON(DATA.handoffs);
  handoffs.push({ jobId, type: 'return_inspection', notes: inspectionNotes, driverId: deliveries[idx].driverId, timestamp: new Date().toISOString() });
  writeJSON(DATA.handoffs, handoffs);
  try { const { contact } = await getOrCreateContact(deliveries[idx].customerPhone, { name: deliveries[idx].customerName }); if (contact?.id) await addNote(contact.id, `📦 Equipment picked up for ${jobId} on ${new Date().toLocaleDateString()}. Inspection: ${inspectionNotes || 'OK'}`); } catch {}
  console.log(`[Ops] ✅ Pickup complete: ${jobId}`);
  return deliveries[idx];
}

export async function getTodaysJobs() {
  const today = new Date().toISOString().split('T')[0];
  return readJSON(DATA.deliveries).filter(d => d.scheduledDate === today && d.status !== 'completed').sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));
}

export async function getUpcomingJobs(days = 7) {
  const today  = new Date();
  const future = new Date(today.getTime() + days * 86400000);
  return readJSON(DATA.deliveries).filter(d => { const dt = new Date(d.scheduledDate); return dt >= today && dt <= future && d.status !== 'completed'; }).sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
}

export async function opsChat(message, history = []) {
  const pipeline  = readJSON(DATA.pipeline);
  const today     = new Date().toISOString().split('T')[0];
  const todayJobs = readJSON(DATA.deliveries).filter(d => d.scheduledDate === today);
  const upcoming  = readJSON(DATA.deliveries).filter(d => d.scheduledDate > today && d.status !== 'completed').slice(0, 5);
  const systemPrompt = `You are the Ops Agent for Gorilla Rental. SMS via GHL.
DRIVERS: ${DRIVERS.map(d => `${d.name} (${d.phone})`).join(', ')}
TODAY (${today}): ${todayJobs.map(d => `${d.type.toUpperCase()}|${d.jobId}|${d.customerName}|${d.scheduledTime}`).join(' | ') || 'None'}
UPCOMING: ${upcoming.map(d => `${d.scheduledDate}|${d.type.toUpperCase()}|${d.jobId}`).join(' | ') || 'None'}
ACTIVE: ${pipeline.filter(j => ['reserved','contract_sent','delivery_scheduled','in_progress'].includes(j.stage)).map(j => `${j.jobId}|${j.customerName}|${j.stage}`).join(' | ') || 'None'}
ACTIONS:
{"action":"schedule_delivery","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD","time":"08:00 AM"}
{"action":"schedule_pickup","jobId":"GR-2026-XXXX","date":"YYYY-MM-DD"}
{"action":"notify_driver","jobId":"GR-2026-XXXX","type":"delivery"}
{"action":"notify_customer","jobId":"GR-2026-XXXX"}
{"action":"mark_delivered","jobId":"GR-2026-XXXX","notes":"..."}
{"action":"mark_picked_up","jobId":"GR-2026-XXXX","notes":"..."}
{"action":"todays_jobs"}
{"action":"upcoming_jobs","days":7}`;
  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, system: systemPrompt, messages });
  const text     = response.content[0].text;
  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched); let result = null;
      if (action.action === 'schedule_delivery')  result = await scheduleDelivery(action.jobId, action);
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
