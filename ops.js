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
import { sendSMS, getOrCreateContact, addNote, updateGHLStage, enrollInWorkflow, createContact } from './ghl.js';
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
  drivers:      path.join(__dirname, 'data/drivers.json'),
};

// ── Deliveries file uses { jobs: [] } format ──────────────────
function readDeliveriesFile() {
  try {
    if (!fs.existsSync(DATA.deliveries)) { fs.writeFileSync(DATA.deliveries, JSON.stringify({ jobs: [] }, null, 2)); return []; }
    const raw = JSON.parse(fs.readFileSync(DATA.deliveries, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.jobs || []);
  } catch { return []; }
}
function writeDeliveriesFile(jobs) { fs.writeFileSync(DATA.deliveries, JSON.stringify({ jobs }, null, 2)); }

// ── Handoffs file uses { handoffs: [] } format ────────────────
function readHandoffsFile() {
  try {
    if (!fs.existsSync(DATA.handoffs)) return [];
    const raw = JSON.parse(fs.readFileSync(DATA.handoffs, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.handoffs || []);
  } catch { return []; }
}
function writeHandoffsFile(list) { fs.writeFileSync(DATA.handoffs, JSON.stringify({ handoffs: list }, null, 2)); }

// ── Drivers file ──────────────────────────────────────────────
function readDriversFile() {
  try {
    if (!fs.existsSync(DATA.drivers)) return DRIVERS;
    return JSON.parse(fs.readFileSync(DATA.drivers, 'utf8'));
  } catch { return DRIVERS; }
}
function writeDriversFile(list) { fs.writeFileSync(DATA.drivers, JSON.stringify(list, null, 2)); }

function findDriverByIdOrName(query) {
  const drivers = readDriversFile();
  if (!query) return drivers[1] || drivers[0]; // default Nazar
  const q = String(query).toLowerCase();
  return drivers.find(d => d.id?.toLowerCase() === q || d.name?.toLowerCase().includes(q)) || null;
}

// ── Generate unique job ID ─────────────────────────────────────
function newJobId() { return `JOB-${Date.now()}`; }

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
  let rows = readDeliveriesFile();
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
  const deliveries = readDeliveriesFile();
  deliveries.push(delivery);
  writeDeliveriesFile(deliveries);
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
  const deliveries = readDeliveriesFile();
  deliveries.push(pickup);
  writeDeliveriesFile(deliveries);
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
  const fileDeliveries = readDeliveriesFile();
  const idx = fileDeliveries.findIndex(d => d.jobId === jobId && d.type === type);
  if (idx >= 0) { Object.assign(fileDeliveries[idx], updates); writeDeliveriesFile(fileDeliveries); }
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
  const fileDeliveries = readDeliveriesFile();
  const idx = fileDeliveries.findIndex(d => d.jobId === jobId && d.type === 'delivery');
  if (idx >= 0) { Object.assign(fileDeliveries[idx], updates); writeDeliveriesFile(fileDeliveries); }
  await dbUpdateDelivery(delivery.id, updates).catch(() => {});
  await updateJob(jobId, { stage: 'in_progress', deliveredAt: new Date().toISOString() });
  try { const { contact } = await getOrCreateContact(delivery.customerPhone, { name: delivery.customerName }); if (contact?.id) await addNote(contact.id, `✅ Equipment delivered for ${jobId} on ${new Date().toLocaleDateString()}. ${notes}`); } catch {}
  console.log(`[Ops] ✅ Delivery complete: ${jobId}`);
  return { ...delivery, ...updates };
}

// ── Auto-assign: driver with fewest jobs that day, tiebreak = Nazar ─────
function autoAssignDriver(scheduledDate) {
  const drivers = readDriversFile();
  const jobs = readDeliveriesFile();
  const counts = {};
  for (const d of drivers) counts[d.id] = 0;
  for (const j of jobs) {
    if (j.scheduledDate === scheduledDate && j.assignedDriverId) {
      counts[j.assignedDriverId] = (counts[j.assignedDriverId] || 0) + 1;
    }
  }
  // Prefer Nazar (index 1) on tie
  let best = null, bestCount = Infinity;
  for (const d of [...drivers].reverse()) { // reverse so Nazar wins ties
    if ((counts[d.id] || 0) < bestCount) { best = d; bestCount = counts[d.id] || 0; }
  }
  return best || drivers[0];
}

export async function assignDriver(jobId, driverIdOrName) {
  const jobs = readDeliveriesFile();
  const idx = jobs.findIndex(j => j.jobId === jobId || j.id === jobId);
  if (idx < 0) throw new Error(`Job ${jobId} not found`);
  const driver = findDriverByIdOrName(driverIdOrName) || autoAssignDriver(jobs[idx].scheduledDate);
  jobs[idx].assignedDriverId = driver.id;
  jobs[idx].assignedDriverName = driver.name;
  jobs[idx].status = 'assigned';
  jobs[idx].assignedAt = new Date().toISOString();
  writeDeliveriesFile(jobs);
  await notifyDriverForJob(jobs[idx], driver);
  await logActivity({ agent: 'ops', action: 'driver_assigned', description: `${driver.name} assigned to ${jobId}`, jobId, status: 'success', notify: false }).catch(() => {});
  console.log(`[Ops] Driver ${driver.name} assigned to ${jobId}`);
  return jobs[idx];
}

async function notifyDriverForJob(job, driver) {
  try {
    const GHL_API = process.env.GHL_API_URL || 'https://services.leadconnectorhq.com';
    const GHL_KEY = process.env.GHL_API_KEY;
    const LOCATION_ID = process.env.GHL_LOCATION_ID;
    const headers = { 'Authorization': `Bearer ${GHL_KEY}`, 'Content-Type': 'application/json', 'Version': process.env.GHL_API_VERSION || '2021-07-28' };

    // Find or create GHL contact for driver
    let contactId = driver.ghlContactId;
    if (!contactId && driver.phone) {
      try {
        const searchRes = await fetch(`${GHL_API}/contacts/search/duplicate?locationId=${LOCATION_ID}&phone=${encodeURIComponent(driver.phone)}`, { headers });
        const searchData = await searchRes.json();
        contactId = searchData?.contact?.id;
      } catch {}
    }
    if (!contactId && driver.phone) {
      try {
        const createRes = await fetch(`${GHL_API}/contacts/`, {
          method: 'POST', headers,
          body: JSON.stringify({ locationId: LOCATION_ID, firstName: driver.name, phone: driver.phone, tags: ['gorilla-driver'] }),
        });
        const created = await createRes.json();
        contactId = created?.contact?.id;
        if (contactId) {
          const drivers = readDriversFile();
          const di = drivers.findIndex(d => d.id === driver.id);
          if (di >= 0) { drivers[di].ghlContactId = contactId; writeDriversFile(drivers); }
        }
      } catch {}
    }

    const smsBody = `GORILLA RENTAL — New job assigned:\n${(job.type || 'JOB').toUpperCase()}\nCustomer: ${job.customerName || ''}\nAddress: ${job.deliveryAddress || ''}\nDate: ${job.scheduledDate || ''}\nTime: ${job.scheduledTime || 'TBD'}\nEquipment: ${(job.equipment || []).map(e => `${e.name} x${e.quantity || 1}`).join(', ')}\nPhone: ${job.customerPhone || ''}\nJob ID: ${job.jobId || job.id || ''}`;

    if (contactId) {
      await fetch(`${GHL_API}/conversations/messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'SMS', contactId, message: smsBody }),
      });
    } else if (driver.phone) {
      await sendSMS(driver.phone, smsBody, { name: driver.name, tags: ['gorilla-driver'] }).catch(() => {});
    }

    // Update job status
    const jobs = readDeliveriesFile();
    const idx = jobs.findIndex(j => (j.jobId || j.id) === (job.jobId || job.id));
    if (idx >= 0) { jobs[idx].status = 'notified'; jobs[idx].notifiedAt = new Date().toISOString(); writeDeliveriesFile(jobs); }

    console.log(`[Ops] Driver ${driver.name} notified for job ${job.jobId || job.id}`);
  } catch (e) { console.error(`[Ops] notifyDriverForJob error: ${e.message}`); }
}

export async function markDelivered(query) {
  const jobs = readDeliveriesFile();
  const job = jobs.find(j => j.type === 'delivery' && (
    (j.jobId || j.id) === query ||
    (j.quoteNumber || '').toLowerCase().includes(String(query).toLowerCase()) ||
    (j.customerName || '').toLowerCase().includes(String(query).toLowerCase())
  ));
  if (!job) throw new Error(`No delivery job found for: ${query}`);
  const idx = jobs.indexOf(job);
  jobs[idx].status = 'completed';
  jobs[idx].completedAt = new Date().toISOString();
  writeDeliveriesFile(jobs);

  // Update Booqable with note
  if (job.booqableOrderId) {
    try {
      const res = await fetch(`${CONFIG.BOOQABLE.BASE_URL}/orders/${job.booqableOrderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.BOOQABLE.API_KEY}` },
        body: JSON.stringify({ data: { type: 'notes', attributes: { body: `Equipment delivered ${new Date().toLocaleDateString()} by ${job.assignedDriverName || 'driver'}` } } }),
      });
      if (!res.ok) console.warn('[Ops] Booqable note error:', await res.text());
    } catch (e) { console.warn('[Ops] Booqable note error:', e.message); }
  }

  await logActivity({ agent: 'ops', action: 'delivery_complete', description: `Delivery complete — ${job.customerName}`, jobId: job.jobId || job.id, status: 'success', notify: false }).catch(() => {});
  console.log(`[Ops] Delivery marked complete: ${job.jobId || job.id}`);
  return jobs[idx];
}

export async function markPickupComplete(query) {
  const jobs = readDeliveriesFile();
  const job = jobs.find(j => j.type === 'pickup' && (
    (j.jobId || j.id) === query ||
    (j.quoteNumber || '').toLowerCase().includes(String(query).toLowerCase()) ||
    (j.customerName || '').toLowerCase().includes(String(query).toLowerCase())
  ));
  if (!job) throw new Error(`No pickup job found for: ${query}`);
  const q = job.quoteNumber || job.jobId || job.id || '';

  // 5A: Update Booqable
  try {
    if (job.booqableOrderId) {
      await fetch(`${CONFIG.BOOQABLE.BASE_URL}/orders/${job.booqableOrderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/vnd.api+json', 'Authorization': `Bearer ${CONFIG.BOOQABLE.API_KEY}` },
        body: JSON.stringify({ data: { type: 'orders', id: job.booqableOrderId, attributes: { status: 'stopped' } } }),
      });
      await fetch(`${CONFIG.BOOQABLE.BASE_URL}/orders/${job.booqableOrderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.BOOQABLE.API_KEY}` },
        body: JSON.stringify({ data: { type: 'notes', attributes: { body: `Equipment returned ${new Date().toLocaleDateString()} by ${job.assignedDriverName || 'driver'}` } } }),
      });
    }
    console.log(`[Ops] 5A Booqable updated: ${q}`);
  } catch (e) { console.error(`[Ops] 5A Booqable error: ${e.message}`); }

  // 5B: Return confirmation email
  try {
    const equipList = (job.equipment || []).map(e => `  - ${e.name} x${e.quantity || 1}`).join('\n') || '  (see order)';
    await sendEmailWithPDF({
      to: job.customerEmail,
      subject: `Equipment Returned — Thank You — ${q}`,
      body: `Dear ${job.customerName},\n\nThank you for choosing Gorilla Rental!\n\nYour equipment has been successfully returned and picked up by our team.\n\nOrder: ${q}\nEquipment:\n${equipList}\nRental Period: ${job.deliveryDate || ''} to ${new Date().toLocaleDateString()}\n\nWe hope everything went smoothly. Please don't hesitate to reach out for future rental needs.\n\n— Gorilla Rental Team\n${CONFIG.BRAND.PHONE} | ${CONFIG.BRAND.EMAIL}`,
    });
    console.log(`[Ops] 5B return email sent: ${q}`);
  } catch (e) { console.error(`[Ops] 5B email error: ${e.message}`); }

  // 5C: Final invoice if balance unpaid
  try {
    const reservations = readJSON(DATA.reservations);
    const res = reservations.find(r => (r.quoteNumber || r.jobId) === q);
    if (res && !res.balancePaid) {
      // Generate and send final invoice
      const total = res.total || res.grandTotal || 0;
      const depositAmt = res.depositPaid || 250;
      const balance = total - depositAmt;
      if (balance > 0 && res.balanceLink) {
        await sendEmailWithPDF({
          to: job.customerEmail,
          subject: `Final Invoice — ${q} — Gorilla Rental`,
          body: `Dear ${job.customerName},\n\nThank you for returning the equipment. Your final balance of $${balance.toFixed(2)} is due.\n\nPay online: ${res.balanceLink}\n\n— Gorilla Rental\n${CONFIG.BRAND.PHONE}`,
        });
        console.log(`[Ops] 5C final invoice sent: ${q}`);
      } else if (res.balancePaid) {
        await sendEmailWithPDF({
          to: job.customerEmail,
          subject: `Payment Received — Thank You — ${q}`,
          body: `Dear ${job.customerName},\n\nYour rental is complete and fully paid. Thank you!\n\nOrder: ${q}\nTotal paid: $${total.toFixed(2)}\n\n— Gorilla Rental\n${CONFIG.BRAND.PHONE}`,
        });
      }
    }
  } catch (e) { console.error(`[Ops] 5C invoice error: ${e.message}`); }

  // 5D: Update GHL
  try {
    await updateGHLStage(q, 'booked', job.ghlContactId || null).catch(() => {});
    const reservations = readJSON(DATA.reservations);
    const res = reservations.find(r => (r.quoteNumber || r.jobId) === q);
    if (res?.ghlContactId) {
      await enrollInWorkflow(res.ghlContactId, 'booked').catch(() => {});
    }
    console.log(`[Ops] 5D GHL updated: ${q}`);
  } catch (e) { console.error(`[Ops] 5D GHL error: ${e.message}`); }

  // 5E: Update local data
  const idx = jobs.indexOf(job);
  jobs[idx].status = 'completed';
  jobs[idx].completedAt = new Date().toISOString();
  writeDeliveriesFile(jobs);

  const reservations = readJSON(DATA.reservations);
  const ri = reservations.findIndex(r => (r.quoteNumber || r.jobId) === q);
  if (ri >= 0) {
    reservations[ri].status = 'completed';
    reservations[ri].completedAt = new Date().toISOString();
    writeJSON(DATA.reservations, reservations);
  }

  await logActivity({ agent: 'ops', action: 'rental_complete', description: `Rental complete — ${job.customerName} — equipment returned — ${new Date().toLocaleDateString()}`, jobId: q, status: 'success', notify: true }).catch(() => {});
  console.log(`[Ops] Pickup/rental complete: ${q}`);
  return jobs[idx];
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

