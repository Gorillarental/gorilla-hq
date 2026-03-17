// ============================================================
// GHL.JS — GoHighLevel SMS + Contact + Conversation helper
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

const GHL_API     = 'https://services.leadconnectorhq.com';
const API_KEY     = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

const GHL_HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type':  'application/json',
  'Version':       '2021-04-15',
};

async function ghl(method, path, body = null) {
  const opts = { method, headers: GHL_HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${GHL_API}${path}`, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function findContactByPhone(phone) {
  const normalized = normalizePhone(phone);
  try {
    const data = await ghl('GET', `/contacts/search/duplicate?locationId=${LOCATION_ID}&phone=${encodeURIComponent(normalized)}`);
    return data?.contact || null;
  } catch { return null; }
}

export async function createContact(params) {
  const contact = await ghl('POST', '/contacts/', {
    locationId: LOCATION_ID,
    firstName:  params.firstName || params.name?.split(' ')[0] || 'Unknown',
    lastName:   params.lastName  || params.name?.split(' ').slice(1).join(' ') || '',
    name:       params.name || '',
    phone:      normalizePhone(params.phone),
    email:      params.email || undefined,
    tags:       params.tags  || ['gorilla-rental'],
    source:     params.source || 'API',
  });
  return contact?.contact || contact;
}

export async function getOrCreateContact(phone, extraData = {}) {
  let contact = await findContactByPhone(phone);
  let isNew   = false;
  if (!contact) {
    contact = await createContact({ phone, ...extraData });
    isNew   = true;
  }
  return { contact, isNew };
}

export async function updateContact(contactId, updates) {
  return ghl('PUT', `/contacts/${contactId}`, updates);
}

export async function getOrCreateConversation(contactId) {
  try {
    const search = await ghl('GET', `/conversations/search?locationId=${LOCATION_ID}&contactId=${contactId}`);
    const existing = search?.conversations?.[0];
    if (existing?.id) return existing.id;
  } catch {}
  const created = await ghl('POST', '/conversations/', { locationId: LOCATION_ID, contactId });
  return created?.conversation?.id || created?.id;
}

export async function sendSMS(to, body, contactData = {}) {
  const phone = normalizePhone(to);
  try {
    const { contact } = await getOrCreateContact(phone, {
      name:  contactData.name  || 'Unknown',
      email: contactData.email,
      tags:  contactData.tags  || ['gorilla-rental'],
    });
    if (!contact?.id) throw new Error(`Could not resolve contact for ${phone}`);
    const conversationId = await getOrCreateConversation(contact.id);
    if (!conversationId) throw new Error(`Could not resolve conversation for ${contact.id}`);
    const message = await ghl('POST', '/conversations/messages', {
      type:           'SMS',
      conversationId,
      locationId:     LOCATION_ID,
      contactId:      contact.id,
      message:        body,
    });
    console.log(`[GHL] ✅ SMS → ${phone} (${message?.messageId || 'ok'})`);
    return { ok: true, messageId: message?.messageId, conversationId, contactId: contact.id, to: phone };
  } catch (err) {
    console.error(`[GHL] ❌ SMS failed → ${phone}: ${err.message}`);
    return { ok: false, error: err.message, to: phone };
  }
}

export async function upsertOpportunity(params) {
  return ghl('POST', '/opportunities/', {
    locationId:    LOCATION_ID,
    name:          params.name   || params.jobId,
    contactId:     params.contactId,
    pipelineId:    params.pipelineId || process.env.GHL_PIPELINE_ID || '',
    stageId:       params.stageId    || process.env.GHL_STAGE_ID    || '',
    status:        params.status     || 'open',
    monetaryValue: params.value      || 0,
  });
}

export async function addNote(contactId, body) {
  return ghl('POST', `/contacts/${contactId}/notes`, { userId: '', body });
}

export async function addTag(contactId, tags = []) {
  return ghl('POST', `/contacts/${contactId}/tags`, { tags });
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

export { LOCATION_ID, GHL_API };
