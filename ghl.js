// ============================================================
// GHL.JS — Complete GoHighLevel Integration
// SMS, Contacts, Pipeline, Conversations, Briefings
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GHL_API     = 'https://services.leadconnectorhq.com';
const API_KEY     = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

// Phone numbers
const PHONES = {
  main:   '+19542317455',
  chip:   '+18578327404',
  andrei: '+15619286999',
};

const GHL_HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type':  'application/json',
  'Version':       '2021-04-15',
};

// ─── Core request helper ───────────────────────────────────────
async function ghl(method, endpoint, body = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const opts = { method, headers: GHL_HEADERS };
      if (body) opts.body = JSON.stringify(body);
      const res  = await fetch(`${GHL_API}${endpoint}`, opts);
      const text = await res.text();

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }

      if (!res.ok) {
        console.warn(`[GHL] ${method} ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`GHL ${method} ${endpoint} → ${res.status}`);
      }

      return text ? JSON.parse(text) : {};
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ─── PHONE NORMALIZATION ───────────────────────────────────────
export function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(phone).startsWith('+')) return phone;
  return `+${digits}`;
}

// ─── CONTACTS ─────────────────────────────────────────────────

export async function findContactByPhone(phone) {
  try {
    const normalized = normalizePhone(phone);
    const data = await ghl('GET',
      `/contacts/search/duplicate?locationId=${LOCATION_ID}&phone=${encodeURIComponent(normalized)}`
    );
    return data?.contact || null;
  } catch { return null; }
}

export async function findContactByEmail(email) {
  try {
    const data = await ghl('GET',
      `/contacts/search/duplicate?locationId=${LOCATION_ID}&email=${encodeURIComponent(email)}`
    );
    return data?.contact || null;
  } catch { return null; }
}

export async function searchContacts(query) {
  try {
    const data = await ghl('GET',
      `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(query)}&limit=20`
    );
    return data?.contacts || [];
  } catch { return []; }
}

export async function getContact(contactId) {
  try {
    const data = await ghl('GET', `/contacts/${contactId}`);
    return data?.contact || null;
  } catch { return null; }
}

export async function createContact(params) {
  const body = {
    locationId:  LOCATION_ID,
    firstName:   params.firstName || (params.name || '').split(' ')[0] || 'Unknown',
    lastName:    params.lastName  || (params.name || '').split(' ').slice(1).join(' ') || '',
    name:        params.name      || `${params.firstName || ''} ${params.lastName || ''}`.trim(),
    phone:       normalizePhone(params.phone),
    email:       params.email     || undefined,
    companyName: params.company   || params.companyName || undefined,
    address1:    params.address   || undefined,
    city:        params.city      || undefined,
    state:       params.state     || 'FL',
    country:     params.country   || 'US',
    postalCode:  params.zip       || undefined,
    website:     params.website   || undefined,
    source:      params.source    || 'API',
    tags:        params.tags      || [],
    customFields: params.customFields || [],
  };

  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const data = await ghl('POST', '/contacts/', body);
  const contact = data?.contact || data;

  console.log(`[GHL] ✅ Contact created: ${params.name || params.phone} (${contact?.id})`);
  return contact;
}

export async function updateContact(contactId, updates) {
  const data = await ghl('PUT', `/contacts/${contactId}`, updates);
  return data?.contact || data;
}

export async function getOrCreateContact(phone, extraData = {}) {
  let contact = null;
  let isNew   = false;

  if (phone) contact = await findContactByPhone(phone);
  if (!contact && extraData.email) contact = await findContactByEmail(extraData.email);

  if (!contact) {
    contact = await createContact({ phone, ...extraData });
    isNew   = true;
  } else {
    const updates = {};
    if (extraData.email   && !contact.email)       updates.email       = extraData.email;
    if (extraData.name    && !contact.name)         updates.name        = extraData.name;
    if (extraData.company && !contact.companyName)  updates.companyName = extraData.company;
    if (extraData.website && !contact.website)      updates.website     = extraData.website;
    if (Object.keys(updates).length > 0) await updateContact(contact.id, updates);
  }

  return { contact, isNew };
}

export async function addTags(contactId, tags = []) {
  try {
    await ghl('POST', `/contacts/${contactId}/tags`, { tags });
    console.log(`[GHL] ✅ Tags added to ${contactId}: ${tags.join(', ')}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[GHL] Tag warning: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export async function removeTags(contactId, tags = []) {
  try {
    await ghl('DELETE', `/contacts/${contactId}/tags`, { tags });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function addNote(contactId, body) {
  try {
    await ghl('POST', `/contacts/${contactId}/notes`, { userId: '', body });
    return { ok: true };
  } catch (e) {
    console.warn(`[GHL] Note warning: ${e.message}`);
    return { ok: false };
  }
}

export async function addTask(contactId, params) {
  try {
    await ghl('POST', `/contacts/${contactId}/tasks`, {
      title:      params.title,
      dueDate:    params.dueDate || new Date(Date.now() + 86400000).toISOString(),
      status:     'incompleted',
      assignedTo: params.assignedTo || '',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getContacts(filters = {}) {
  try {
    let url = `/contacts/?locationId=${LOCATION_ID}&limit=${filters.limit || 100}`;
    if (filters.tag)   url += `&tags=${encodeURIComponent(filters.tag)}`;
    if (filters.query) url += `&query=${encodeURIComponent(filters.query)}`;
    if (filters.page)  url += `&startAfter=${filters.page}`;
    const data = await ghl('GET', url);
    return data?.contacts || [];
  } catch { return []; }
}

// ─── PIPELINE & OPPORTUNITIES ──────────────────────────────────

export async function getPipelines() {
  try {
    const data = await ghl('GET', `/opportunities/pipelines?locationId=${LOCATION_ID}`);
    return data?.pipelines || [];
  } catch { return []; }
}

export async function getPipelineId(name = 'Gorilla Rental') {
  const pipelines = await getPipelines();
  const pipeline  = pipelines.find(p =>
    p.name.toLowerCase().includes(name.toLowerCase())
  );
  return pipeline?.id || null;
}

export async function getPipelineStages(pipelineId) {
  try {
    const data = await ghl('GET', `/opportunities/pipelines?locationId=${LOCATION_ID}`);
    const pipeline = (data?.pipelines || []).find(p => p.id === pipelineId);
    return pipeline?.stages || [];
  } catch { return []; }
}

export async function createOpportunity(params) {
  try {
    let pipelineId = params.pipelineId;
    if (!pipelineId) pipelineId = await getPipelineId('Gorilla Rental');

    let stageId = params.stageId;
    if (!stageId && pipelineId) {
      const stages = await getPipelineStages(pipelineId);
      stageId = stages[0]?.id || '';
    }

    const data = await ghl('POST', '/opportunities/', {
      locationId:      LOCATION_ID,
      name:            params.name || `${params.contactName} — Inquiry`,
      contactId:       params.contactId,
      pipelineId,
      pipelineStageId: stageId,
      status:          params.status  || 'open',
      monetaryValue:   params.value   || 0,
      assignedTo:      params.assignedTo || '',
      customFields:    params.customFields || [],
    });

    console.log(`[GHL] ✅ Opportunity created: ${params.name}`);
    return data?.opportunity || data;
  } catch (e) {
    console.warn(`[GHL] Opportunity warning: ${e.message}`);
    return null;
  }
}

export async function updateOpportunityStage(opportunityId, stageId) {
  try {
    await ghl('PUT', `/opportunities/${opportunityId}`, { pipelineStageId: stageId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getOpportunities(filters = {}) {
  try {
    let url = `/opportunities/search?location_id=${LOCATION_ID}&limit=${filters.limit || 50}`;
    if (filters.pipelineId) url += `&pipeline_id=${filters.pipelineId}`;
    if (filters.stageId)    url += `&pipeline_stage_id=${filters.stageId}`;
    if (filters.status)     url += `&status=${filters.status}`;
    const data = await ghl('GET', url);
    return data?.opportunities || [];
  } catch { return []; }
}

// ─── CONVERSATIONS & SMS ───────────────────────────────────────

export async function getOrCreateConversation(contactId) {
  try {
    const search = await ghl('GET',
      `/conversations/search?locationId=${LOCATION_ID}&contactId=${contactId}`
    );
    const existing = search?.conversations?.[0];
    if (existing?.id) return existing.id;
  } catch {}

  try {
    const created = await ghl('POST', '/conversations/', {
      locationId: LOCATION_ID,
      contactId,
    });
    return created?.conversation?.id || created?.id;
  } catch (e) {
    console.warn(`[GHL] Conversation warning: ${e.message}`);
    return null;
  }
}

export async function sendSMS(to, body, contactData = {}, fromNumber = null) {
  const phone = normalizePhone(to);
  const from  = fromNumber || PHONES.main;

  try {
    const { contact } = await getOrCreateContact(phone, contactData);
    if (!contact?.id) throw new Error(`Could not resolve contact for ${phone}`);

    const conversationId = await getOrCreateConversation(contact.id);
    if (!conversationId) throw new Error(`Could not resolve conversation`);

    const message = await ghl('POST', '/conversations/messages', {
      type:           'SMS',
      conversationId,
      locationId:     LOCATION_ID,
      contactId:      contact.id,
      message:        body,
      fromNumber:     from,
    });

    console.log(`[GHL] ✅ SMS → ${phone} from ${from}`);
    return {
      ok:             true,
      messageId:      message?.messageId,
      conversationId,
      contactId:      contact.id,
      to:             phone,
      from,
    };
  } catch (e) {
    console.error(`[GHL] ❌ SMS failed → ${phone}: ${e.message}`);
    return { ok: false, error: e.message, to: phone };
  }
}

export async function sendChipSMS(to, body, contactData = {}) {
  return sendSMS(to, body, contactData, PHONES.chip);
}

export async function sendWhatsApp(to, body, contactData = {}) {
  const phone = normalizePhone(to);

  try {
    const { contact } = await getOrCreateContact(phone, contactData);
    if (!contact?.id) throw new Error(`Could not resolve contact`);

    const conversationId = await getOrCreateConversation(contact.id);
    if (!conversationId) throw new Error(`Could not resolve conversation`);

    const message = await ghl('POST', '/conversations/messages', {
      type:           'WhatsApp',
      conversationId,
      locationId:     LOCATION_ID,
      contactId:      contact.id,
      message:        body,
    });

    console.log(`[GHL] ✅ WhatsApp → ${phone}`);
    return { ok: true, messageId: message?.messageId, to: phone };
  } catch (e) {
    console.error(`[GHL] ❌ WhatsApp failed → ${phone}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export async function getConversationMessages(conversationId, limit = 20) {
  try {
    const data = await ghl('GET',
      `/conversations/${conversationId}/messages?limit=${limit}`
    );
    return data?.messages || [];
  } catch { return []; }
}

export async function getRecentConversations(limit = 50) {
  try {
    const data = await ghl('GET',
      `/conversations/search?locationId=${LOCATION_ID}&limit=${limit}&sort=desc&sortBy=last_message_date`
    );
    return data?.conversations || [];
  } catch { return []; }
}

// ─── AUTOMATION TRIGGERS ───────────────────────────────────────

export async function triggerAutomation(contactId, tag) {
  await addTags(contactId, [tag]);
  console.log(`[GHL] ✅ Automation triggered: tag "${tag}" added to ${contactId}`);
  return { ok: true, contactId, tag };
}

export async function triggerColdOutreach(contactId) {
  return triggerAutomation(contactId, 'Gorilla Rental — New Lead - Cold Outreach');
}

export async function triggerWorkflow(contactId, workflowId) {
  try {
    await ghl('POST', `/contacts/${contactId}/workflow/${workflowId}`, {
      eventStartTime: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    console.warn(`[GHL] Workflow trigger warning: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── GHL DATA & REPORTING ─────────────────────────────────────

export async function getGHLSnapshot() {
  try {
    const [allContacts, opportunities, recentConversations] = await Promise.all([
      getContacts({ limit: 100 }),
      getOpportunities({ limit: 50 }),
      getRecentConversations(20),
    ]);

    const tagCounts = {};
    for (const contact of allContacts) {
      for (const tag of contact.tags || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    const byStage = {};
    let totalValue = 0;
    for (const opp of opportunities) {
      const stage = opp.pipelineStage?.name || 'Unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
      totalValue += opp.monetaryValue || 0;
    }

    const yesterday = new Date(Date.now() - 86400000);
    const recentMessages = recentConversations.filter(c =>
      new Date(c.lastMessageDate) >= yesterday
    );

    return {
      contacts: {
        total:  allContacts.length,
        byTag:  tagCounts,
        recent: allContacts.filter(c => new Date(c.dateAdded) >= yesterday).length,
      },
      pipeline: {
        total:      opportunities.length,
        byStage,
        totalValue,
        open:  opportunities.filter(o => o.status === 'open').length,
        won:   opportunities.filter(o => o.status === 'won').length,
      },
      conversations: {
        total:  recentConversations.length,
        active: recentMessages.length,
        recent: recentMessages.slice(0, 5).map(c => ({
          contact:     c.contactName || c.fullName,
          lastMessage: c.lastMessageBody?.slice(0, 60),
          time:        c.lastMessageDate,
          unread:      c.unreadCount || 0,
        })),
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[GHL] Snapshot error:', e.message);
    return { error: e.message };
  }
}

export async function generateGHLBriefing() {
  const snapshot = await getGHLSnapshot();
  if (snapshot.error) return `GHL snapshot unavailable: ${snapshot.error}`;

  const lines = [
    `📊 GHL CRM SNAPSHOT`,
    ``,
    `👥 CONTACTS: ${snapshot.contacts.total} total | ${snapshot.contacts.recent} new today`,
    `Tags: ${Object.entries(snapshot.contacts.byTag).map(([t,c]) => `${t}(${c})`).join(', ') || 'none'}`,
    ``,
    `💼 PIPELINE: ${snapshot.pipeline.open} open | $${snapshot.pipeline.totalValue.toFixed(2)} total value`,
    `Stages: ${Object.entries(snapshot.pipeline.byStage).map(([s,c]) => `${s}(${c})`).join(', ') || 'none'}`,
    ``,
    `💬 CONVERSATIONS: ${snapshot.conversations.active} active in last 24h`,
  ];

  if (snapshot.conversations.recent.length > 0) {
    lines.push(`Recent:`);
    for (const c of snapshot.conversations.recent) {
      lines.push(`  • ${c.contact}: "${c.lastMessage}" ${c.unread > 0 ? `(${c.unread} unread)` : ''}`);
    }
  }

  return lines.join('\n');
}

// ─── SOCIAL PLANNER ───────────────────────────────────────────

export async function getGHLSocialAccounts() {
  try {
    const data = await ghl('GET', `/social-media-posting/${LOCATION_ID}/accounts`);
    return data?.results?.accounts || [];
  } catch (e) {
    console.warn(`[GHL] Social accounts warning: ${e.message}`);
    return [];
  }
}

// userId for the location owner (Andrei)
const GHL_OWNER_USER_ID = 'JipNwuPok4nvD4pwoKcH';

export async function scheduleGHLSocialPost({ summary, scheduleDate = null, accountIds = null }) {
  try {
    if (!accountIds) {
      const accounts = await getGHLSocialAccounts();
      // Exclude Google Business (different API) and expired/deleted
      // Also exclude Instagram/TikTok for text-only posts (they require media)
      const social = accounts.filter(a =>
        a.platform === 'facebook' && !a.isExpired && !a.deleted
      );
      if (!social.length) throw new Error('No connected Facebook account found in GHL Social Planner');
      accountIds = social.map(a => a.id);
    }

    const body = {
      summary,
      type: 'post',
      status: scheduleDate ? 'scheduled' : 'published',
      userId: GHL_OWNER_USER_ID,
      accountIds,
      media: [],
    };
    if (scheduleDate) body.scheduleDate = scheduleDate;

    const data = await ghl('POST', `/social-media-posting/${LOCATION_ID}/posts`, body);
    console.log(`[GHL] ✅ Social post ${scheduleDate ? 'scheduled' : 'published'}`);
    return { ok: true, post: data };
  } catch (e) {
    console.warn(`[GHL] Social post warning: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── LEGACY ALIASES ───────────────────────────────────────────
export async function addTag(contactId, tags = []) {
  return addTags(contactId, tags);
}

export async function upsertOpportunity(params) {
  return createOpportunity(params);
}

// ─── EXPRESS ROUTES ────────────────────────────────────────────
export function ghlRoutes(app) {
  app.get('/ghl/snapshot', async (req, res) => {
    try {
      const snapshot = await getGHLSnapshot();
      res.json({ ok: true, snapshot });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ghl/contacts', async (req, res) => {
    try {
      const contacts = await getContacts(req.query);
      res.json({ ok: true, contacts, total: contacts.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ghl/contacts', async (req, res) => {
    try {
      const contact = await createContact(req.body);
      res.json({ ok: true, contact });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ghl/contacts/:id/tags', async (req, res) => {
    try {
      await addTags(req.params.id, req.body.tags);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ghl/contacts/:id/notes', async (req, res) => {
    try {
      await addNote(req.params.id, req.body.body);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ghl/sms', async (req, res) => {
    try {
      const result = await sendSMS(
        req.body.to,
        req.body.message,
        req.body.contactData || {},
        req.body.from || null
      );
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ghl/pipelines', async (req, res) => {
    try {
      const pipelines = await getPipelines();
      res.json({ ok: true, pipelines });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ghl/opportunities', async (req, res) => {
    try {
      const opportunities = await getOpportunities(req.query);
      res.json({ ok: true, opportunities, total: opportunities.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/ghl/trigger', async (req, res) => {
    try {
      const result = await triggerAutomation(req.body.contactId, req.body.tag);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ghl/conversations', async (req, res) => {
    try {
      const conversations = await getRecentConversations(parseInt(req.query.limit) || 50);
      res.json({ ok: true, conversations, total: conversations.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/ghl/briefing', async (req, res) => {
    try {
      const briefing = await generateGHLBriefing();
      res.json({ ok: true, briefing });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[GHL] ✅ Routes registered');
}

export { PHONES, LOCATION_ID, GHL_API };
