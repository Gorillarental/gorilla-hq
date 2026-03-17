// ============================================================
// MARKETING AGENT — Gorilla Rental AI
// SMS + CRM via GoHighLevel (no Twilio)
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, EQUIPMENT_CATALOG, PRICING } from './config.js';
import { sendEmailWithPDF } from './chip.js';
import { sendSMS, getOrCreateContact, addNote, addTag, upsertOpportunity } from './ghl.js';

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
  leads:     path.join(__dirname, 'data/leads.json'),
  marketing: path.join(__dirname, 'data/marketing.json'),
  pipeline:  path.join(__dirname, 'data/pipeline.json'),
};

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

export async function captureLead(data) {
  const leads = readJSON(DATA.leads);
  const lead  = {
    id:        `LEAD-${Date.now()}`,
    source:    data.source    || 'website',
    name:      data.name      || data.customerName  || 'Unknown',
    email:     data.email     || data.customerEmail || '',
    phone:     data.phone     || data.customerPhone || '',
    equipment: data.equipment || '',
    message:   data.message   || '',
    status:    'new',
    createdAt: new Date().toISOString(),
  };
  leads.push(lead);
  writeJSON(DATA.leads, leads);

  // Create GHL contact + opportunity
  let ghlContact = null;
  if (lead.phone || lead.email) {
    try {
      const { contact } = await getOrCreateContact(lead.phone, {
        name: lead.name, email: lead.email,
        tags: ['gorilla-rental', 'lead', lead.source],
      });
      ghlContact = contact;
      if (contact?.id) {
        await addNote(contact.id, `📥 New lead from ${lead.source}\nEquipment: ${lead.equipment || 'TBD'}\nMessage: ${lead.message || 'none'}`);
        await upsertOpportunity({ name: `${lead.name} — ${lead.equipment || 'Inquiry'} — ${new Date().toLocaleDateString()}`, contactId: contact.id, status: 'open', value: 0 }).catch(() => {});
      }
    } catch (e) { console.warn(`[Marketing] GHL warning: ${e.message}`); }
  }

  // Notify Andrei
  await sendSMS(CONFIG.BRAND.PHONE,
    `🦍 NEW LEAD (${lead.source.toUpperCase()})\nName: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nEquip: ${lead.equipment}\nMsg: ${(lead.message||'none').slice(0,100)}`,
    { name: 'Andrei - Gorilla Rental' }
  );

  // Auto-reply email
  if (lead.email) {
    await sendEmailWithPDF({
      to:      lead.email,
      subject: `Thanks for reaching out — Gorilla Rental`,
      body:    `Hi ${lead.name},\n\nThanks for contacting Gorilla Rental! We'll get back to you within 1-2 hours.\n\n🏗️ Boom Lifts: 32ft–125ft\n✂️ Scissor Lifts from 32ft\n🪜 Scaffolding & Shore Posts\n\nWe'll send your custom quote shortly.\n\nQuestions? Call: ${CONFIG.BRAND.PHONE}\n\n— Gorilla Rental Team\n${CONFIG.BRAND.PHONE} | ${CONFIG.BRAND.WEBSITE}`,
      attachments: [],
    });
  }

  // Auto-reply SMS to lead
  if (lead.phone) {
    await sendSMS(lead.phone,
      `Hi ${lead.name}! Thanks for reaching out to Gorilla Rental. We'll send your quote within the hour. Questions? Call ${CONFIG.BRAND.PHONE}`,
      { name: lead.name, email: lead.email, tags: ['gorilla-rental', 'new-lead'] }
    );
  }

  console.log(`[Marketing] ✅ Lead captured: ${lead.id} — ${lead.name}`);
  return { lead, ghlContactId: ghlContact?.id };
}

export async function updateLeadStatus(leadId, status, notes = '') {
  const leads = readJSON(DATA.leads);
  const idx   = leads.findIndex(l => l.id === leadId);
  if (idx < 0) throw new Error(`Lead ${leadId} not found`);
  leads[idx].status = status; leads[idx].notes = notes; leads[idx].updatedAt = new Date().toISOString();
  writeJSON(DATA.leads, leads);
  if (leads[idx].phone) {
    try { const { contact } = await getOrCreateContact(leads[idx].phone); if (contact?.id) await addTag(contact.id, [`lead-${status}`]); } catch {}
  }
  return leads[idx];
}

