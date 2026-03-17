// ============================================================
// QUOTES.JS — Quote Agent
// Builds quotes, Job IDs, Booqable orders, Stripe deposits
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, PRICING, EQUIPMENT_CATALOG } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { generateQuotePDF, buildQuoteHTML, buildQuoteEmailHTML } from './quote-pdf.js';

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
  pipeline: path.join(__dirname, 'data/pipeline.json'),
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

function generateJobId() {
  const pipeline = readJSON(DATA.pipeline);
  const num      = String(pipeline.length + 1).padStart(4, '0');
  return `GR-2026-${num}`;
}

// ─── Booqable SKU → Product ID map ────────────────────────────
const BOOQABLE_PRODUCT_IDS = {
  BL001: '8981d3ef-952c-4d69-bd17-de6943b2abb6',
  BL002: '212e9a7a-2070-43e4-ac6b-6e706e47a1e3',
  BL003: 'd84f59f1-08a5-4a78-a716-bc51f3af64d7',
  BL005: '1637d88d-2759-4a2d-b372-2766029a7b1c',
  BL007: 'a5d32ddc-9167-44b7-97f2-75d7b9a95595',
  BL008: 'b5baf61d-44d1-42a5-8bbf-fae62c42a058',
  BL009: 'ddd6c45b-c6ae-4c3f-ba00-9bf292378d58',
  BL010: '1b687ef3-c1a4-48e4-9a50-bf5b3135736d',
  BL011: '78ca2eab-aa7f-4754-a934-9e4daa5fcaa9',
  PS001: 'bf395dd4-d615-4002-be4f-caac7d7df912',
  PS002: '05d20059-0429-4871-bb9c-eb64434c9269',
  OP001: 'a09bd377-4a14-412e-ab5d-615bee4dcd56',
  T001:  '3551cc84-26dc-4498-bb43-98c5d0c3e853',
};

