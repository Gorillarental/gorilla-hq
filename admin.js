// ============================================================
// ADMIN AGENT — Gorilla Rental AI
// Reservations, contracts, invoices, payment tracking
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, PRICING } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { generateQuotePDF } from './quote-pdf.js';

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
  reservations: path.join(__dirname, 'data/reservations.json'),
  contracts:    path.join(__dirname, 'data/contracts.json'),
  invoices:     path.join(__dirname, 'data/invoices.json'),
  pipeline:     path.join(__dirname, 'data/pipeline.json'),
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

async function createStripePaymentLink(amount, metadata = {}) {
  const res = await fetch('https://api.stripe.com/v1/payment_links', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.STRIPE_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'line_items[0][price_data][currency]':                   'usd',
      'line_items[0][price_data][product_data][name]':         metadata.description || 'Gorilla Rental Payment',
      'line_items[0][price_data][unit_amount]':                String(Math.round(amount * 100)),
      'line_items[0][quantity]':                               '1',
      'metadata[job_id]':                                      metadata.jobId || '',
      'metadata[type]':                                        metadata.type  || 'payment',
      'after_completion[type]':                                'hosted_confirmation',
      'after_completion[hosted_confirmation][custom_message]': 'Thank you! Gorilla Rental will be in touch shortly.',
    }),
  });
  if (!res.ok) throw new Error(`Stripe: ${await res.text()}`);
  return (await res.json()).url;
}

async function generateContractHTML(res) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows  = (res.equipment || []).map(e =>
    `<tr><td>${e.name}</td><td>${e.quantity}</td><td>${res.startDate}</td><td>${res.endDate}</td><td>$${(e.total||0).toFixed(2)}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{font-family:Arial,sans-serif;margin:0;padding:40px;color:#222;font-size:14px}
  .header{display:flex;justify-content:space-between;align-items:center;border-bottom:4px solid #f6ec0e;padding-bottom:20px;margin-bottom:30px}
  .logo{background:#222;color:#f6ec0e;font-size:22px;font-weight:bold;padding:8px 16px;border-radius:6px}
  h2{font-size:15px;border-bottom:2px solid #f6ec0e;padding-bottom:6px;margin:24px 0 12px}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th{background:#222;color:#f6ec0e;padding:10px;text-align:left;font-size:13px}
  td{padding:10px;border-bottom:1px solid #eee;font-size:13px}
  .total-row td{font-weight:bold;background:#fafafa}
  .terms p{font-size:12px;color:#555;margin:8px 0;line-height:1.6}
  .sig{display:flex;gap:60px;margin-top:60px}
  .sig-line{flex:1;border-top:1px solid #222;padding-top:8px;font-size:12px;color:#555}
  .footer{text-align:center;margin-top:40px;font-size:12px;color:#999;border-top:2px solid #f6ec0e;padding-top:16px}
</style></head><body>
<div class="header">
  <div class="logo">🦍 GORILLA RENTAL</div>
  <div style="text-align:right">
    <div style="font-size:20px;font-weight:bold">RENTAL CONTRACT</div>
    <div style="font-size:13px;color:#666">Job ID: ${res.jobId}</div>
    <div style="font-size:13px;color:#666">Date: ${today}</div>
  </div>
</div>
<h2>Customer Information</h2>
<table><tr><td><b>Name:</b> ${res.customerName}</td><td><b>Email:</b> ${res.customerEmail}</td></tr>
<tr><td><b>Phone:</b> ${res.customerPhone}</td><td><b>Address:</b> ${res.deliveryAddress||'TBD'}</td></tr></table>
<h2>Equipment & Rental Period</h2>
<table><thead><tr><th>Equipment</th><th>Qty</th><th>Start</th><th>End</th><th>Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>
  <tr class="total-row"><td colspan="4">Delivery Fee</td><td>$200.00</td></tr>
  <tr class="total-row"><td colspan="4">Subtotal</td><td>$${res.subtotal.toFixed(2)}</td></tr>
  <tr class="total-row"><td colspan="4">Tax (7%)</td><td>$${res.tax.toFixed(2)}</td></tr>
  <tr class="total-row"><td colspan="4"><b>TOTAL</b></td><td><b>$${res.total.toFixed(2)}</b></td></tr>
  <tr class="total-row"><td colspan="4">Deposit Paid</td><td>-$${res.depositPaid.toFixed(2)}</td></tr>
  <tr class="total-row"><td colspan="4"><b>Balance Due on Delivery</b></td><td><b>$${res.balanceDue.toFixed(2)}</b></td></tr>
</tfoot></table>
<div class="terms">
<h2>Terms & Conditions</h2>
<p><b>1. PAYMENT:</b> Deposit of $${res.depositPaid.toFixed(2)} required to confirm. Balance of $${res.balanceDue.toFixed(2)} due on delivery.</p>
<p><b>2. CANCELLATION:</b> Cancellations less than 48 hours before start date are non-refundable.</p>
<p><b>3. DAMAGE:</b> Customer is responsible for all damage, theft, or misuse during rental period.</p>
<p><b>4. EXTENSIONS:</b> Must be requested 24 hours before return date. Subject to availability.</p>
<p><b>5. OPERATORS:</b> Customer must ensure only trained operators use the equipment.</p>
<p><b>6. DELIVERY:</b> $200 delivery fee applies. Customer must ensure safe site access.</p>
<p><b>7. GOVERNING LAW:</b> This agreement is governed by the laws of the State of Florida.</p>
</div>
<div class="sig">
  <div class="sig-line">Customer Signature<br><br><br>Date: _______________</div>
  <div class="sig-line">Gorilla Rental Representative<br><br><br>Date: _______________</div>
</div>
<div class="footer">Gorilla Rental · ${CONFIG.BRAND.PHONE} · ${CONFIG.BRAND.EMAIL} · ${CONFIG.BRAND.WEBSITE}</div>
</body></html>`;
}