export async function getLeads(filters = {}) {
  let list = readJSON(DATA.leads);
  if (filters.status) list = list.filter(l => l.status === filters.status);
  if (filters.source) list = list.filter(l => l.source === filters.source);
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function generateSocialPost(type = 'equipment', options = {}) {
  const equipment = options.equipment
    ? EQUIPMENT_CATALOG.find(e => e.name?.toLowerCase().includes(options.equipment.toLowerCase())) || EQUIPMENT_CATALOG[0]
    : EQUIPMENT_CATALOG[Math.floor(Math.random() * EQUIPMENT_CATALOG.length)];

  const prompts = {
    equipment: `Write a punchy Facebook/Instagram post for Gorilla Rental promoting the ${equipment.name}. Daily: $${equipment.daily||'call'}, Weekly: $${equipment.weekly||'call'}. South Florida focus. Bold contractor-friendly tone. 1-2 emojis. Max 150 words. End with: 📞 ${CONFIG.BRAND.PHONE} | 🌐 ${CONFIG.BRAND.WEBSITE}`,
    promo:     `Write a promo post for Gorilla Rental — South Florida boom lift & scissor lift rentals. Theme: ${options.theme||'spring construction season'}. Fast delivery, competitive pricing. Max 120 words. End with phone: ${CONFIG.BRAND.PHONE}`,
    safety:    `Write an educational aerial work platform safety post for Gorilla Rental. Topic: ${options.topic||'daily pre-use inspection'}. Safety-first tone. Max 150 words.`,
    seasonal:  `Write a seasonal equipment rental post for Gorilla Rental in South Florida. Season: ${options.season||'hurricane prep'}. Tie to relevant equipment needs. Max 120 words. Include CTA and phone.`,
  };

  const response = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role: 'user', content: prompts[type] || prompts.equipment }],
  });

  const post      = response.content[0].text;
  const marketing = readJSON(DATA.marketing, {});
  if (!marketing.posts) marketing.posts = [];
  marketing.posts.push({ type, content: post, equipment: equipment?.name, generatedAt: new Date().toISOString() });
  writeJSON(DATA.marketing, marketing);

  console.log(`[Marketing] ✅ Post generated (${type})`);
  return { post, type, equipment: equipment?.name };
}

export async function sendOutreachEmail(contractor) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role: 'user', content: `Write a cold outreach email from Gorilla Rental to a contractor in South Florida.\nContractor: ${contractor.name||'the team'} at ${contractor.company||'their company'}\nIndustry: ${contractor.industry||'general construction'}\nGorilla Rental: Boom lifts up to 125ft, scissor lifts, scaffolding. Fast delivery. Local South Florida team.\nTone: Professional, contractor-to-contractor. Not salesy. 3-4 short paragraphs.\nInclude phone ${CONFIG.BRAND.PHONE} and website ${CONFIG.BRAND.WEBSITE}.\nStart with "Subject: ..." on first line.` }],
  });

  const lines      = response.content[0].text.split('\n');
  const subject    = lines.find(l => l.startsWith('Subject:'))?.replace('Subject:', '').trim() || 'Aerial Equipment Rental — South Florida';
  const body       = lines.filter(l => !l.startsWith('Subject:')).join('\n').trim();

  await sendEmailWithPDF({ to: contractor.email, subject, body, attachments: [] });

  if (contractor.phone || contractor.email) {
    try {
      const { contact } = await getOrCreateContact(contractor.phone || '', { name: contractor.name, email: contractor.email, tags: ['gorilla-rental', 'outreach', 'contractor'] });
      if (contact?.id) await addNote(contact.id, `📧 Outreach email sent: "${subject}"`);
    } catch {}
  }

  const marketing = readJSON(DATA.marketing, {});
  if (!marketing.outreach) marketing.outreach = [];
  marketing.outreach.push({ contractor, subject, sentAt: new Date().toISOString() });
  writeJSON(DATA.marketing, marketing);

  console.log(`[Marketing] ✅ Outreach sent to ${contractor.email}`);
  return { sent: true, subject, to: contractor.email };
}

