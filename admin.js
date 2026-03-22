// ============================================================
// ADMIN AGENT — Gorilla Rental AI
// Reservations, contracts, invoices, payment tracking,
// SharePoint cashflow, receipt management, WhatsApp approvals,
// payment flows, morning briefing, monthly reports
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import { logActivity, createTask } from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, PRICING } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { generateQuotePDF } from './quote-pdf.js';
import { getPipeline, upsertJob, updateJob, getJob, dbAddCashflow, dbGetCashflow, dbGetCashflowSummary } from './db.js';
import { readCashflow as spReadCashflow, addCashflowEntry as spAddCashflowEntry, uploadReceipt, listReceipts, getCashflowSummary as spGetCashflowSummary } from './sharepoint.js';

// ─── Cashflow helpers (DB-backed, SharePoint optional) ─────
async function readCashflow() {
  // DB is source of truth; SharePoint is a bonus sync
  return dbGetCashflow();
}

async function addCashflowEntry(entry) {
  // Always write to DB first
  await dbAddCashflow(entry);
  // Also try SharePoint (ignore failure)
  try { await spAddCashflowEntry(entry); } catch { /* SharePoint unavailable */ }
}

async function getCashflowSummary(month) {
  return dbGetCashflowSummary(month);
}
import { requestApproval, notifyAndrei, grantApproval, denyApproval, listPendingApprovals } from './whatsapp.js';
import { sendSMS } from './ghl.js';

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
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// ─── Stripe ────────────────────────────────────────────────

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

// ─── Contract HTML ─────────────────────────────────────────

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
  <div class="logo">GORILLA RENTAL</div>
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

// ─── Pipeline helpers ──────────────────────────────────────

export async function getJobById(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  return job;
}

export async function getAllJobs() {
  return getPipeline();
}

export async function getOverdueRentals() {
  const pipeline = await getPipeline();
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  return pipeline.filter(j => {
    if (j.stage === 'completed' || j.stage === 'cancelled') return false;
    if (!j.endDate) return false;
    const end = new Date(j.endDate);
    return end < today;
  });
}

export async function getTodayDeliveries() {
  const pipeline = await getPipeline();
  const today    = new Date().toISOString().slice(0, 10);
  return pipeline.filter(j => j.startDate === today || j.deliveryDate === today);
}

export async function getTodayPickups() {
  const pipeline = await getPipeline();
  const today    = new Date().toISOString().slice(0, 10);
  return pipeline.filter(j => j.endDate === today || j.pickupDate === today);
}

export async function getPendingPayments() {
  const pipeline = await getPipeline();
  const payments = [];
  for (const j of pipeline) {
    if (j.stage === 'completed' || j.stage === 'cancelled') continue;
    if (j.depositLink && !j.depositPaid) {
      payments.push({ ...j, paymentType: 'deposit', amount: PRICING.DEPOSIT });
    }
    if (j.balanceLink && j.depositPaid && !j.balancePaid) {
      payments.push({ ...j, paymentType: 'balance', amount: (j.total || 0) - (j.depositPaid || 0) });
    }
  }
  return payments;
}

// ─── Original reservation/contract/invoice functions ───────