export async function createReservation(jobId) {
  const pipeline = readJSON(DATA.pipeline);
  const job      = pipeline.find(j => j.jobId === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const balanceDue  = job.total - PRICING.DEPOSIT;
  const balanceLink = await createStripePaymentLink(balanceDue, {
    jobId, type: 'balance', description: `Balance Due — ${jobId} — Gorilla Rental`,
  });

  const reservations = readJSON(DATA.reservations);
  const reservation  = {
    jobId,
    customerName:    job.customerName,
    customerEmail:   job.customerEmail,
    customerPhone:   job.customerPhone,
    deliveryAddress: job.deliveryAddress || '',
    equipment:       job.equipment || [],
    startDate:       job.startDate,
    endDate:         job.endDate,
    subtotal:        job.subtotal || 0,
    tax:             job.tax      || 0,
    total:           job.total,
    depositPaid:     PRICING.DEPOSIT,
    balanceDue,
    depositLink:     job.depositLink,
    balanceLink,
    booqableOrderId: job.booqableOrderId,
    status:          'reserved',
    createdAt:       new Date().toISOString(),
  };
  reservations.push(reservation);
  writeJSON(DATA.reservations, reservations);

  const idx = pipeline.findIndex(j => j.jobId === jobId);
  pipeline[idx].stage       = 'reserved';
  pipeline[idx].balanceLink = balanceLink;
  pipeline[idx].reservedAt  = new Date().toISOString();
  writeJSON(DATA.pipeline, pipeline);

  console.log(`[Admin] ✅ Reservation created: ${jobId}`);
  return { reservation, balanceLink };
}

export async function sendReservationConfirmation(jobId) {
  const res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) throw new Error(`Reservation ${jobId} not found`);

  await sendEmailWithPDF({
    to:      res.customerEmail,
    subject: `Reservation Confirmed — ${jobId} — Gorilla Rental`,
    body: `
Dear ${res.customerName},

Your reservation is confirmed!

📋 JOB ID: ${res.jobId}
📅 RENTAL: ${res.startDate} → ${res.endDate}

EQUIPMENT:
${(res.equipment||[]).map(e=>`  • ${e.name} (${e.quantity}x) — $${(e.total||0).toFixed(2)}`).join('\n')}

💰 TOTAL: $${res.total.toFixed(2)}
   Deposit Paid: $${res.depositPaid.toFixed(2)}
   Balance Due:  $${res.balanceDue.toFixed(2)}

👇 PAY BALANCE: ${res.balanceLink}

We'll contact you 24 hours before delivery to confirm site details.

— Gorilla Rental Team
${CONFIG.BRAND.PHONE} | ${CONFIG.BRAND.EMAIL}
    `,
    attachments: [],
  });

  console.log(`[Admin] ✅ Confirmation sent: ${jobId}`);
  return { ok: true };
}

export async function createContract(jobId) {
  const res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) throw new Error(`Reservation ${jobId} not found`);

  const html = await generateContractHTML(res);
  const pdf  = await generateQuotePDF(html);

  await sendEmailWithPDF({
    to:        res.customerEmail,
    subject:   `Rental Contract — ${jobId} — Gorilla Rental`,
    body: `
Dear ${res.customerName},

Please find your rental contract attached for Job ID: ${res.jobId}.

Please review, sign, and return by replying to this email with a signed scan.

💰 BALANCE DUE ON DELIVERY: $${res.balanceDue.toFixed(2)}
👇 PAY NOW: ${res.balanceLink}

— Gorilla Rental Team
${CONFIG.BRAND.PHONE} | ${CONFIG.BRAND.EMAIL}
    `,
    pdfBuffer: pdf,
    pdfName:   `Gorilla-Rental-Contract-${jobId}.pdf`,
  });

  const contracts = readJSON(DATA.contracts);
  contracts.push({ jobId, customerEmail: res.customerEmail, status: 'sent', createdAt: new Date().toISOString() });
  writeJSON(DATA.contracts, contracts);

  const pipeline = readJSON(DATA.pipeline);
  const idx      = pipeline.findIndex(j => j.jobId === jobId);
  if (idx >= 0) { pipeline[idx].stage = 'contract_sent'; writeJSON(DATA.pipeline, pipeline); }

  console.log(`[Admin] ✅ Contract sent: ${jobId}`);
  return { ok: true };
}