export async function generateEquipmentListing(equipmentSku) {
  const eq = EQUIPMENT_CATALOG.find(e => e.sku === equipmentSku);
  if (!eq) throw new Error(`Equipment ${equipmentSku} not found`);
  const response = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role: 'user', content: `Write a Facebook Marketplace rental listing for:\nEquipment: ${eq.name}\nDaily: $${eq.daily||'call'} | Weekly: $${eq.weekly||'call'} | Monthly: $${eq.monthly||'call'}\nCompany: Gorilla Rental — South Florida\nFormat: Title, Description, Key Features (bullets), Pricing, Contact info.\nProfessional and informative. Real contractor language.` }],
  });
  return { equipment: eq, listing: response.content[0].text };
}

export function getMarketingStats() {
  const leads     = readJSON(DATA.leads);
  const marketing = readJSON(DATA.marketing, {});
  const pipeline  = readJSON(DATA.pipeline);
  const bySource  = {};
  for (const l of leads) bySource[l.source] = (bySource[l.source] || 0) + 1;
  return {
    totalLeads:      leads.length,
    newLeads:        leads.filter(l => l.status === 'new').length,
    contactedLeads:  leads.filter(l => l.status === 'contacted').length,
    convertedLeads:  leads.filter(l => l.status === 'converted').length,
    leadsBySource:   bySource,
    conversionRate:  leads.length > 0 ? `${(pipeline.filter(j => j.source).length / leads.length * 100).toFixed(1)}%` : '0%',
    postsGenerated:  (marketing.posts    || []).length,
    outreachSent:    (marketing.outreach || []).length,
  };
}

export async function marketingChat(message, history = []) {
  const stats  = getMarketingStats();
  const recent = readJSON(DATA.leads).slice(-5);
  const systemPrompt = `You are the Marketing Agent for Gorilla Rental — South Florida boom lift rentals. SMS + CRM via GHL.
STATS: ${stats.totalLeads} leads | ${stats.newLeads} new | ${stats.convertedLeads} converted | ${stats.conversionRate} conversion
RECENT: ${recent.map(l=>`${l.id}|${l.name}|${l.source}|${l.status}`).join(' | ')||'None'}
ACTIONS:
{"action":"generate_post","type":"equipment|promo|safety|seasonal"}
{"action":"generate_listing","sku":"BL001"}
{"action":"capture_lead","name":"...","email":"...","phone":"...","equipment":"...","source":"..."}
{"action":"send_outreach","email":"...","name":"...","company":"...","industry":"..."}
{"action":"get_stats"}
{"action":"get_leads","status":"new|contacted|converted"}`;
  const messages = [...history, { role: 'user', content: message }];
  const response = await client.messages.create({ model: 'claude-opus-4-6', max_tokens: 1024, system: systemPrompt, messages });
  const text     = response.content[0].text;
  const matched = extractActionJSON(text);
  if (matched) {
    try {
      const action = JSON.parse(matched); let result = null;
      if (action.action === 'generate_post')     result = await generateSocialPost(action.type || 'equipment', action);
      else if (action.action === 'generate_listing') result = await generateEquipmentListing(action.sku);
      else if (action.action === 'capture_lead')     result = await captureLead(action);
      else if (action.action === 'send_outreach')    result = await sendOutreachEmail(action);
      else if (action.action === 'get_stats')        result = getMarketingStats();
      else if (action.action === 'get_leads')        result = await getLeads({ status: action.status });
      return { text, action, result };
    } catch (e) { return { text, error: e.message }; }
  }
  return { text };
}

export function marketingRoutes(app) {
  app.post('/marketing/chat',     async (req, res) => { try { res.json({ ok: true, ...await marketingChat(req.body.message, req.body.history || []) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/marketing/lead',     async (req, res) => { try { res.json({ ok: true, ...await captureLead(req.body) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/marketing/leads',     async (req, res) => { try { res.json({ ok: true, leads: await getLeads(req.query) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/marketing/post',     async (req, res) => { try { res.json({ ok: true, ...await generateSocialPost(req.body.type || 'equipment', req.body) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/marketing/listing',  async (req, res) => { try { res.json({ ok: true, ...await generateEquipmentListing(req.body.sku) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/marketing/outreach', async (req, res) => { try { res.json({ ok: true, ...await sendOutreachEmail(req.body) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/marketing/stats',     (req, res) => { try { res.json({ ok: true, stats: getMarketingStats() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  console.log('[Marketing] ✅ Routes registered');
}