export async function createReservation(jobId) {
  const job = await getJob(jobId);
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

  await updateJob(jobId, { stage: 'reserved', balanceLink, reservedAt: new Date().toISOString() });

  await logActivity({ agent: 'admin', action: 'reservation_created', description: `Reservation created for ${jobId}`, jobId, status: 'success', notify: true }).catch(()=>{});

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

Job ID: ${res.jobId}
Rental: ${res.startDate} to ${res.endDate}

EQUIPMENT:
${(res.equipment||[]).map(e=>`  - ${e.name} (${e.quantity}x) — $${(e.total||0).toFixed(2)}`).join('\n')}

TOTAL: $${res.total.toFixed(2)}
  Deposit Paid: $${res.depositPaid.toFixed(2)}
  Balance Due:  $${res.balanceDue.toFixed(2)}

PAY BALANCE: ${res.balanceLink}

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

BALANCE DUE ON DELIVERY: $${res.balanceDue.toFixed(2)}
PAY NOW: ${res.balanceLink}

— Gorilla Rental Team
${CONFIG.BRAND.PHONE} | ${CONFIG.BRAND.EMAIL}
    `,
    pdfBuffer: pdf,
    pdfName:   `Gorilla-Rental-Contract-${jobId}.pdf`,
  });

  const contracts = readJSON(DATA.contracts);
  contracts.push({ jobId, customerEmail: res.customerEmail, status: 'sent', createdAt: new Date().toISOString() });
  writeJSON(DATA.contracts, contracts);

  await updateJob(jobId, { stage: 'contract_sent' });

  await logActivity({ agent: 'admin', action: 'contract_sent', description: `Contract sent for ${jobId}`, jobId, status: 'success', notify: true }).catch(()=>{});

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
    await updateJob(jobId, { stage: 'completed', completedAt: new Date().toISOString() });
  }

  console.log(`[Admin] ✅ Invoice created: INV-${jobId}-${type.toUpperCase()}`);
  return invoice;
}

export async function getReservationStatus(jobId) {
  return {
    job:          await getJob(jobId),
    reservation:  readJSON(DATA.reservations).find(r => r.jobId === jobId),
    contract:     readJSON(DATA.contracts).find(c => c.jobId === jobId),
    invoices:     readJSON(DATA.invoices).filter(i => i.jobId === jobId),
  };
}

// ─── 6A — SharePoint Cashflow ──────────────────────────────

export async function recordPaymentInCashflow(jobId, amount, type, description, category) {
  const entry = {
    date:        new Date().toISOString().slice(0, 10),
    description,
    category,
    amount,
    type,   // 'income' or 'expense'
    jobId,
    receipt: null,
  };
  await addCashflowEntry(entry);
  return entry;
}

export async function getCashflowReport(month) {
  // month = "2026-03"
  return getCashflowSummary(month);
}

// ─── 6B — Receipt Management ───────────────────────────────

export async function processReceipt(fileBuffer, fileName, mimeType, metadata = {}) {
  try {
    // 1. Upload to SharePoint RECEIPTS folder
    const { webUrl } = await uploadReceipt(fileBuffer, fileName, mimeType);

    // 2. If image, use Claude vision to extract: amount, vendor, date, category
    let extracted = {
      amount:   metadata.amount,
      vendor:   metadata.vendor,
      date:     metadata.date,
      category: metadata.category || 'Expense',
    };

    if (mimeType.startsWith('image/')) {
      try {
        const base64 = fileBuffer.toString('base64');
        const response = await client.messages.create({
          model:      'claude-opus-4-6',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type:       'base64',
                  media_type: mimeType,
                  data:       base64,
                },
              },
              {
                type: 'text',
                text: 'Extract from this receipt: total amount (number only), vendor name, date (YYYY-MM-DD format), category (fuel/repairs/supplies/equipment/other). Respond as JSON: {"amount": 0, "vendor": "", "date": "", "category": ""}',
              },
            ],
          }],
        });

        const visionText = response.content[0].text;
        const jsonMatch  = visionText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          extracted = {
            amount:   parsed.amount   || extracted.amount,
            vendor:   parsed.vendor   || extracted.vendor,
            date:     parsed.date     || extracted.date,
            category: parsed.category || extracted.category,
          };
        }
      } catch (visionErr) {
        console.error('[Admin] Receipt vision extraction failed:', visionErr.message);
      }
    }

    // 3. Add to cashflow
    await addCashflowEntry({
      date:        extracted.date || new Date().toISOString().slice(0, 10),
      description: `Receipt: ${extracted.vendor || fileName}`,
      category:    extracted.category || 'Expense',
      amount:      extracted.amount || 0,
      type:        'expense',
      jobId:       metadata.jobId || null,
      receipt:     webUrl,
    });

    console.log(`[Admin] ✅ Receipt processed: ${fileName}`);
    return { receiptUrl: webUrl, extracted };
  } catch (err) {
    console.error('[Admin] processReceipt error:', err.message);
    throw err;
  }
}

// ─── 6C — Stripe Payment Links with WhatsApp Approval ─────

export async function requestDepositApproval(jobId) {
  const job           = await getJobById(jobId);
  const approvalId    = `APR-DEP-${jobId}-${Date.now()}`;
  const depositAmount = job.depositAmount || PRICING.DEPOSIT || 150;

  const message = `PAYMENT APPROVAL NEEDED
Job: ${job.jobId || job.id}
Customer: ${job.customerName}
Equipment: ${job.equipment?.map(e => e.name).join(', ') || 'N/A'}
Deposit Amount: $${depositAmount}

Reply YES to send deposit link to customer
Reply NO to cancel

Approval ID: ${approvalId}`;

  await requestApproval(approvalId, message, { type: 'deposit', jobId, amount: depositAmount });
  return approvalId;
}

export async function requestBalanceApproval(jobId) {
  const job        = await getJobById(jobId);
  const total      = job.total || 0;
  const deposit    = job.depositPaid || PRICING.DEPOSIT || 0;
  const balance    = total - deposit;
  const approvalId = `APR-BAL-${jobId}-${Date.now()}`;

  const deliveryTime = job.deliveryTime || job.scheduledTime || 'TBD';
  const message = `BALANCE PAYMENT APPROVAL
Job: ${job.jobId || job.id}
Customer: ${job.customerName}
Phone: ${job.customerPhone || 'N/A'}
Delivery TODAY at ${deliveryTime}

Equipment: ${job.equipment?.map(e => e.name).join(', ') || 'N/A'}
Total: $${total.toFixed(2)}
Deposit Paid: $${deposit.toFixed(2)}
BALANCE DUE: $${balance.toFixed(2)}

Reply YES to send payment link to customer
Reply NO to hold

Approval ID: ${approvalId}`;

  await requestApproval(approvalId, message, { type: 'balance', jobId, amount: balance });
  return approvalId;
}

export async function sendPaymentLink(jobId, type) {
  // type = 'deposit' | 'balance'
  try {
    const job = await getJobById(jobId);
    let amount, description;

    if (type === 'deposit') {
      amount      = job.depositAmount || PRICING.DEPOSIT || 150;
      description = `Deposit — ${jobId} — Gorilla Rental`;
    } else {
      const total   = job.total || 0;
      const deposit = job.depositPaid || PRICING.DEPOSIT || 0;
      amount        = total - deposit;
      description   = `Balance Due — ${jobId} — Gorilla Rental`;
    }

    const paymentLink = await createStripePaymentLink(amount, { jobId, type, description });

    // Send to customer via email + SMS
    if (job.customerEmail) {
      await sendEmailWithPDF({
        to:      job.customerEmail,
        subject: `${type === 'deposit' ? 'Deposit' : 'Balance'} Payment — ${jobId} — Gorilla Rental`,
        body:    `Dear ${job.customerName},\n\nPlease click the link below to complete your ${type} payment of $${amount.toFixed(2)}:\n\n${paymentLink}\n\n— Gorilla Rental Team`,
      }).catch(err => console.error('[Admin] Email failed:', err.message));
    }

    if (job.customerPhone) {
      await sendSMS(job.customerPhone, `Gorilla Rental: Please complete your ${type} payment of $${amount.toFixed(2)} here: ${paymentLink}`)
        .catch(err => console.error('[Admin] SMS failed:', err.message));
    }

    // Record in cashflow as pending
    await addCashflowEntry({
      date:        new Date().toISOString().slice(0, 10),
      description: `${type === 'deposit' ? 'Deposit' : 'Balance'} payment link sent — ${jobId}`,
      category:    'Rental Income',
      amount,
      type:        'income',
      jobId,
      receipt:     null,
    }).catch(err => console.error('[Admin] Cashflow record failed:', err.message));

    // Log in pipeline
    const updateKey = type === 'deposit' ? 'depositLink' : 'balanceLink';
    await updateJob(jobId, { [updateKey]: paymentLink });

    console.log(`[Admin] ✅ Payment link sent: ${type} for ${jobId}`);
    return { paymentLink, amount };
  } catch (err) {
    console.error('[Admin] sendPaymentLink error:', err.message);
    throw err;
  }
}

// ─── 6D — Late Rental Check ────────────────────────────────

export async function checkLateRentals() {
  try {
    const overdue = await getOverdueRentals();
    for (const job of overdue) {
      const daysLate   = Math.floor((Date.now() - new Date(job.endDate)) / 86400000);
      const rentalDays = job.rentalDays || Math.ceil((new Date(job.endDate) - new Date(job.startDate)) / 86400000) || 7;
      const dailyRate  = ((job.total || 0) / rentalDays).toFixed(2);
      const approvalId = `APR-LATE-${job.jobId || job.id}-${Date.now()}`;
      const message    = `LATE RENTAL ALERT
Job: ${job.jobId || job.id}
Customer: ${job.customerName}
Was due: ${job.endDate}
Days late: ${daysLate}

Reply YES to create extension invoice ($${dailyRate}/day)
Reply NO to skip for now

Approval ID: ${approvalId}`;
      await requestApproval(approvalId, message, { type: 'late_rental', jobId: job.jobId || job.id, daysLate, dailyRate });
    }
    console.log(`[Admin] Late rental check: ${overdue.length} overdue`);
    return overdue.length;
  } catch (err) {
    console.error('[Admin] checkLateRentals error:', err.message);
    return 0;
  }
}

// ─── 6E — Post-Rental Check ───────────────────────────────

export async function postRentalCheck(jobId) {
  try {
    const job        = await getJobById(jobId);
    const approvalId = `APR-POST-${jobId}-${Date.now()}`;
    const message    = `RENTAL COMPLETE — ${job.jobId || job.id}
Customer: ${job.customerName} returned equipment today.

Any extra charges to invoice?
- Damage? Reply DAMAGE [amount]
- Extra days? Reply DAYS [number]
- Other? Reply OTHER [description] [amount]
- Nothing extra? Reply CLEAR

Approval ID: ${approvalId}`;
    await requestApproval(approvalId, message, { type: 'post_rental', jobId });
    return approvalId;
  } catch (err) {
    console.error('[Admin] postRentalCheck error:', err.message);
    throw err;
  }
}

// ─── 6F — Email helper ────────────────────────────────────

async function sendBriefingEmail(body, dateKey, subject = null) {
  const emailSubject = subject || `Gorilla Rental — Morning Briefing — ${dateKey}`;
  const recipients   = ['info@gorillarental.us', 'jeff@grouplandev.com'];
  for (const to of recipients) {
    try {
      await sendEmailWithPDF({ to, subject: emailSubject, body });
    } catch (err) {
      console.error(`[Admin] Briefing email failed → ${to}: ${err.message}`);
    }
  }
}

// ─── 6F — Morning Briefing ────────────────────────────────

export async function sendMorningBriefing() {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const monthKey = today.slice(0, 7);

    const [deliveries, pickups, overdue, pendingPayments, monthSummary] = await Promise.all([
      getTodayDeliveries().catch(() => []),
      getTodayPickups().catch(() => []),
      getOverdueRentals().catch(() => []),
      getPendingPayments().catch(() => []),
      getCashflowSummary(monthKey).catch(() => ({ income: 0, expenses: 0, net: 0 })),
    ]);

    const deliveryLines  = deliveries.map(j => `  - ${j.deliveryTime || j.scheduledTime || 'TBD'} | ${j.jobId} | ${j.customerName} | ${j.deliveryAddress || 'N/A'}`).join('\n') || '  None';
    const pickupLines    = pickups.map(j => `  - ${j.pickupTime || j.scheduledTime || 'TBD'} | ${j.jobId} | ${j.customerName} | ${j.deliveryAddress || 'N/A'}`).join('\n') || '  None';
    const overdueLines   = overdue.map(j => {
      const days = Math.floor((Date.now() - new Date(j.endDate)) / 86400000);
      return `  - ${j.jobId} | ${j.customerName} | ${days} days late`;
    }).join('\n') || '  None';
    const paymentsToCollect = pendingPayments.map(j => `  - ${j.jobId} | ${j.customerName} | ${j.paymentType} $${j.amount}`).join('\n') || '  None';

    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const briefing = `GORILLA RENTAL — MORNING BRIEFING
${dayName}

PAYMENTS TO COLLECT TODAY:
${paymentsToCollect}

TODAY'S DELIVERIES (${deliveries.length}):
${deliveryLines}

TODAY'S PICKUPS (${pickups.length}):
${pickupLines}

OVERDUE RENTALS: ${overdue.length}
${overdueLines}

THIS MONTH SO FAR:
  Revenue: $${(monthSummary.income || 0).toLocaleString()}
  Expenses: $${(monthSummary.expenses || 0).toLocaleString()}
  Net: $${(monthSummary.net || 0).toLocaleString()}`;

    let ghlBriefing = '';
    try {
      const { generateGHLBriefing } = await import('./ghl.js');
      ghlBriefing = await generateGHLBriefing();
    } catch (e) {
      ghlBriefing = 'GHL data unavailable';
    }

    const fullBriefing = briefing + '\n\n' + ghlBriefing;

    await notifyAndrei(fullBriefing).catch(e => console.error('[Admin] WhatsApp briefing failed:', e.message));
    await sendBriefingEmail(fullBriefing, today);

    console.log('[Admin] ✅ Morning briefing sent');
    return fullBriefing;
  } catch (err) {
    console.error('[Admin] sendMorningBriefing error:', err.message);
    throw err;
  }
}

// ─── 6G — Monthly Report ──────────────────────────────────

async function callClaude(prompt) {
  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });
  return response.content[0].text;
}

export async function sendMonthlyReport() {
  try {
    const now       = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthKey  = prevMonth.toISOString().slice(0, 7); // "2026-02"
    const monthName = prevMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const [summary, allJobs] = await Promise.all([
      getCashflowSummary(monthKey).catch(() => ({ income: 0, expenses: 0, net: 0, byCategory: {} })),
      getAllJobs().catch(() => []),
    ]);

    const prompt = `Generate a monthly business report for Gorilla Rental (boom lift/scissor lift rentals, South Florida) for ${monthName}.

Data:
- Total Revenue: $${summary.income}
- Total Expenses: $${summary.expenses}
- Net Profit: $${summary.net}
- Revenue by category: ${JSON.stringify(summary.byCategory)}
- Jobs completed: ${allJobs.filter(j => j.stage === 'completed').length}
- Jobs in pipeline: ${allJobs.filter(j => j.stage !== 'completed').length}

Write a concise report with:
1. Executive summary (2-3 sentences)
2. Revenue breakdown
3. Top observations
4. 3 specific actionable recommendations for next month

Keep it under 500 words, professional but readable via WhatsApp.`;

    const report     = await callClaude(prompt);
    const fullReport = `GORILLA RENTAL — MONTHLY REPORT\n${monthName}\n\n${report}`;

    await notifyAndrei(fullReport).catch(e => console.error('[Admin] WhatsApp monthly report failed:', e.message));
    await sendBriefingEmail(fullReport, monthKey, `Gorilla Rental Monthly Report — ${monthName}`);

    console.log('[Admin] ✅ Monthly report sent');
    return fullReport;
  } catch (err) {
    console.error('[Admin] sendMonthlyReport error:', err.message);
    throw err;
  }
}

// ─── 6H — Admin Chat ──────────────────────────────────────

export async function adminChat(message, history = []) {
  const pipeline     = await getPipeline();
  const reservations = readJSON(DATA.reservations);
  const msg          = message.toLowerCase().trim();

  // ── Direct command handling ──────────────────────────────
  try {
    // "show cashflow" / "cashflow this month"
    if (/cashflow/.test(msg)) {
      const monthKey = new Date().toISOString().slice(0, 7);
      const summary  = await getCashflowReport(monthKey);
      return { text: `Cashflow for ${monthKey}:\nIncome: $${summary.income}\nExpenses: $${summary.expenses}\nNet: $${summary.net}`, summary };
    }

    // "add expense [amount] [description]"
    const addExpenseMatch = msg.match(/^add expense\s+\$?([\d.]+)\s+(.+)$/);
    if (addExpenseMatch) {
      const amount      = parseFloat(addExpenseMatch[1]);
      const description = addExpenseMatch[2];
      await addCashflowEntry({
        date: new Date().toISOString().slice(0, 10),
        description, category: 'Expense', amount, type: 'expense', jobId: null, receipt: null,
      });
      return { text: `Expense recorded: $${amount} — ${description}` };
    }

    // "approve payment [jobId]"
    const approvePayMatch = msg.match(/approve payment\s+(\S+)/);
    if (approvePayMatch) {
      const approvalId = await requestDepositApproval(approvePayMatch[1]);
      return { text: `Deposit approval requested: ${approvalId}` };
    }

    // "send deposit link [jobId]"
    const depositLinkMatch = msg.match(/send deposit link\s+(\S+)/);
    if (depositLinkMatch) {
      const result = await sendPaymentLink(depositLinkMatch[1], 'deposit');
      return { text: `Deposit link sent: ${result.paymentLink}`, ...result };
    }

    // "send balance link [jobId]"
    const balanceLinkMatch = msg.match(/send balance link\s+(\S+)/);
    if (balanceLinkMatch) {
      const result = await sendPaymentLink(balanceLinkMatch[1], 'balance');
      return { text: `Balance link sent: ${result.paymentLink}`, ...result };
    }

    // "stripe link $300" / "payment link $300" / "create a $300 link" / "$300 payment link"
    const quickLinkMatch = msg.match(/(?:stripe|payment)\s+link[^\d]*\$?([\d,.]+)|(?:create|generate|send|give)[^\d]*\$?([\d,.]+)[^\d]*(?:stripe|payment)?\s*link|\$?([\d,.]+)\s+(?:stripe|payment)\s*link/);
    if (quickLinkMatch) {
      const raw    = quickLinkMatch[1] || quickLinkMatch[2] || quickLinkMatch[3];
      const amount = parseFloat(raw.replace(/,/g, ''));
      if (amount > 0) {
        const link = await createStripePaymentLink(amount, { description: `Gorilla Rental Payment — $${amount}` });
        return { text: `Payment link for $${amount}:\n${link}`, paymentLink: link, amount };
      }
    }

    // "check late rentals"
    if (/check late rentals/.test(msg)) {
      const count = await checkLateRentals();
      return { text: `Late rental check complete: ${count} overdue rentals processed` };
    }

    // "morning briefing"
    if (/morning briefing/.test(msg)) {
      const briefing = await sendMorningBriefing();
      return { text: briefing };
    }

    // "monthly report"
    if (/monthly report/.test(msg)) {
      const report = await sendMonthlyReport();
      return { text: report };
    }

    // "pending approvals"
    if (/pending approvals/.test(msg)) {
      const approvals = await listPendingApprovals();
      if (!approvals.length) return { text: 'No pending approvals.' };
      const lines = approvals.map(a => `  - ${a.id} | ${a.metadata?.type || 'N/A'} | created ${a.createdAt}`).join('\n');
      return { text: `Pending approvals (${approvals.length}):\n${lines}`, approvals };
    }

    // "show receipts [month]"
    const receiptsMatch = msg.match(/show receipts\s+(.+)/);
    if (receiptsMatch) {
      const receipts = await listReceipts(receiptsMatch[1]);
      const lines    = receipts.map(r => `  - ${r.name} (${r.size} bytes)`).join('\n') || '  None';
      return { text: `Receipts for ${receiptsMatch[1]}:\n${lines}`, receipts };
    }
  } catch (cmdErr) {
    console.error('[Admin] Command error:', cmdErr.message);
    return { text: `Error: ${cmdErr.message}`, error: cmdErr.message };
  }

  // ── Claude AI handling ──────────────────────────────────
  let knowledgeContext = '';
  try {
    const { getAgentContext } = await import('./knowledge.js');
    knowledgeContext = await getAgentContext('admin');
  } catch {}

  const systemPrompt = `You are the Admin Agent for Gorilla Rental.
PIPELINE: ${pipeline.length} jobs | Reserved: ${pipeline.filter(j=>j.stage==='reserved').length} | Contract sent: ${pipeline.filter(j=>j.stage==='contract_sent').length} | In progress: ${pipeline.filter(j=>j.stage==='in_progress').length} | Completed: ${pipeline.filter(j=>j.stage==='completed').length}
RECENT: ${pipeline.slice(-5).map(j=>`${j.jobId}|${j.customerName}|${j.stage}|$${j.total?.toFixed(2)||'?'}`).join(' | ')}
ACTIONS:
{"action":"create_reservation","jobId":"GR-2026-XXXX"}
{"action":"send_confirmation","jobId":"GR-2026-XXXX"}
{"action":"send_contract","jobId":"GR-2026-XXXX"}
{"action":"create_invoice","jobId":"GR-2026-XXXX","type":"final"}
{"action":"get_status","jobId":"GR-2026-XXXX"}
{"action":"cashflow_report","month":"2026-03"}
{"action":"add_expense","amount":200,"description":"Gas for delivery","category":"Fuel","jobId":"GR-2026-XXXX"}
{"action":"add_income","amount":1500,"description":"Equipment rental payment","category":"Rental Income","jobId":"GR-2026-XXXX"}
{"action":"request_deposit_approval","jobId":"GR-2026-XXXX"}
{"action":"request_balance_approval","jobId":"GR-2026-XXXX"}
{"action":"check_late_rentals"}
{"action":"morning_briefing"}
{"action":"monthly_report"}
{"action":"pending_approvals"}
{"action":"create_payment_link","amount":300,"description":"Optional description"}

IMPORTANT: You CAN and SHOULD log expenses and income directly using add_expense or add_income. When someone asks for a payment link or Stripe link with a dollar amount — even without a job ID — use create_payment_link immediately. When someone says "log $200 gas expense" or "record a payment" — use the action immediately. Never tell the user to log it elsewhere.${knowledgeContext ? '\n\nKNOWLEDGE BASE INTEL:\n' + knowledgeContext : ''}`;

  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, system: systemPrompt, messages });
  const text     = response.content[0].text;

  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched);
      let result = null;
      if      (action.action === 'create_reservation')        result = await createReservation(action.jobId);
      else if (action.action === 'send_confirmation')          result = await sendReservationConfirmation(action.jobId);
      else if (action.action === 'send_contract')              result = await createContract(action.jobId);
      else if (action.action === 'create_invoice')             result = await createInvoice(action.jobId, action.type || 'final');
      else if (action.action === 'get_status')                 result = await getReservationStatus(action.jobId);
      else if (action.action === 'cashflow_report')            result = await getCashflowReport(action.month || new Date().toISOString().slice(0, 7));
      else if (action.action === 'add_expense')                result = await recordPaymentInCashflow(action.jobId || null, action.amount, 'expense', action.description, action.category || 'Expense');
      else if (action.action === 'add_income')                 result = await recordPaymentInCashflow(action.jobId || null, action.amount, 'income', action.description, action.category || 'Rental Income');
      else if (action.action === 'request_deposit_approval')   result = await requestDepositApproval(action.jobId);
      else if (action.action === 'request_balance_approval')   result = await requestBalanceApproval(action.jobId);
      else if (action.action === 'check_late_rentals')         result = await checkLateRentals();
      else if (action.action === 'morning_briefing')           result = await sendMorningBriefing();
      else if (action.action === 'monthly_report')             result = await sendMonthlyReport();
      else if (action.action === 'pending_approvals')          result = await listPendingApprovals();
      else if (action.action === 'create_payment_link') {
        const link = await createStripePaymentLink(action.amount, { description: action.description || `Gorilla Rental Payment — $${action.amount}` });
        result = { paymentLink: link, amount: action.amount };
        return { text: `Payment link for $${action.amount}:\n${link}`, action, result };
      }
      return { text, action, result };
    } catch (e) { return { text, error: e.message }; }
  }
  return { text };
}

// ─── Routes ────────────────────────────────────────────────

export function adminRoutes(app) {
  // Original routes
  app.post('/admin/chat',                async (req, res) => { try { res.json({ ok: true, ...await adminChat(req.body.message, req.body.history || []) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/reservation',         async (req, res) => { try { res.json({ ok: true, ...await createReservation(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/reservation/confirm', async (req, res) => { try { res.json({ ok: true, ...await sendReservationConfirmation(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/contract',            async (req, res) => { try { res.json({ ok: true, ...await createContract(req.body.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/admin/invoice',             async (req, res) => { try { res.json({ ok: true, invoice: await createInvoice(req.body.jobId, req.body.type || 'final') }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/admin/status/:jobId',        async (req, res) => { try { res.json({ ok: true, ...await getReservationStatus(req.params.jobId) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/admin/reservations',         async (req, res) => { try { res.json({ ok: true, reservations: readJSON(DATA.reservations) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

  // 6I — Approval routes
  app.post('/admin/approval/respond', async (req, res) => {
    try {
      const { approvalId, response } = req.body;
      if (!approvalId) return res.status(400).json({ ok: false, error: 'approvalId required' });
      if (response === 'YES') await grantApproval(approvalId);
      else await denyApproval(approvalId);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/admin/approvals', async (req, res) => {
    try {
      const approvals = await listPendingApprovals();
      res.json({ ok: true, approvals });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Cashflow routes
  app.post('/admin/cashflow/entry', async (req, res) => {
    try {
      const { date, description, category, amount, type, jobId, receipt } = req.body;
      const rowCount = await addCashflowEntry({ date, description, category, amount: parseFloat(amount), type, jobId, receipt });
      res.json({ ok: true, rowCount });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/admin/cashflow', async (req, res) => {
    try {
      const rows = await readCashflow();
      res.json({ ok: true, rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/admin/cashflow/summary', async (req, res) => {
    try {
      const month   = req.query.month || new Date().toISOString().slice(0, 7);
      const summary = await getCashflowSummary(month);
      res.json({ ok: true, month, ...summary });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Receipt routes (multer handled in index.js)
  app.post('/admin/receipt', async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
      const result = await processReceipt(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        req.body
      );
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/admin/receipts', async (req, res) => {
    try {
      const month    = req.query.month || new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const receipts = await listReceipts(month);
      res.json({ ok: true, month, receipts });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Trigger routes
  app.post('/admin/briefing', async (req, res) => {
    try {
      const briefing = await sendMorningBriefing();
      res.json({ ok: true, briefing });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/admin/monthly-report', async (req, res) => {
    try {
      const report = await sendMonthlyReport();
      res.json({ ok: true, report });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/admin/late-rentals', async (req, res) => {
    try {
      const count = await checkLateRentals();
      res.json({ ok: true, overdueCount: count });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/admin/post-rental/:jobId', async (req, res) => {
    try {
      const approvalId = await postRentalCheck(req.params.jobId);
      res.json({ ok: true, approvalId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Admin] ✅ Routes registered');
}