// ── Handoff polling ───────────────────────────────────────────
async function pollHandoffs() {
  try {
    const { readPendingHandoffs, markHandoffReceived } = await import('./admin.js');
    const pending = readPendingHandoffs('ops_delivery_required');
    for (const handoff of pending) {
      try {
        const jobs = readDeliveriesFile();

        // Create delivery job
        const deliveryJob = {
          id: newJobId(),
          jobId: handoff.quoteNumber,
          quoteNumber: handoff.quoteNumber,
          booqableOrderId: handoff.booqableOrderId || '',
          type: 'delivery',
          customerName: handoff.customerName,
          customerEmail: handoff.customerEmail,
          customerPhone: handoff.customerPhone,
          deliveryAddress: handoff.deliveryAddress,
          equipment: handoff.equipment ? [{ name: handoff.equipment, quantity: 1 }] : [],
          scheduledDate: handoff.deliveryDate,
          scheduledTime: handoff.deliveryTimeWindow || '7:00 AM',
          notes: handoff.notes || '',
          status: 'unassigned',
          createdAt: new Date().toISOString(),
        };

        // Create pickup job
        const pickupJob = {
          id: newJobId() + '-pck',
          jobId: handoff.quoteNumber,
          quoteNumber: handoff.quoteNumber,
          booqableOrderId: handoff.booqableOrderId || '',
          type: 'pickup',
          customerName: handoff.customerName,
          customerEmail: handoff.customerEmail,
          customerPhone: handoff.customerPhone,
          deliveryAddress: handoff.deliveryAddress,
          equipment: handoff.equipment ? [{ name: handoff.equipment, quantity: 1 }] : [],
          scheduledDate: handoff.pickupDate,
          scheduledTime: '8:00 AM',
          notes: handoff.notes || '',
          status: 'unassigned',
          createdAt: new Date().toISOString(),
        };

        // Auto-assign drivers
        const deliveryDriver = autoAssignDriver(deliveryJob.scheduledDate);
        deliveryJob.assignedDriverId = deliveryDriver.id;
        deliveryJob.assignedDriverName = deliveryDriver.name;
        deliveryJob.status = 'assigned';

        const pickupDriver = autoAssignDriver(pickupJob.scheduledDate);
        pickupJob.assignedDriverId = pickupDriver.id;
        pickupJob.assignedDriverName = pickupDriver.name;
        pickupJob.status = 'assigned';

        jobs.push(deliveryJob, pickupJob);
        writeDeliveriesFile(jobs);

        // Notify drivers
        await notifyDriverForJob(deliveryJob, deliveryDriver);
        await notifyDriverForJob(pickupJob, pickupDriver);

        markHandoffReceived(handoff.id);

        console.log(`[Ops] Received handoff ${handoff.id} — delivery ${handoff.deliveryDate} — pickup ${handoff.pickupDate}`);
        await logActivity({ agent: 'ops', action: 'handoff_received', description: `Ops received — ${handoff.customerName} — delivery ${handoff.deliveryDate} — pickup ${handoff.pickupDate}`, jobId: handoff.quoteNumber, status: 'success', notify: false }).catch(() => {});
      } catch (e) { console.error(`[Ops] Handoff processing error (${handoff.id}): ${e.message}`); }
    }
  } catch (e) { console.error('[Ops] pollHandoffs error:', e.message); }
}