export async function createInvoice(jobId, type = 'final') {
  const res = readJSON(DATA.reservations).find(r => r.jobId === jobId);
  if (!res) throw new Error(`Reservation ${jobId} not found`);

  const invoice = {
    invoiceNumber: `INV-${jobId}-${type.toUpperCase()}`,
    jobId, type,
    customerName:  res.customerName,
    customerEmail: res.customerEmail,
    total:         res.total,
    depositPaid:   res.depositPaid,
    balanceDue:    type === 'final' ? 0 : res.balanceDue,
    status:        type === 'final' ? 'paid' : 'pending',
    issuedDate:    new Date().toISOString().split('T')[0],
    createdAt:     new Date().toISOString(),
  };

  const invoices = readJSON(DATA.invoices);
  invoices.push(invoice);
  writeJSON(DATA.invoices, invoices);

  if (type === 'final') {
    const pipeline = readJSON(DATA.pipeline);
    const idx      = pipeline.findIndex(j => j.jobId === jobId);
    if (idx >= 0) { pipeline[idx].stage = 'completed'; pipeline[idx].completedAt = new Date().toISOString(); writeJSON(DATA.pipeline, pipeline); }
  }

  console.log(`[Admin] ✅ Invoice created: INV-${jobId}-${type.toUpperCase()}`);
  return invoice;
}

export async function getReservationStatus(jobId) {
  return {
    job:          readJSON(DATA.pipeline).find(j => j.jobId === jobId),
    reservation:  readJSON(DATA.reservations).find(r => r.jobId === jobId),
    contract:     readJSON(DATA.contracts).find(c => c.jobId === jobId),
    invoices:     readJSON(DATA.invoices).filter(i => i.jobId === jobId),
  };
}

export async function adminChat(message, history = []) {
  const pipeline     = readJSON(DATA.pipeline);
  const reservations = readJSON(DATA.reservations);

  const systemPrompt = `You are the Admin Agent for Gorilla Rental.
PIPELINE: ${pipeline.length} jobs | Reserved: ${pipeline.filter(j=>j.stage==='reserved').length} | Contract sent: ${pipeline.filter(j=>j.stage==='contract_sent').length} | In progress: ${pipeline.filter(j=>j.stage==='in_progress').length} | Completed: ${pipeline.filter(j=>j.stage==='completed').length}
RECENT: ${pipeline.slice(-5).map(j=>`${j.jobId}|${j.customerName}|${j.stage}|$${j.total?.toFixed(2)||'?'}`).join(' | ')}
ACTIONS:
{"action":"create_reservation","jobId":"GR-2026-XXXX"}
{"action":"send_confirmation","jobId":"GR-2026-XXXX"}
{"action":"send_contract","jobId":"GR-2026-XXXX"}
{"action":"create_invoice","jobId":"GR-2026-XXXX","type":"final"}
{"action":"get_status","jobId":"GR-2026-XXXX"}`;

  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, system: systemPrompt, messages });
  const text     = response.content[0].text;

  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched); let result = null;
      if (action.action === 'create_reservation')  result = await createReservation(action.jobId);
      else if (action.action === 'send_confirmation') result = await sendReservationConfirmation(action.jobId);
      else if (action.action === 'send_contract')   result = await createContract(action.jobId);
      else if (action.action === 'create_invoice')  result = await createInvoice(action.jobId, action.type || 'final');
      else if (action.action === 'get_status')      result = await getReservationStatus(action.jobId);
      return { text, action, result };
    } catch (e) { return { text, error: e.message }; }
  }
  return { text };
}

export function adminRoutes(app) {
  app.post('/admin/chat',                async (req, res) => { try { res.json({ ok: true, ...await adminChat(req.body.message, req.body.history || []) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/reservation',         async (req, res) => { try { res.json({ ok: true, ...await createReservation(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/reservation/confirm', async (req, res) => { try { res.json({ ok: true, ...await sendReservationConfirmation(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/contract',            async (req, res) => { try { res.json({ ok: true, ...await createContract(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/invoice',             async (req, res) => { try { res.json({ ok: true, invoice: await createInvoice(req.body.jobId, req.body.type || 'final') }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/admin/status/:jobId',        async (req, res) => { try { res.json({ ok: true, ...await getReservationStatus(req.params.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/admin/reservations',         async (req, res) => { try { res.json({ ok: true, reservations: readJSON(DATA.reservations) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  console.log('[Admin] ✅ Routes registered');
}
