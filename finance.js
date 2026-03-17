// ============================================================
// FINANCE AGENT — Gorilla Rental AI
// SMS via GoHighLevel (no Twilio)
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, PRICING } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { sendSMS, getOrCreateContact, addNote, addTag } from './ghl.js';

function extractActionJSON(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  const start = clean.indexOf('{"action"');
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  while (i < clean.length) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) return clean.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client    = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

const DATA = {
  pipeline:     path.join(__dirname, 'data/pipeline.json'),
  reservations: path.join(__dirname, 'data/reservations.json'),
  invoices:     path.join(__dirname, 'data/invoices.json'),
  reminders:    path.join(__dirname, 'data/reminders.json'),
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }
function hoursUntil(dateStr) { return (new Date(dateStr) - new Date()) / 3600000; }

async function createStripePaymentLink(amount, metadata = {}) {
  const res = await fetch('https://api.stripe.com/v1/payment_links', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${CONFIG.STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'line_items[0][price_data][currency]':                   'usd',
      'line_items[0][price_data][product_data][name]':         metadata.description || 'Gorilla Rental',
      'line_items[0][price_data][unit_amount]':                String(Math.round(amount * 100)),
      'line_items[0][quantity]':                               '1',
      'metadata[job_id]':                                      metadata.jobId || '',
      'metadata[type]':                                        metadata.type  || 'payment',
    }),
  });
  if (!res.ok) throw new Error(`Stripe: ${await res.text()}`);
  return (await res.json()).url;
}

export async function checkActiveRentals() {
  const pipeline     = readJSON(DATA.pipeline);
  const reservations = readJSON(DATA.reservations);
  const active       = pipeline.filter(j => ['in_progress','delivery_scheduled','contract_sent','reserved'].includes(j.stage));
  const results      = { total: active.length, endingIn48h: [], endingIn24h: [], overdue: [], active: [] };

  for (const job of active) {
    if (!job.endDate) continue;
    const hours = hoursUntil(job.endDate);
    const res   = reservations.find(r => r.jobId === job.jobId);
    const info  = {
      jobId:         job.jobId,
      customerName:  job.customerName,
      customerPhone: job.customerPhone || res?.customerPhone,
      customerEmail: job.customerEmail || res?.customerEmail,
      endDate:       job.endDate,
      hoursRemaining: Math.round(hours),
      total:         job.total,
      stage:         job.stage,
      balanceDue:    res?.balanceDue  || 0,
      balanceLink:   res?.balanceLink || null,
    };
    if (hours < 0)       results.overdue.push(info);
    else if (hours <= 24) results.endingIn24h.push(info);
    else if (hours <= 48) results.endingIn48h.push(info);
    else                  results.active.push(info);
  }
  return results;
}

export async function send48hReminder(jobId) {
  const reservations = readJSON(DATA.reservations);
  const pipeline     = readJSON(DATA.pipeline);
  const data         = reservations.find(r => r.jobId === jobId) || pipeline.find(j => j.jobId === jobId);
  if (!data) throw new Error(`Job ${jobId} not found`);

  const sms = await sendSMS(data.customerPhone,
    `Hi ${data.customerName}! Your Gorilla Rental equipment (${jobId}) is due back in 48 hours on ${data.endDate}. Need an extension? Call ${CONFIG.BRAND.PHONE}. Balance: $${(data.balanceDue || 0).toFixed(2)}`,
    { name: data.customerName, email: data.customerEmail, tags: ['gorilla-rental', 'reminder-sent'] }
  );

  try {
    const { contact } = await getOrCreateContact(data.customerPhone, { name: data.customerName });
    if (contact?.id) {
      await addTag(contact.id, ['48h-reminder-sent']);
      await addNote(contact.id, `⏰ 48h reminder sent for ${jobId}. Return: ${data.endDate}`);
    }
  } catch {}

  await sendEmailWithPDF({
    to:      data.customerEmail,
    subject: `⏰ 48-Hour Return Reminder — ${jobId} — Gorilla Rental`,
    body: `Dear ${data.customerName},\n\nYour rental equipment is due back in 48 hours.\n\n📋 JOB ID: ${jobId}\n📅 RETURN DATE: ${data.endDate}\n💰 BALANCE DUE: $${(data.balanceDue || 0).toFixed(2)}\n${data.balanceLink ? `\n👇 PAY NOW: ${data.balanceLink}` : ''}\n\nNeed an extension?\n📞 ${CONFIG.BRAND.PHONE}\n📧 ${CONFIG.BRAND.EMAIL}\n\n— Gorilla Rental Team`,
    attachments: [],
  });

  const reminders = readJSON(DATA.reminders);
  reminders.push({ jobId, type: '48h_reminder', sentAt: new Date().toISOString() });
  writeJSON(DATA.reminders, reminders);

  console.log(`[Finance] ✅ 48h reminder sent — ${jobId}`);
  return { sms };
}