// Start polling on load (2s delay), then every 15 minutes
setTimeout(() => pollHandoffs(), 2000);
setInterval(() => pollHandoffs(), 15 * 60 * 1000);

// ── Daily reminder at 6:00 AM ─────────────────────────────────
function msUntilHour(hour) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

setTimeout(async function dailyReminder() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const jobs = readDeliveriesFile().filter(j => j.scheduledDate === today && j.status !== 'completed');
    for (const job of jobs) {
      const driver = findDriverByIdOrName(job.assignedDriverName || job.assignedDriverId);
      if (!driver) continue;
      const msg = `REMINDER — Gorilla Rental ${(job.type || 'JOB').toUpperCase()} TODAY:\n${job.customerName} — ${job.deliveryAddress} — ${job.scheduledTime || 'TBD'}\nEquipment: ${(job.equipment || []).map(e => `${e.name} x${e.quantity || 1}`).join(', ')}\nJob ID: ${job.jobId || job.id}`;
      await sendSMS(driver.phone, msg, { name: driver.name, tags: ['gorilla-driver'] }).catch(() => {});
      console.log(`[Ops] Daily reminder sent to ${driver.name} for job ${job.jobId || job.id}`);
    }
  } catch (e) { console.error('[Ops] Daily reminder error:', e.message); }
  setTimeout(dailyReminder, 24 * 60 * 60 * 1000);
}, msUntilHour(6));

