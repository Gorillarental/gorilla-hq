// ============================================================
// QUOTES.JS — Quote Agent
// Builds quotes, Job IDs, Booqable orders, Stripe deposits
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import { logActivity, createTask } from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, PRICING, EQUIPMENT_CATALOG } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { generateQuotePDF, buildQuoteHTML, buildQuoteEmailHTML } from './quote-pdf.js';
import { getPipeline, upsertJob, getJob, updateJob } from './db.js';
import { BOOQABLE_TOOLS, dispatchBooqableTool } from './booqable.js';
import { MEMORY_TOOLS, dispatchMemoryTool } from './memory.js';
import { syncQuoteToGHL, updateGHLStage, enrollInWorkflow } from './ghl.js';
import { writeHandoff } from './outcomes.js';

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

async function generateJobId() {
  const pipeline = await getPipeline();
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

// ─── Customer match scoring (mirrors booqable.js scoreCustomerMatch) ──
function scoreCustomerMatch(customer, searchName, searchEmail) {
  let score = 0;
  const cName  = (customer.name  || '').toLowerCase().trim();
  const cEmail = (customer.email || '').toLowerCase().trim();
  const sName  = (searchName  || '').toLowerCase().trim();
  const sEmail = (searchEmail || '').toLowerCase().trim();

  if (sEmail && cEmail === sEmail) score += 100;
  if (sName && cName === sName) score += 80;
  if (sName && sName.length > 4) {
    if (cName.includes(sName)) score += 40;
    if (sName.includes(cName) && cName.length > 4) score += 30;
  }
  const nameParts = sName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ');
  if (firstName.length > 3 && cName.startsWith(firstName)) score += 20;
  if (lastName.length  > 3 && cName.includes(lastName))    score += 25;
  return score;
}

// ─── Booqable customer lookup ──────────────────────────────────
async function lookupBooqableCustomer(query) {
  try {
    const { BASE_URL, API_KEY } = CONFIG.BOOQABLE;
    const q = (query || '').toLowerCase().trim();
    // Determine if query looks like an email
    const isEmail = q.includes('@');
    let best = null, bestScore = 0;

    let page = 1;
    while (page <= 5) {
      const res  = await fetch(`${BASE_URL}/customers?per_page=100&page=${page}&api_key=${API_KEY}`);
      const data = await res.json();
      const customers = data?.customers || [];
      if (!customers.length) break;

      for (const c of customers) {
        // Always include exact phone match (legacy behavior)
        const phone = c.properties_attributes?.phone || c.phone || '';
        if (phone && phone.replace(/\D/g,'').includes(q.replace(/\D/g,'')) && q.replace(/\D/g,'').length >= 7) {
          return { name: c.name, email: c.email, phone, address: c.properties_attributes?.main_address || c.address1 || c.city || '' };
        }
        const score = scoreCustomerMatch(c, isEmail ? '' : query, isEmail ? query : '');
        if (score > bestScore) { bestScore = score; best = c; }
      }

      if (customers.length < 100) break;
      page++;
    }

    // Require score >= 40 (email or meaningful name match)
    if (!best || bestScore < 40) return null;
    const props = best.properties_attributes || {};
    return {
      name:    best.name,
      email:   best.email,
      phone:   props.phone || best.phone || '',
      address: props.main_address || best.address1 || best.city || '',
    };
  } catch {
    return null;
  }
}

// ─── Booqable (boomerang API) ─────────────────────────────────
async function createBooqableOrder(quote) {
  const {
    BOOQABLE_SEARCH_CUSTOMERS_BY_EMAIL,
    BOOQABLE_SEARCH_CUSTOMERS,
    BOOQABLE_CREATE_CUSTOMER,
    BOOQABLE_CREATE_ORDER,
    BOOQABLE_CREATE_LINE,
  } = await import('./booqable.js');

  // 1. Find customer by email (boomerang API) — NEVER create without searching first
  let customerId = null;
  if (quote.customerEmail) {
    try {
      const byEmail = await BOOQABLE_SEARCH_CUSTOMERS_BY_EMAIL({ email: quote.customerEmail });
      const customers = byEmail?.customers || [];
      const hit = customers.find(c => c.email?.toLowerCase() === quote.customerEmail.toLowerCase());
      if (hit) customerId = hit.id;
    } catch {}
  }
  if (!customerId && quote.customerName) {
    try {
      const byName = await BOOQABLE_SEARCH_CUSTOMERS({ q: quote.customerName, per_page: 5 });
      const customers = byName?.customers || [];
      if (customers.length > 0) customerId = customers[0].id;
    } catch {}
  }

  // Only create if no match found
  if (!customerId) {
    const custData = await BOOQABLE_CREATE_CUSTOMER({
      name:  quote.customerName,
      email: quote.customerEmail,
      phone: quote.customerPhone,
    });
    customerId = custData?.customer?.id;
    if (!customerId) throw new Error(`Booqable customer create failed: ${JSON.stringify(custData)}`);
  }

  // 2. Create order via boomerang API
  const orderData = await BOOQABLE_CREATE_ORDER({
    customer_id: customerId,
    starts_at:   quote.startDate ? `${quote.startDate}T08:00:00.000Z` : undefined,
    stops_at:    quote.endDate   ? `${quote.endDate}T08:00:00.000Z`   : undefined,
    tag_list:    [`job-${quote.jobId}`, 'gorilla-rental'],
    note:        `Job ID: ${quote.jobId} | ${quote.deliveryAddress || ''}`,
    status:      'concept',
  });
  const orderId = orderData?.order?.id;
  if (!orderId) throw new Error(`Booqable order missing ID: ${JSON.stringify(orderData)}`);

  // 3. Add line items via boomerang API
  const items = quote.equipment || [];
  for (const item of items) {
    const productId = item.productId || BOOQABLE_PRODUCT_IDS[item.sku];
    if (!productId) {
      console.warn(`[Quotes] No Booqable product ID for sku: ${item.sku}`);
      continue;
    }
    try {
      await BOOQABLE_CREATE_LINE({
        order_id:  orderId,
        item_id:   productId,
        quantity:  item.quantity || 1,
        starts_at: quote.startDate ? `${quote.startDate}T08:00:00.000Z` : undefined,
        stops_at:  quote.endDate   ? `${quote.endDate}T08:00:00.000Z`   : undefined,
      });
    } catch (e) {
      console.warn(`[Quotes] Line item error for ${item.sku}: ${e.message}`);
    }
  }

  return { orderId, customerId };
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
  const jobId = await generateJobId();

  // Calculate pricing
  const calc = calculateQuote(params.items || []);

  // Create Booqable order
  let booqableOrderId = null;
  let booqableCustomerId = null;
  try {
    const bqResult = await createBooqableOrder({ ...params, ...calc, jobId });
    booqableOrderId    = bqResult.orderId;
    booqableCustomerId = bqResult.customerId;
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

  const now = new Date();
  const quote = {
    jobId,
    quoteNumber:   jobId,
    customerName:  params.customerName,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    customerId:    params.customerId || booqableCustomerId || '',
    deliveryAddress: params.deliveryAddress || '',
    deliveryFee:   params.deliveryAddress ? (PRICING.DELIVERY_FEE || 150) : 0,
    startDate:     params.startDate || '',
    endDate:       params.endDate   || '',
    duration:      params.duration  || '',
    ...calc,
    depositLink,
    booqableOrderId,
    booqableCustomerId,
    notes:         params.notes || '',
    status:        'draft',
    stage:         'quote_built',
    createdAt:     now.toISOString(),
  };

  // Save to pipeline
  await upsertJob(quote);

  console.log(`[Quotes] ✅ Quote built: ${jobId} — $${quote.total.toFixed(2)}`);
  return quote;
}

export async function sendQuote(jobId) {
  const quote = await getJob(jobId);
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

  const sentAt    = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Update pipeline stage
  await updateJob(jobId, { stage: 'quote_sent', status: 'sent', sentAt, expiresAt });

  // Sync to GHL (pipeline tracking + workflow enrollment)
  try {
    await syncQuoteToGHL({ ...quote, sentAt, expiresAt });
  } catch (e) {
    console.warn(`[Quotes] GHL sync warning: ${e.message}`);
  }

  await logActivity({ agent: 'quote', action: 'quote_sent', description: `Quote sent for ${jobId} to ${quote.customerEmail}`, jobId, status: 'success', notify: true }).catch(()=>{});

  console.log(`[Quotes] Quote sent: ${jobId} → ${quote.customerEmail}`);
  return { ok: true, jobId, to: quote.customerEmail, sentAt, expiresAt };
}

// ─── Mark quote as lost ───────────────────────────────────────
export async function markQuoteLost(jobId, reason, customerName) {
  try {
    const quote = await getJob(jobId).catch(() => null);
    const closedAt = new Date().toISOString();

    // Update pipeline
    await updateJob(jobId, { stage: 'lost', status: 'lost', lostReason: reason, closedAt });

    // Record outcome
    const { recordLoss } = await import('./outcomes.js');
    await recordLoss(quote || { jobId, quoteNumber: jobId, customerName }, reason);

    // Update GHL stage
    await updateGHLStage(jobId, 'lost').catch(e => console.warn('[Quotes] GHL lost stage error:', e.message));

    await logActivity({ agent: 'quote', action: 'quote_lost', description: `Quote lost: ${jobId} — ${reason}`, jobId, status: 'info', notify: false }).catch(()=>{});
    return { ok: true, jobId, status: 'lost', reason };
  } catch (e) {
    console.error('[Quotes] markQuoteLost error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Convert quote to reservation ────────────────────────────
export async function convertToReservation(jobId) {
  try {
    const quote = await getJob(jobId);
    if (!quote) throw new Error(`Quote ${jobId} not found`);

    const now = new Date();
    await updateJob(jobId, { stage: 'booked', status: 'booked', bookedAt: now.toISOString() });

    // Record win
    const { recordWin } = await import('./outcomes.js');
    await recordWin(quote);

    // Write handoff
    const depositDue = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    await writeHandoff({
      type:              'reservation_created',
      timestamp:         now.toISOString(),
      customerName:      quote.customerName,
      customerEmail:     quote.customerEmail,
      customerPhone:     quote.customerPhone,
      quoteNumber:       jobId,
      booqableOrderId:   quote.booqableOrderId,
      equipment:         (quote.equipment || []).map(e => e.name || e.sku).join(', '),
      startDate:         quote.startDate,
      endDate:           quote.endDate,
      depositAmount:     250,
      depositLink:       quote.depositLink || '',
      depositRequestDate: now.toISOString(),
      depositDueDate:    depositDue,
      status:            'Awaiting Deposit',
    });

    // Update GHL
    await updateGHLStage(jobId, 'booked').catch(e => console.warn('[Quotes] GHL booked stage error:', e.message));

    await logActivity({ agent: 'quote', action: 'quote_converted', description: `Quote converted to reservation: ${jobId}`, jobId, status: 'success', notify: true }).catch(()=>{});
    return { ok: true, jobId, status: 'booked' };
  } catch (e) {
    console.error('[Quotes] convertToReservation error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── AI Quote Chat ────────────────────────────────────────────
export async function quoteChat(message, history = []) {
  const pipeline = await getPipeline();

  let knowledgeContext = '';
  try {
    const { getAgentContext } = await import('./knowledge.js');
    knowledgeContext = await getAgentContext('quote');
  } catch {}

  const systemPrompt = `You are the Quote Agent for Gorilla Rental — a heavy equipment rental company in South Florida specializing in boom lifts, scissor lifts, scaffolding, shore posts, and overhead protection.

Your mission is not just to build quotes. You are the quality control layer. Your job is to make sure no incomplete, incorrect, or risky quote ever reaches a customer. You follow a strict 15-step process every time.

═══════════════════════════════════════════════════
PIPELINE STATUS: ${pipeline.length} total jobs | ${pipeline.filter(j => j.stage === 'quote_sent').length} quotes sent | ${pipeline.filter(j => ['quote_built','quote_sent'].includes(j.stage)).length} active
═══════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — CLASSIFY THE REQUEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
First, confirm this is actually a quote request.
Quote signals: "I need a lift", "how much for a boom?", "can you quote me", "need equipment", "do you have a scissor lift available?", "what's your monthly price?", "can you send pricing?"
If it's NOT a quote request, say so clearly and route accordingly.
Quote statuses to track mentally: New Inquiry → Identifying Contact → Awaiting Missing Info → Checking Availability → Pricing in Progress → Pending Approval → Quote Ready → Quote Sent → Awaiting Response → Revision Requested → Accepted / Lost / Expired / Converted to Reservation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — IDENTIFY THE CONTACT (always first)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULE: Booqable is the ONLY source of truth for customer data. NEVER look up customers in GHL. NEVER expose the full customer list.

Before pricing anything, find who this is in BOOQABLE. Follow this EXACT sequence — no skipping:
1. Call BOOQABLE_FIND_OR_CONFIRM_CUSTOMER with name and/or email.
   - If it returns { found: true, requiresConfirmation: true } → show the match (name, email, phone only). Ask: "Use this record or create new?" Do NOT proceed until confirmed.
   - If it returns { found: true, customers: [...] } (multiple matches) → list all matches. Ask which to use. Never pick automatically.
   - If it returns { found: false } → say ONLY: "No record found for [Name]. Would you like me to add them?" Never reveal the full customer list.
2. Search memory using MEMORY_SEARCH to recall previous interactions.

Case A — Match found → confirm with Andrei before proceeding.
Case B — No match → offer to create. Wait for Andrei's confirmation. Then use BOOQABLE_CREATE_CUSTOMER.

RULE: NEVER call BOOQABLE_CREATE_CUSTOMER without first calling BOOQABLE_FIND_OR_CONFIRM_CUSTOMER. No exceptions.
RULE: Never let a quote proceed without a confirmed contact record. No contact = no quote.
RULE: QUIET HOURS (6pm–8am ET) — Do NOT send quotes, emails, SMS, or payment links during this window. If a quote is ready but it's quiet hours, tell Andrei and ask if he wants to send it now or hold until 8am.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — CHECK FOR COMPLETE QUOTE INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Required minimum to generate a quote:
CUSTOMER: name, phone, email (needed to send quote)
RENTAL: equipment type, quantity, start date, rental duration
SITE: city or job site address, delivery needed or pickup

Also helpful: indoor/outdoor, ground conditions (slab or dirt), tight access, operator needed, special requirements.

If all required info is present → proceed to Step 5.
If info is incomplete → go to Step 4.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — MISSING INFO SEQUENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ask only what is necessary. Bundle questions naturally — never robotic one-at-a-time interrogations.

Priority 1 (always ask if missing): equipment type + height, when needed, how long, job site city
Priority 2 (ask after): delivery or pickup, ground conditions, company name and email
Priority 3 (ask if relevant): special access, COI/insurance needed, weekend/long-term pricing

Good example: "Got it — a couple quick details so I can price this correctly: what type of equipment and height do you need, when do you need it, how long do you need it for, and what city is the job site in?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — CHECK CUSTOMER STATUS AND HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before pricing, determine customer standing:
- New lead → proceed normally
- Existing customer / repeat renter → check history and past orders via BOOQABLE_LIST_ORDERS
- VIP / preferred client → apply preferred pricing tier if previously approved
- Customer with overdue balance → flag: "Quote can be created but order cannot be confirmed until payment issue is reviewed"
- High-risk / blocked → escalate to human approval before sending anything

Pull from memory and Booqable: past rentals, average order value, open quotes, overdue invoices, caution tags, notes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — CHECK BOOQABLE AVAILABILITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use BOOQABLE_CHECK_AVAILABILITY for the requested equipment, date range, and quantity.

Case A — Available → proceed to pricing.
Case B — Partially available → offer alternatives: e.g. "We only have 2 of the 3 units — we can do that or swap one for a [similar model]."
Case C — Unavailable → do not end the conversation awkwardly. Suggest: closest alternative model, adjusted start date, different duration plan. Always keep the conversation moving.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7 — BUILD PRICING CORRECTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Build a real quote structure. Never just spit out a raw rate.

EQUIPMENT CATALOG:
${EQUIPMENT_CATALOG.map(e => `  ${e.sku}: ${e.name} — $${e.daily ?? '—'}/day | $${e.weekly ?? '—'}/week | $${e.monthly ?? '—'}/month`).join('\n')}

PRICING RULES:
- Delivery fee: $${PRICING.DELIVERY_FEE} flat (waived only with approval)
- Tax rate: ${PRICING.TAX_RATE * 100}% Florida state tax
- Deposit to confirm booking: $${PRICING.DEPOSIT}
- Duration logic: use monthly rate if 4+ weeks, weekly if 1–3 weeks, daily otherwise
- Multiple units: multiply by quantity

DISCOUNT APPROVAL LOGIC:
Auto-allowed (no approval needed):
  • Standard published pricing
  • Standard long-term rate (monthly vs daily)
  • Standard repeat customer tier

Approval required (flag before sending):
  • Any manual price override below standard rate
  • Waived delivery fee
  • Deep discount (>10% off published rate)
  • Custom bundled rate
  • Special pricing for strategic account

If approval required → flag it, do not send. State: "This quote needs approval before it goes out."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 8 — BUILD INTERNAL QUOTE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before anything goes to the customer, generate this internal summary:

Quote Summary
─────────────────────────────
Customer: [name] | [company]
Contact: [email] | [phone]
Equipment: [qty x model]
Start: [date] | Duration: [X days/weeks/months]
Site: [city / address]
Delivery: [yes/no]
Availability: [confirmed / alternative offered]
Rental rate: $X | Delivery: $Y | Tax: $Z | TOTAL: $T
Notes: [ground conditions, access, special needs]
Approval: [auto-approved / pending approval]
─────────────────────────────

This is your checkpoint. If anything is wrong here, fix it before proceeding.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 9 — APPROVAL GATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Auto-send when ALL of these are true:
✓ All required info complete
✓ Standard pricing (no overrides)
✓ Availability confirmed
✓ No risk flags on customer
✓ No manual discount

Require human approval when ANY of these apply:
✗ Pricing override used
✗ Delivery waived
✗ Customer has account issue or overdue balance
✗ Quote value above $5,000
✗ Availability workaround used
✗ Customer flagged as high-risk
✗ Missing email (cannot send quote anyway)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 10 — CREATE QUOTE IN BOOQABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Once validated, trigger the build_quote action. This will:
- Create the order in Booqable with correct customer, dates, and line items
- Generate a Job ID (GR-2026-XXXX)
- Create a Stripe deposit link
- Save to pipeline

Then output the internal summary with Job ID, Booqable order ID, and deposit link.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 11 — SEND TO CUSTOMER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger send_quote after build is confirmed. This sends:
- Professional email with PDF quote attached
- SMS-style follow-up note (short, warm, direct)

SMS example: "Hi [name], your quote is ready and has been sent to your email. Let me know if you'd like to make any changes or if you have questions — happy to help."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 12 — LOG EVERYTHING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After quote is sent:
- Save key customer details and quote notes to memory using MEMORY_ADD
- Note: equipment requested, job site, duration, approval status, any special requirements
- This ensures future conversations have full context without re-asking

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEPS 13-15 — FOLLOW-UP, REVISIONS, CONVERSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOLLOW-UP: After quote is sent, note that follow-up tasks should be created:
- Same day (if urgent/start date soon)
- 24 hours: "Checking if you had a chance to review"
- 2–3 days: offer help or revision
- Before expiration: remind that pricing/availability may change

REVISIONS: If customer wants changes (different duration, qty, model, dates), do not start over. Pull existing quote, identify what changed, update only those variables, recheck availability, reprice, issue revised version.

CONVERSION: When customer approves, trigger build_quote (if not yet built) or notify that ops and finance need to be alerted. The quote becomes a confirmed reservation. Trigger: {"action":"convert_to_reservation","jobId":"GR-2026-XXXX"}

MARK AS LOST: Trigger phrases: "mark [name] as lost", "lost — [reason]", "[name] went with someone else", "they passed".
When you detect one of these:
1. Ask: "What was the reason? (price / timing / went with competitor / no response / other)"
2. Once reason is given, trigger: {"action":"mark_lost","jobId":"GR-2026-XXXX","reason":"[reason]","customerName":"[name]"}
3. This updates GHL stage to "Follow-up / Repeat" and logs the outcome.

═══════════════════════════════════════════════════
NON-NEGOTIABLE RULES
═══════════════════════════════════════════════════
1. Never send a quote without: customer + equipment + date + duration + location
2. Never guess equipment type — if they say "lift," ask which type and height
3. Never apply a discount without checking approval rules
4. Never create a duplicate contact — search first, always
5. Every quote must have a follow-up plan — no dead quotes
6. Every quote must have a clear status at all times
7. Always leave an audit trail — log customer, equipment, dates, approvals, changes

═══════════════════════════════════════════════════
INTERNAL ACTIONS (trigger these when ready)
═══════════════════════════════════════════════════
Build a quote (when all info collected and validated):
{"action": "build_quote", "customerName": "...", "customerEmail": "...", "customerPhone": "...", "deliveryAddress": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "duration": "X days/weeks/months", "items": [{"sku": "BL001", "quantity": 1, "days": 7}], "notes": "..."}

Send a built quote to the customer:
{"action": "send_quote", "jobId": "GR-2026-XXXX"}
${knowledgeContext ? '\n\nKNOWLEDGE BASE:\n' + knowledgeContext : ''}`;

  const messages  = [...history, { role: 'user', content: message }];
  const response  = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system:     systemPrompt,
    messages,
    tools:      [...BOOQABLE_TOOLS, ...MEMORY_TOOLS],
  });

  // ── Tool call loop (handles multi-round tool use) ────────────
  const allToolCalls = [];
  let   current      = response;
  let   thread       = [...messages];
  const MAX_ROUNDS   = 6;

  for (let round = 0; round < MAX_ROUNDS && current.stop_reason === 'tool_use'; round++) {
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

    thread = [...thread, { role: 'assistant', content: current.content }, { role: 'user', content: toolResults }];
    current = await client.messages.create({
      model:   'claude-sonnet-4-6',
      max_tokens: 1024,
      system:  systemPrompt,
      messages: thread,
      tools:   [...BOOQABLE_TOOLS, ...MEMORY_TOOLS],
    });
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
      const action = JSON.parse(matched);
      let result   = null;

      if (action.action === 'build_quote') {
        result = await buildQuote(action);
      } else if (action.action === 'send_quote') {
        result = await sendQuote(action.jobId);
      } else if (action.action === 'mark_lost') {
        result = await markQuoteLost(action.jobId, action.reason || 'unspecified', action.customerName);
      } else if (action.action === 'convert_to_reservation') {
        result = await convertToReservation(action.jobId);
      } else if (action.action === 'lookup_customer') {
        result = await lookupBooqableCustomer(action.query || action.name || action.email || '');
        if (result) {
          const followUp = [...messages,
            { role: 'assistant', content: text },
            { role: 'user', content: `Customer found in Booqable: Name: ${result.name}, Email: ${result.email}, Phone: ${result.phone || 'not on file'}, Address: ${result.address || 'ask for delivery address'}. Now build the quote with the equipment and dates they mentioned.` },
          ];
          const followUpRes = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, messages: followUp, tools: BOOQABLE_TOOLS });
          const followUpText = followUpRes.content.filter(b => b.type === 'text').map(b => b.text).join('');
          const followUpAction = extractActionJSON(followUpText);
          if (followUpAction) {
            try {
              const fa = JSON.parse(followUpAction);
              if (fa.action === 'build_quote') result = await buildQuote(fa);
              return { text: followUpText, action: fa, result };
            } catch {}
          }
          return { text: followUpText, action, result };
        } else {
          return { text: `${text}\n\n⚠️ No customer found in Booqable for "${action.query}". Could you confirm your name or email?`, action, result: null };
        }
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

  app.get('/quote/pipeline', async (req, res) => {
    try {
      const pipeline = await getPipeline();
      res.json({ ok: true, pipeline, total: pipeline.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Quotes] ✅ Routes registered');
}