// ─── Booqable ─────────────────────────────────────────────────
async function createBooqableOrder(quote) {
  const { BASE_URL, API_KEY } = CONFIG.BOOQABLE;
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };

  // 1. Find or create customer
  const searchRes = await fetch(
    `${BASE_URL}/customers?q[email_eq]=${encodeURIComponent(quote.customerEmail)}`,
    { headers }
  );
  const searchData = await searchRes.json();
  let customerId = searchData?.customers?.[0]?.id || null;

  if (!customerId) {
    const custRes = await fetch(`${BASE_URL}/customers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customer: {
          name:  quote.customerName,
          email: quote.customerEmail,
          phone: quote.customerPhone,
        },
      }),
    });
    const custData = await custRes.json();
    customerId = custData?.customer?.id;
    if (!customerId) throw new Error(`Booqable customer error: ${JSON.stringify(custData)}`);
  }

  // 2. Create order
  const orderRes = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      order: {
        starts_at:   quote.startDate ? `${quote.startDate}T08:00:00.000Z` : null,
        stops_at:    quote.endDate   ? `${quote.endDate}T08:00:00.000Z`   : null,
        customer_id: customerId,
        tag_list:    [`job-${quote.jobId}`, 'gorilla-rental'],
        note:        `Job ID: ${quote.jobId} | ${quote.deliveryAddress || ''}`,
      },
    }),
  });
  if (!orderRes.ok) throw new Error(`Booqable order error: ${await orderRes.text()}`);
  const orderData = await orderRes.json();
  const orderId = orderData?.order?.id;
  if (!orderId) throw new Error(`Booqable order missing ID: ${JSON.stringify(orderData)}`);

  // 3. Add line items
  const items = quote.equipment || [];
  for (const item of items) {
    const productId = BOOQABLE_PRODUCT_IDS[item.sku];
    if (!productId) continue;
    await fetch(`${BASE_URL}/orders/${orderId}/lines`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ line: { product_id: productId, quantity: item.quantity || 1 } }),
    });
  }

  return orderId;
}

// ─── Stripe deposit link ──────────────────────────────────────
async function createDepositLink(jobId, customerName) {
  const res = await fetch('https://api.stripe.com/v1/payment_links', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.STRIPE_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'line_items[0][price_data][currency]':                   'usd',
      'line_items[0][price_data][product_data][name]':         `Deposit — ${jobId} — Gorilla Rental`,
      'line_items[0][price_data][unit_amount]':                String(PRICING.DEPOSIT * 100),
      'line_items[0][quantity]':                               '1',
      'metadata[job_id]':                                      jobId,
      'metadata[type]':                                        'deposit',
      'metadata[customer]':                                    customerName,
      'after_completion[type]':                                'hosted_confirmation',
      'after_completion[hosted_confirmation][custom_message]': 'Deposit received! Gorilla Rental will confirm your booking shortly.',
    }),
  });
  if (!res.ok) throw new Error(`Stripe deposit error: ${await res.text()}`);
  return (await res.json()).url;
}

// ─── Quote calculator ─────────────────────────────────────────
function calculateQuote(items) {
  let subtotal = PRICING.DELIVERY_FEE;

  const equipment = items.map(item => {
    const eq = EQUIPMENT_CATALOG.find(e =>
      e.sku === item.sku ||
      e.name.toLowerCase().includes((item.name || '').toLowerCase())
    );
    if (!eq) return null;

    let unitPrice = 0;
    let rentalPeriod = '';

    if (item.months) {
      unitPrice    = (eq.monthly || eq.daily * 20) * item.months;
      rentalPeriod = `${item.months} month${item.months > 1 ? 's' : ''}`;
    } else if (item.weeks) {
      unitPrice    = (eq.weekly || eq.daily * 5) * item.weeks;
      rentalPeriod = `${item.weeks} week${item.weeks > 1 ? 's' : ''}`;
    } else {
      unitPrice    = eq.daily * (item.days || 1);
      rentalPeriod = `${item.days || 1} day${(item.days || 1) > 1 ? 's' : ''}`;
    }

    const qty   = item.quantity || 1;
    const total = unitPrice * qty;
    subtotal   += total;

    return {
      sku:          eq.sku,
      name:         eq.name,
      quantity:     qty,
      dailyRate:    eq.daily,
      rentalPeriod,
      unitPrice,
      total,
    };
  }).filter(Boolean);

  const tax   = subtotal * PRICING.TAX_RATE;
  const total = subtotal + tax;

  return { equipment, subtotal, tax, total };
}

// ─── Build & send quote ───────────────────────────────────────
export async function buildQuote(params) {
  const jobId = generateJobId();

  // Calculate pricing
  const calc = calculateQuote(params.items || []);

  // Create Booqable order
  let booqableOrderId = null;
  try {
    booqableOrderId = await createBooqableOrder({ ...params, ...calc, jobId });
  } catch (e) {
    console.warn(`[Quotes] Booqable warning: ${e.message}`);
  }

  // Create Stripe deposit link
  let depositLink = null;
  try {
    depositLink = await createDepositLink(jobId, params.customerName);
  } catch (e) {
    console.warn(`[Quotes] Stripe warning: ${e.message}`);
  }

  const quote = {
    jobId,
    customerName:  params.customerName,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    deliveryAddress: params.deliveryAddress || '',
    startDate:     params.startDate || '',
    endDate:       params.endDate   || '',
    duration:      params.duration  || '',
    ...calc,
    depositLink,
    booqableOrderId,
    notes:         params.notes || '',
    stage:         'quote_built',
    createdAt:     new Date().toISOString(),
  };

  // Save to pipeline
  const pipeline = readJSON(DATA.pipeline);
  pipeline.push(quote);
  writeJSON(DATA.pipeline, pipeline);

  console.log(`[Quotes] ✅ Quote built: ${jobId} — $${quote.total.toFixed(2)}`);
  return quote;
}

export async function sendQuote(jobId) {
  const pipeline = readJSON(DATA.pipeline);
  const quote    = pipeline.find(j => j.jobId === jobId);
  if (!quote) throw new Error(`Quote ${jobId} not found`);

  // Generate PDF + HTML email
  const pdf      = await generateQuotePDF(null, quote);
  const htmlBody = buildQuoteEmailHTML(quote);

  // Send email
  await sendEmailWithPDF({
    to:        quote.customerEmail,
    subject:   `Your Equipment Rental Quote — ${jobId} — Gorilla Rental`,
    body:      `Hi ${quote.customerName}, your Gorilla Rental quote ${jobId} is attached. Total: $${quote.total?.toFixed(2)}. Deposit link: ${quote.depositLink || 'Contact us'}`,
    htmlBody,
    pdfBuffer: pdf,
    pdfName:   `Gorilla-Rental-Quote-${jobId}.pdf`,
  });

  // Update pipeline stage
  const idx = pipeline.findIndex(j => j.jobId === jobId);
  pipeline[idx].stage    = 'quote_sent';
  pipeline[idx].sentAt   = new Date().toISOString();
  writeJSON(DATA.pipeline, pipeline);

  console.log(`[Quotes] ✅ Quote sent: ${jobId} → ${quote.customerEmail}`);
  return { ok: true, jobId, to: quote.customerEmail };
}

// ─── AI Quote Chat ────────────────────────────────────────────
export async function quoteChat(message, history = []) {
  const pipeline = readJSON(DATA.pipeline);

  const systemPrompt = `You are the Quote Agent for Gorilla Rental — a boom lift and scissor lift rental company in South Florida.

Your job is to gather information from the customer and build accurate rental quotes.

EQUIPMENT CATALOG:
${EQUIPMENT_CATALOG.map(e => `  ${e.sku}: ${e.name} — $${e.daily || '?'}/day | $${e.weekly || '?'}/week | $${e.monthly || '?'}/month`).join('\n')}

PRICING RULES:
- Delivery fee: $${PRICING.DELIVERY_FEE} flat
- Tax rate: ${PRICING.TAX_RATE * 100}% (Florida)
- Deposit to confirm: $${PRICING.DEPOSIT}

PIPELINE: ${pipeline.length} jobs total, ${pipeline.filter(j => j.stage === 'quote_sent').length} quotes sent

To build a quote, collect:
1. Customer name, email, phone
2. Equipment needed (type + quantity)
3. Rental period (start date, end date or duration)
4. Delivery address

When you have all info, respond with a JSON action block:
{"action": "build_quote", "customerName": "...", "customerEmail": "...", "customerPhone": "...", "deliveryAddress": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "duration": "X days/weeks/months", "items": [{"sku": "BL001", "quantity": 1, "days": 7}]}

To send a built quote:
{"action": "send_quote", "jobId": "GR-2026-XXXX"}

Be friendly, professional, and efficient. You represent Gorilla Rental.`;

  const messages  = [...history, { role: 'user', content: message }];
  const response  = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    system:     systemPrompt,
    messages,
  });

  const text  = response.content[0].text;
  const matched = extractActionJSON(text);

  if (matched) {
    try {
      const action = JSON.parse(matched);
      let result   = null;

      if (action.action === 'build_quote') {
        result = await buildQuote(action);
      } else if (action.action === 'send_quote') {
        result = await sendQuote(action.jobId);
      }

      return { text, action, result };
    } catch (e) {
      return { text, error: e.message };
    }
  }

  return { text };
}

// ─── Express routes ───────────────────────────────────────────
export function quoteRoutes(app) {
  app.post('/quote/chat', async (req, res) => {
    try {
      const result = await quoteChat(req.body.message, req.body.history || []);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/quote/build', async (req, res) => {
    try {
      const quote = await buildQuote(req.body);
      res.json({ ok: true, quote });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/quote/send', async (req, res) => {
    try {
      const result = await sendQuote(req.body.jobId);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/quote/pipeline', (req, res) => {
    try {
      const pipeline = readJSON(DATA.pipeline);
      res.json({ ok: true, pipeline, total: pipeline.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Quotes] ✅ Routes registered');
}