export async function opsChat(message, history = []) {
  const msg = message.toLowerCase().trim();

  // ── Direct command matching ─────────────────────────────────
  try {
    if (/today.{0,10}jobs|jobs today/.test(msg)) {
      const jobs = await getTodaysJobs();
      if (!jobs.length) return { text: 'No jobs scheduled for today.' };
      const lines = jobs.map(j => `[${j.type.toUpperCase()}] ${j.customerName} | ${j.deliveryAddress} | ${j.scheduledTime || 'TBD'} | Driver: ${j.assignedDriverName || 'Unassigned'} | Status: ${j.status}`).join('\n');
      return { text: `Today's Jobs (${jobs.length}):\n${lines}`, jobs };
    }

    if (/upcoming jobs|jobs this week|next \d+ days/.test(msg)) {
      const days = parseInt(msg.match(/next (\d+) days/)?.[1] || '7');
      const jobs = await getUpcomingJobs(days);
      if (!jobs.length) return { text: `No upcoming jobs in the next ${days} days.` };
      const byDate = {};
      for (const j of jobs) { (byDate[j.scheduledDate] = byDate[j.scheduledDate] || []).push(j); }
      const lines = Object.entries(byDate).map(([date, jbs]) => `${date}:\n` + jbs.map(j => `  [${j.type.toUpperCase()}] ${j.customerName} | Driver: ${j.assignedDriverName || 'Unassigned'}`).join('\n')).join('\n');
      return { text: `Upcoming Jobs:\n${lines}`, jobs };
    }

    const assignMatch = msg.match(/assign\s+(\w+)\s+to\s+(.+)/);
    if (assignMatch) {
      const driverQuery = assignMatch[1];
      const jobQuery = assignMatch[2].trim();
      const jobs = readDeliveriesFile();
      const job = jobs.find(j => (j.jobId || j.id || '').toLowerCase().includes(jobQuery.toLowerCase()) || (j.customerName || '').toLowerCase().includes(jobQuery.toLowerCase()) || (j.quoteNumber || '').toLowerCase().includes(jobQuery.toLowerCase()));
      if (!job) return { text: `No job found for: ${jobQuery}` };
      const updated = await assignDriver(job.jobId || job.id, driverQuery);
      return { text: `${updated.assignedDriverName} assigned to ${job.jobId || job.id} and notified via SMS.`, job: updated };
    }

    const markDeliveredMatch = msg.match(/mark\s+(.+?)\s+delivered|delivered.*for\s+(.+)/);
    if (markDeliveredMatch) {
      const query = (markDeliveredMatch[1] || markDeliveredMatch[2]).trim();
      const result = await markDelivered(query);
      return { text: `Delivery marked complete for ${result.customerName}.`, job: result };
    }

    const markReturnedMatch = msg.match(/mark\s+(.+?)\s+returned|pickup complete for\s+(.+)|returned.*for\s+(.+)/);
    if (markReturnedMatch) {
      const query = (markReturnedMatch[1] || markReturnedMatch[2] || markReturnedMatch[3]).trim();
      const result = await markPickupComplete(query);
      return { text: `Pickup complete for ${result.customerName}. Return email sent, GHL updated.`, job: result };
    }

    const whereIsMatch = msg.match(/where is\s+(\w+)\s+today/);
    if (whereIsMatch) {
      const driverName = whereIsMatch[1];
      const today = new Date().toISOString().split('T')[0];
      const jobs = readDeliveriesFile().filter(j => j.scheduledDate === today && (j.assignedDriverName || '').toLowerCase().includes(driverName.toLowerCase()));
      if (!jobs.length) return { text: `No jobs for ${driverName} today.` };
      const lines = jobs.map(j => `[${j.type.toUpperCase()}] ${j.customerName} | ${j.deliveryAddress} | ${j.scheduledTime || 'TBD'}`).join('\n');
      return { text: `${driverName}'s jobs today:\n${lines}`, jobs };
    }

    const rescheduleMatch = msg.match(/reschedule\s+(.+?)\s+to\s+(\d{4}-\d{2}-\d{2})/);
    if (rescheduleMatch) {
      const jobQuery = rescheduleMatch[1].trim();
      const newDate = rescheduleMatch[2];
      const jobs = readDeliveriesFile();
      const idx = jobs.findIndex(j => (j.jobId || j.id || '').toLowerCase().includes(jobQuery.toLowerCase()) || (j.customerName || '').toLowerCase().includes(jobQuery.toLowerCase()));
      if (idx < 0) return { text: `No job found for: ${jobQuery}` };
      jobs[idx].scheduledDate = newDate;
      writeDeliveriesFile(jobs);
      const driver = findDriverByIdOrName(jobs[idx].assignedDriverName || jobs[idx].assignedDriverId);
      if (driver) await notifyDriverForJob(jobs[idx], driver);
      return { text: `Job ${jobs[idx].jobId || jobs[idx].id} rescheduled to ${newDate}. Driver notified.`, job: jobs[idx] };
    }

    const addNoteMatch = msg.match(/add note to\s+(.+?):\s*(.+)/);
    if (addNoteMatch) {
      const jobQuery = addNoteMatch[1].trim();
      const noteText = addNoteMatch[2].trim();
      const jobs = readDeliveriesFile();
      const idx = jobs.findIndex(j => (j.jobId || j.id || '').toLowerCase().includes(jobQuery.toLowerCase()) || (j.customerName || '').toLowerCase().includes(jobQuery.toLowerCase()));
      if (idx < 0) return { text: `No job found for: ${jobQuery}` };
      jobs[idx].notes = (jobs[idx].notes ? jobs[idx].notes + '\n' : '') + `[${new Date().toLocaleDateString()}] ${noteText}`;
      writeDeliveriesFile(jobs);
      return { text: `Note added to ${jobs[idx].jobId || jobs[idx].id}.`, job: jobs[idx] };
    }
  } catch (cmdErr) {
    console.error('[Ops] Command error:', cmdErr.message);
    return { text: `Error: ${cmdErr.message}`, error: cmdErr.message };
  }

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

  // New routes
  app.post('/ops/assign-driver', async (req, res) => {
    try {
      const { jobId, driverId } = req.body;
      if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
      const job = await assignDriver(jobId, driverId || null);
      res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ops/mark-delivered', async (req, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
      const job = await markDelivered(jobId);
      res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ops/mark-returned', async (req, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
      const job = await markPickupComplete(jobId);
      res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ops/jobs/today', async (req, res) => {
    try { res.json({ ok: true, jobs: await getTodaysJobs() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ops/jobs/upcoming', async (req, res) => {
    try {
      const jobs = await getUpcomingJobs(parseInt(req.query.days) || 7);
      const byDate = {};
      for (const j of jobs) { (byDate[j.scheduledDate] = byDate[j.scheduledDate] || []).push(j); }
      res.json({ ok: true, jobs, byDate });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ops/drivers', async (req, res) => {
    try {
      const drivers = readDriversFile();
      const today = new Date().toISOString().split('T')[0];
      const allJobs = readDeliveriesFile();
      const now = new Date();
      const weekEnd = new Date(now.getTime() + 7 * 86400000);
      const result = drivers.map(d => ({
        ...d,
        jobsToday: allJobs.filter(j => j.scheduledDate === today && j.assignedDriverId === d.id).length,
        jobsThisWeek: allJobs.filter(j => { const dt = new Date(j.scheduledDate); return dt >= now && dt <= weekEnd && j.assignedDriverId === d.id; }).length,
      }));
      res.json({ ok: true, drivers: result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.put('/ops/drivers/:id', async (req, res) => {
    try {
      const drivers = readDriversFile();
      const idx = drivers.findIndex(d => d.id === req.params.id);
      if (idx < 0) return res.status(404).json({ ok: false, error: 'Driver not found' });
      if (req.body.phone) drivers[idx].phone = req.body.phone;
      if (req.body.ghlContactId) drivers[idx].ghlContactId = req.body.ghlContactId;
      writeDriversFile(drivers);
      res.json({ ok: true, driver: drivers[idx] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Ops] ✅ Routes registered');
}