export async function send24hAlert(jobId) {
  const data = readJSON(DATA.reservations).find(r => r.jobId === jobId) || {};

  await sendSMS(CONFIG.BRAND.PHONE,
    `🚨 ALERT: ${jobId} returns in <24h (${data.endDate}). Customer: ${data.customerName} ${data.customerPhone}. No reply to 48h reminder.`,
    { name: 'Andrei - Gorilla Rental' }
  );

  if (data.customerPhone) {
    await sendSMS(data.customerPhone,
      `Gorilla Rental: Your equipment (${jobId}) returns TOMORROW ${data.endDate}. Confirm return or extension NOW: ${CONFIG.BRAND.PHONE}`,
      { name: data.customerName, tags: ['urgent-reminder'] }
    );
  }

  const reminders = readJSON(DATA.reminders);
  reminders.push({ jobId, type: '24h_alert', sentAt: new Date().toISOString() });
  writeJSON(DATA.reminders, reminders);

  console.log(`[Finance] ✅ 24h alert sent — ${jobId}`);
  return { ok: true };
}

export async function processExtension(jobId, newEndDate) {
  const reservations = readJSON(DATA.reservations);
  const pipeline     = readJSON(DATA.pipeline);
  const resIdx       = reservations.findIndex(r => r.jobId === jobId);
  if (resIdx < 0) throw new Error(`Reservation ${jobId} not found`);

  const res      = reservations[resIdx];
  const oldDays  = Math.max(1, Math.ceil((new Date(res.endDate) - new Date(res.startDate)) / 86400000));
  const newDays  = Math.ceil((new Date(newEndDate) - new Date(res.startDate)) / 86400000);
  const extra    = newDays - oldDays;
  if (extra <= 0) throw new Error('New end date must be after current end date');

  let extensionCharge = 0;
  for (const eq of res.equipment || []) {
    const daily = eq.dailyRate || (eq.total / oldDays);
    extensionCharge += daily * extra * (eq.quantity || 1);
  }
  extensionCharge *= (1 + PRICING.TAX_RATE);

  const paymentLink = await createStripePaymentLink(extensionCharge, {
    jobId, type: 'extension',
    description: `Extension ${extra} day(s) — ${jobId} — Gorilla Rental`,
  });

  reservations[resIdx].endDate          = newEndDate;
  reservations[resIdx].extensionCharge  = (res.extensionCharge || 0) + extensionCharge;
  reservations[resIdx].extensions       = [...(res.extensions || []), { from: res.endDate, to: newEndDate, extra, charge: extensionCharge, paymentLink, at: new Date().toISOString() }];
  writeJSON(DATA.reservations, reservations);

  const pipIdx = pipeline.findIndex(j => j.jobId === jobId);
  if (pipIdx >= 0) { pipeline[pipIdx].endDate = newEndDate; writeJSON(DATA.pipeline, pipeline); }

  await sendSMS(res.customerPhone,
    `Gorilla Rental: Extension confirmed for ${jobId}. New return: ${newEndDate}. Charge: $${extensionCharge.toFixed(2)}. Pay: ${paymentLink}`,
    { name: res.customerName, tags: ['gorilla-rental', 'extension'] }
  );

  await sendEmailWithPDF({
    to:      res.customerEmail,
    subject: `Extension Confirmed — ${jobId} — Gorilla Rental`,
    body:    `Dear ${res.customerName},\n\nExtension confirmed!\n\n📋 Job: ${jobId}\n📅 New Return: ${newEndDate}\n➕ Extra Days: ${extra}\n💰 Charge: $${extensionCharge.toFixed(2)}\n\n👇 PAY NOW: ${paymentLink}\n\n— Gorilla Rental\n${CONFIG.BRAND.PHONE}`,
    attachments: [],
  });

  try {
    const { contact } = await getOrCreateContact(res.customerPhone, { name: res.customerName });
    if (contact?.id) await addNote(contact.id, `📅 Extension for ${jobId}: → ${newEndDate} (+${extra} days, +$${extensionCharge.toFixed(2)})`);
  } catch {}

  console.log(`[Finance] ✅ Extension: ${jobId} → ${newEndDate} (+$${extensionCharge.toFixed(2)})`);
  return { jobId, newEndDate, extra, extensionCharge, paymentLink };
}

export async function getRevenueReport(period = 'month') {
  const pipeline = readJSON(DATA.pipeline);
  const now      = new Date();
  let fromDate;
  if (period === 'week')       fromDate = new Date(now.getTime() - 7 * 86400000);
  else if (period === 'month') fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (period === 'year')  fromDate = new Date(now.getFullYear(), 0, 1);
  else                         fromDate = new Date(0);

  const jobs      = pipeline.filter(j => new Date(j.createdAt || 0) >= fromDate);
  const completed = jobs.filter(j => j.stage === 'completed');
  const active    = jobs.filter(j => j.stage === 'in_progress');

  return {
    period,
    from:            fromDate.toISOString().split('T')[0],
    to:              now.toISOString().split('T')[0],
    totalJobs:       jobs.length,
    completedJobs:   completed.length,
    activeJobs:      active.length,
    quotedJobs:      jobs.filter(j => ['quote_sent','reserved'].includes(j.stage)).length,
    totalRevenue:    completed.reduce((s, j) => s + (j.total || 0), 0),
    activeRevenue:   active.reduce((s, j) => s + (j.total || 0), 0),
    pipelineRevenue: jobs.filter(j => !['completed','cancelled'].includes(j.stage)).reduce((s, j) => s + (j.total || 0), 0),
    avgJobValue:     completed.length > 0 ? completed.reduce((s, j) => s + (j.total || 0), 0) / completed.length : 0,
  };
}

export async function runReminderSweep() {
  console.log('[Finance] Running reminder sweep...');
  const status    = await checkActiveRentals();
  const reminders = readJSON(DATA.reminders);
  const results   = { sent48h: [], sent24h: [], overdue: [], errors: [] };

  for (const job of status.endingIn48h) {
    if (reminders.find(r => r.jobId === job.jobId && r.type === '48h_reminder')) continue;
    try { await send48hReminder(job.jobId); results.sent48h.push(job.jobId); }
    catch (e) { results.errors.push({ jobId: job.jobId, error: e.message }); }
  }
  for (const job of status.endingIn24h) {
    if (reminders.find(r => r.jobId === job.jobId && r.type === '24h_alert')) continue;
    try { await send24hAlert(job.jobId); results.sent24h.push(job.jobId); }
    catch (e) { results.errors.push({ jobId: job.jobId, error: e.message }); }
  }
  if (status.overdue.length > 0) {
    await sendSMS(CONFIG.BRAND.PHONE,
      `🚨 OVERDUE RENTALS:\n${status.overdue.map(j => `${j.jobId} | ${j.customerName} | ${j.endDate}`).join('\n')}`,
      { name: 'Andrei - Gorilla Rental' }
    );
    results.overdue = status.overdue.map(j => j.jobId);
  }

  console.log(`[Finance] Sweep done: ${results.sent48h.length} 48h, ${results.sent24h.length} 24h`);
  return { ...results, status };
}

export async function financeChat(message, history = []) {
  const status      = await checkActiveRentals();
  const monthReport = await getRevenueReport('month');
  const systemPrompt = `You are the Finance Agent for Gorilla Rental. SMS via GHL.
ACTIVE: ${status.total} | 48h: ${status.endingIn48h.map(j=>j.jobId).join(',')||'none'} | 24h: ${status.endingIn24h.map(j=>j.jobId).join(',')||'none'} | Overdue: ${status.overdue.map(j=>j.jobId).join(',')||'none'}
MONTH: Jobs:${monthReport.totalJobs} | Closed:$${monthReport.totalRevenue.toFixed(2)} | Active:$${monthReport.activeRevenue.toFixed(2)} | Pipeline:$${monthReport.pipelineRevenue.toFixed(2)} | Avg:$${monthReport.avgJobValue.toFixed(2)}
ACTIONS:
{"action":"reminder_sweep"}
{"action":"send_48h","jobId":"GR-2026-XXXX"}
{"action":"send_24h","jobId":"GR-2026-XXXX"}
{"action":"extend","jobId":"GR-2026-XXXX","newEndDate":"YYYY-MM-DD"}
{"action":"revenue_report","period":"month|week|year"}
{"action":"check_rentals"}`;
  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, system: systemPrompt, messages });
  const text     = response.content[0].text;
  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched); let result = null;
      if (action.action === 'reminder_sweep')    result = await runReminderSweep();
      else if (action.action === 'send_48h')     result = await send48hReminder(action.jobId);
      else if (action.action === 'send_24h')     result = await send24hAlert(action.jobId);
      else if (action.action === 'extend')       result = await processExtension(action.jobId, action.newEndDate);
      else if (action.action === 'revenue_report') result = await getRevenueReport(action.period || 'month');
      else if (action.action === 'check_rentals')  result = await checkActiveRentals();
      return { text, action, result };
    } catch (e) { return { text, error: e.message }; }
  }
  return { text };
}

export function financeRoutes(app) {
  app.post('/finance/chat',       async (req, res) => { try { res.json({ ok: true, ...await financeChat(req.body.message, req.body.history || []) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/finance/sweep',      async (req, res) => { try { res.json({ ok: true, ...await runReminderSweep() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/finance/active',      async (req, res) => { try { res.json({ ok: true, ...await checkActiveRentals() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/finance/remind/48h', async (req, res) => { try { res.json({ ok: true, ...await send48hReminder(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/finance/extend',     async (req, res) => { try { res.json({ ok: true, ...await processExtension(req.body.jobId, req.body.newEndDate) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/finance/report',      async (req, res) => { try { res.json({ ok: true, report: await getRevenueReport(req.query.period || 'month') }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  console.log('[Finance] ✅ Routes registered');
}
