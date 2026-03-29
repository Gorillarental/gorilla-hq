// ============================================================
// BOOQABLE.JS — Booqable Boomerang API Tool Layer
// All actions available to quote, ops, admin, finance agents
// Base URL: https://gorilla-rentals.booqable.com/api/boomerang
// Auth: Bearer token (BOOQABLE_API_KEY)
// ============================================================

import { CONFIG } from './config.js';
import { callWithBreaker } from './circuit-breaker.js';

function booqableHeaders() {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${CONFIG.BOOQABLE.API_KEY}`,
  };
}

// Core request helper — uses boomerang API base URL
async function bq(method, path, body) {
  return callWithBreaker('booqable', async () => {
    const url = `${CONFIG.BOOQABLE.BASE_URL}${path}`;
    const opts = { method, headers: booqableHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Booqable ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    return data;
  });
}

// Normalize boomerang JSON:API response to flat object(s)
// Boomerang wraps everything in { data: { id, type, attributes } }
// or { data: [ ... ] }. This helper returns plain objects the agents
// can work with, keyed the same as the old v1 API where practical.
function flattenResource(r) {
  if (!r) return null;
  return { id: r.id, type: r.type, ...r.attributes };
}

function flattenList(data) {
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(flattenResource);
}

// Helper: wrap boomerang single-record response as { [resourceName]: flat }
function wrapOne(data, key) {
  const item = flattenResource(data?.data);
  if (!item) return {};
  return key ? { [key]: item } : item;
}

// Helper: wrap boomerang list response as { [pluralKey]: flat[] }
function wrapMany(data, key) {
  const items = flattenList(data?.data);
  return key ? { [key]: items } : items;
}

// ─── Customers ─────────────────────────────────────────────────
// Boomerang: POST/GET/PATCH /customers  (JSON:API format)
// Filter by email: GET /customers?filter[conditions][0][attribute]=email&filter[conditions][0][value]=...
// Filter by name:  GET /customers?filter[conditions][0][attribute]=name&filter[conditions][0][value]=...

export async function BOOQABLE_CREATE_CUSTOMER({ name, email, phone, address1, city, zipcode, country_code, deposit_type, deposit_value }) {
  const attrs = {};
  if (name)         attrs.name         = name;
  if (email)        attrs.email        = email;
  if (phone)        attrs.phone        = phone;
  if (address1)     attrs.address1     = address1;
  if (city)         attrs.city         = city;
  if (zipcode)      attrs.zipcode      = zipcode;
  if (country_code) attrs.country_code = country_code;
  if (deposit_type) attrs.deposit_type = deposit_type;
  if (deposit_value !== undefined) attrs.deposit_value = deposit_value;
  const data = await bq('POST', '/customers', {
    data: { type: 'customers', attributes: attrs },
  });
  return wrapOne(data, 'customer');
}

export async function BOOQABLE_GET_CUSTOMER({ id }) {
  const data = await bq('GET', `/customers/${id}`);
  return wrapOne(data, 'customer');
}

export async function BOOQABLE_GET_CUSTOMERS({ per_page = 100, page = 1 } = {}) {
  const data = await bq('GET', `/customers?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'customers');
}

export async function BOOQABLE_SEARCH_CUSTOMERS({ q, per_page = 25, page = 1 } = {}) {
  // Boomerang supports filter[q] for text search across name/email
  const params = new URLSearchParams({
    'filter[q]': q || '',
    'page[number]': page,
    'page[size]': per_page,
  });
  const data = await bq('GET', `/customers?${params}`);
  return wrapMany(data, 'customers');
}

export async function BOOQABLE_SEARCH_CUSTOMERS_BY_EMAIL({ email }) {
  const params = new URLSearchParams({
    'filter[conditions][0][attribute]': 'email',
    'filter[conditions][0][value]': email,
    'page[size]': 5,
  });
  const data = await bq('GET', `/customers?${params}`);
  return wrapMany(data, 'customers');
}

export async function BOOQABLE_SEARCH_CUSTOMERS_BY_NAME({ name }) {
  const params = new URLSearchParams({
    'filter[conditions][0][attribute]': 'name',
    'filter[conditions][0][value]': name,
    'page[size]': 10,
  });
  const data = await bq('GET', `/customers?${params}`);
  return wrapMany(data, 'customers');
}

export async function BOOQABLE_DELETE_CUSTOMER({ id }) {
  return bq('DELETE', `/customers/${id}`);
}

// ─── Customer match scoring ─────────────────────────────────────
// Returns a confidence score: >=40 means a meaningful match.
// Email exact match = 100, full name exact = 80, contains = 30-40,
// first/last name partial = 20-25.
function scoreCustomerMatch(customer, searchName, searchEmail) {
  let score = 0;
  const cName  = (customer.name  || '').toLowerCase().trim();
  const cEmail = (customer.email || '').toLowerCase().trim();
  const sName  = (searchName  || '').toLowerCase().trim();
  const sEmail = (searchEmail || '').toLowerCase().trim();

  // Email exact match = highest confidence
  if (sEmail && cEmail === sEmail) score += 100;

  // Full name exact match
  if (sName && cName === sName) score += 80;

  // Full name contains (both directions) — only if name is long enough (>4 chars)
  if (sName && sName.length > 4) {
    if (cName.includes(sName)) score += 40;
    if (sName.includes(cName) && cName.length > 4) score += 30;
  }

  // First name match (only if first name is >3 chars to avoid "Bob" matching everything)
  const nameParts = sName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ');
  if (firstName.length > 3 && cName.startsWith(firstName)) score += 20;
  if (lastName.length  > 3 && cName.includes(lastName))    score += 25;

  return score;
}

// ─── Find-or-confirm customer (always search before creating) ──
//
// Returns one of:
//   { found: false }                                    → safe to create
//   { found: true, customer, requiresConfirmation: true } → ask user first
//   { found: true, customers: [...], requiresConfirmation: true } → multiple matches
//
export async function findOrConfirmCustomer({ name, email }) {
  const MATCH_THRESHOLD = 40;

  // Step 1: Search by email using boomerang filter endpoint
  if (email) {
    try {
      const byEmail = await BOOQABLE_SEARCH_CUSTOMERS_BY_EMAIL({ email });
      const customers = byEmail?.customers || [];
      const scored = customers
        .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
        .filter(({ score }) => score >= MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        console.log(`[Booqable] Email match score: ${scored[0].score} for ${scored[0].c.name}`);
        return { found: true, customer: scored[0].c, requiresConfirmation: true };
      }
      // Also try general search with email as query
      const byQ = await BOOQABLE_SEARCH_CUSTOMERS({ q: email, per_page: 5 });
      const qScored = (byQ?.customers || [])
        .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
        .filter(({ score }) => score >= MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      if (qScored.length) {
        console.log(`[Booqable] Email Q-match score: ${qScored[0].score} for ${qScored[0].c.name}`);
        return { found: true, customer: qScored[0].c, requiresConfirmation: true };
      }
    } catch (e) {
      console.warn('[Booqable] Email search error:', e.message);
    }
  }

  if (name) {
    // Step 2: Search by full name
    try {
      const byFullName = await BOOQABLE_SEARCH_CUSTOMERS_BY_NAME({ name });
      const customers = byFullName?.customers || [];
      if (customers.length) {
        const scored = customers
          .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
          .filter(({ score }) => score >= MATCH_THRESHOLD)
          .sort((a, b) => b.score - a.score);
        if (scored.length > 1) {
          console.log(`[Booqable] Name search: ${scored.length} matches, top score ${scored[0].score}`);
          return { found: true, customers: scored.map(s => s.c), requiresConfirmation: true };
        }
        if (scored.length === 1) {
          console.log(`[Booqable] Name match score: ${scored[0].score} for ${scored[0].c.name}`);
          return { found: true, customer: scored[0].c, requiresConfirmation: true };
        }
      }
    } catch (e) {
      console.warn('[Booqable] Name search error:', e.message);
    }

    // Step 3: General text search by full name
    try {
      const byQ = await BOOQABLE_SEARCH_CUSTOMERS({ q: name, per_page: 10 });
      const customers = byQ?.customers || [];
      if (customers.length) {
        const scored = customers
          .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
          .filter(({ score }) => score >= MATCH_THRESHOLD)
          .sort((a, b) => b.score - a.score);
        if (scored.length > 1) {
          return { found: true, customers: scored.map(s => s.c), requiresConfirmation: true };
        }
        if (scored.length === 1) {
          console.log(`[Booqable] Q-search match score: ${scored[0].score} for ${scored[0].c.name}`);
          return { found: true, customer: scored[0].c, requiresConfirmation: true };
        }
      }
    } catch {}

    // Step 4: Search by first name only
    const firstName = name.trim().split(' ')[0];
    if (firstName && firstName.length >= 3) {
      try {
        const byFirst = await BOOQABLE_SEARCH_CUSTOMERS({ q: firstName, per_page: 10 });
        const customers = byFirst?.customers || [];
        if (customers.length) {
          const scored = customers
            .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
            .filter(({ score }) => score >= MATCH_THRESHOLD)
            .sort((a, b) => b.score - a.score);
          if (scored.length > 1) {
            return { found: true, customers: scored.map(s => s.c), requiresConfirmation: true };
          }
          if (scored.length === 1) {
            console.log(`[Booqable] First-name match score: ${scored[0].score} for ${scored[0].c.name}`);
            return { found: true, customer: scored[0].c, requiresConfirmation: true };
          }
        }
      } catch {}
    }

    // Step 5: Search by last name only
    const parts = name.trim().split(' ');
    if (parts.length > 1) {
      const lastName = parts[parts.length - 1];
      if (lastName.length >= 3) {
        try {
          const byLast = await BOOQABLE_SEARCH_CUSTOMERS({ q: lastName, per_page: 10 });
          const customers = byLast?.customers || [];
          if (customers.length) {
            const scored = customers
              .map(c => ({ c, score: scoreCustomerMatch(c, name, email) }))
              .filter(({ score }) => score >= MATCH_THRESHOLD)
              .sort((a, b) => b.score - a.score);
            if (scored.length > 1) {
              return { found: true, customers: scored.map(s => s.c), requiresConfirmation: true };
            }
            if (scored.length === 1) {
              console.log(`[Booqable] Last-name match score: ${scored[0].score} for ${scored[0].c.name}`);
              return { found: true, customer: scored[0].c, requiresConfirmation: true };
            }
          }
        } catch {}
      }
    }
  }

  return { found: false };
}

// Exposed as a tool so agents can call it
export async function BOOQABLE_FIND_OR_CONFIRM_CUSTOMER({ name, email }) {
  return findOrConfirmCustomer({ name, email });
}

// ─── Orders ────────────────────────────────────────────────────
// Boomerang: POST /orders  body: { data: { type: "orders", attributes: { customer_id, starts_at, stops_at, status: "concept" } } }
// Boomerang: PATCH /orders/:id  body: { data: { id, type: "orders", attributes: { ... } } }

export async function BOOQABLE_CREATE_ORDER({ customer_id, starts_at, stops_at, tag_list, note, location_id, deposit_type, deposit_value, status = 'concept' }) {
  const attrs = { status };
  if (customer_id)   attrs.customer_id   = customer_id;
  if (starts_at)     attrs.starts_at     = starts_at;
  if (stops_at)      attrs.stops_at      = stops_at;
  if (tag_list)      attrs.tag_list      = Array.isArray(tag_list) ? tag_list.join(',') : tag_list;
  if (note)          attrs.note          = note;
  if (location_id)   attrs.location_id   = location_id;
  if (deposit_type)  attrs.deposit_type  = deposit_type;
  if (deposit_value !== undefined) attrs.deposit_value = deposit_value;
  const data = await bq('POST', '/orders', {
    data: { type: 'orders', attributes: attrs },
  });
  return wrapOne(data, 'order');
}

export async function BOOQABLE_UPDATE_ORDER({ id, status, starts_at, stops_at, note, tag_list }) {
  const attrs = {};
  if (status)    attrs.status    = status;
  if (starts_at) attrs.starts_at = starts_at;
  if (stops_at)  attrs.stops_at  = stops_at;
  if (note)      attrs.note      = note;
  if (tag_list)  attrs.tag_list  = Array.isArray(tag_list) ? tag_list.join(',') : tag_list;
  const data = await bq('PATCH', `/orders/${id}`, {
    data: { id, type: 'orders', attributes: attrs },
  });
  return wrapOne(data, 'order');
}

export async function BOOQABLE_GET_ORDER({ id, include } = {}) {
  const qs = include ? `?include=${encodeURIComponent(include)}` : '';
  const data = await bq('GET', `/orders/${id}${qs}`);
  return wrapOne(data, 'order');
}

export async function BOOQABLE_GET_NEW_ORDER() {
  const data = await bq('GET', '/orders/new');
  return wrapOne(data, 'order');
}

export async function BOOQABLE_LIST_ORDERS({ per_page = 25, page = 1, status, customer_id } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (status)      params.set('filter[status]', status);
  if (customer_id) params.set('filter[customer_id]', customer_id);
  const data = await bq('GET', `/orders?${params}`);
  return wrapMany(data, 'orders');
}

export async function BOOQABLE_SEARCH_ORDERS({ q, status, starts_at_gte, stops_at_lte, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q)             params.set('filter[q]', q);
  if (status)        params.set('filter[status]', status);
  if (starts_at_gte) params.set('filter[starts_at][gte]', starts_at_gte);
  if (stops_at_lte)  params.set('filter[stops_at][lte]', stops_at_lte);
  const data = await bq('GET', `/orders?${params}`);
  return wrapMany(data, 'orders');
}

export async function BOOQABLE_DELETE_ORDER({ id }) {
  return bq('DELETE', `/orders/${id}`);
}

// ─── Lines ─────────────────────────────────────────────────────
// Boomerang: POST /lines  body: { data: { type: "lines", attributes: { order_id, item_id, quantity, starts_at, stops_at } } }

export async function BOOQABLE_CREATE_LINE({ order_id, item_id, product_id, quantity = 1, starts_at, stops_at }) {
  const attrs = { order_id, quantity };
  if (item_id)    attrs.item_id    = item_id;
  if (product_id) attrs.item_id    = product_id; // boomerang uses item_id for both
  if (starts_at)  attrs.starts_at  = starts_at;
  if (stops_at)   attrs.stops_at   = stops_at;
  const data = await bq('POST', '/lines', {
    data: { type: 'lines', attributes: attrs },
  });
  return wrapOne(data, 'line');
}

export async function BOOQABLE_LIST_LINES({ order_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id) params.set('filter[order_id]', order_id);
  const data = await bq('GET', `/lines?${params}`);
  return wrapMany(data, 'lines');
}

// ─── Products & Product Groups ─────────────────────────────────

export async function BOOQABLE_CREATE_PRODUCT_GROUP({ name, slug, sku, description, tag_list, tax_category_id, price_type, price_period, base_price_in_cents, flat_fee_price_in_cents, show_in_store, trackable, lag_time, lead_time }) {
  const attrs = {};
  if (name)                    attrs.name                    = name;
  if (slug)                    attrs.slug                    = slug;
  if (sku)                     attrs.sku                     = sku;
  if (description)             attrs.description             = description;
  if (tag_list)                attrs.tag_list                = Array.isArray(tag_list) ? tag_list.join(',') : tag_list;
  if (tax_category_id)         attrs.tax_category_id         = tax_category_id;
  if (price_type)              attrs.price_type              = price_type;
  if (price_period)            attrs.price_period            = price_period;
  if (base_price_in_cents !== undefined)     attrs.base_price_in_cents     = base_price_in_cents;
  if (flat_fee_price_in_cents !== undefined) attrs.flat_fee_price_in_cents = flat_fee_price_in_cents;
  if (show_in_store !== undefined) attrs.show_in_store = show_in_store;
  if (trackable !== undefined)     attrs.trackable     = trackable;
  if (lag_time !== undefined)      attrs.lag_time      = lag_time;
  if (lead_time !== undefined)     attrs.lead_time     = lead_time;
  const data = await bq('POST', '/product_groups', {
    data: { type: 'product_groups', attributes: attrs },
  });
  return wrapOne(data, 'product_group');
}

export async function BOOQABLE_GET_PRODUCT_GROUP({ id }) {
  const data = await bq('GET', `/product_groups/${id}`);
  return wrapOne(data, 'product_group');
}

export async function BOOQABLE_LIST_PRODUCT_GROUPS({ per_page = 100, page = 1, tag } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (tag) params.set('filter[tag_list]', tag);
  const data = await bq('GET', `/product_groups?${params}`);
  return wrapMany(data, 'product_groups');
}

export async function BOOQABLE_DELETE_PRODUCT_GROUP({ id }) {
  return bq('DELETE', `/product_groups/${id}`);
}

export async function BOOQABLE_GET_PRODUCT({ id }) {
  const data = await bq('GET', `/products/${id}`);
  return wrapOne(data, 'product');
}

export async function BOOQABLE_LIST_PRODUCTS({ product_group_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (product_group_id) params.set('filter[product_group_id]', product_group_id);
  const data = await bq('GET', `/products?${params}`);
  return wrapMany(data, 'products');
}

export async function BOOQABLE_SEARCH_PRODUCTS({ q, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q) params.set('filter[q]', q);
  const data = await bq('GET', `/products?${params}`);
  return wrapMany(data, 'products');
}

// ─── Items ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_ITEMS({ q, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q)    params.set('filter[q]', q);
  if (type) params.set('filter[type]', type);
  const data = await bq('GET', `/items?${params}`);
  return wrapMany(data, 'items');
}

export async function BOOQABLE_SEARCH_ITEMS({ q, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q) params.set('filter[q]', q);
  const data = await bq('GET', `/items?${params}`);
  return wrapMany(data, 'items');
}

// ─── Inventory ─────────────────────────────────────────────────
// Boomerang availability check: GET /availability  (date range + product)

export async function BOOQABLE_GET_INVENTORY_LEVELS({ product_id, from, till, location_id } = {}) {
  const params = new URLSearchParams();
  if (product_id)  params.set('filter[product_id]', product_id);
  if (from)        params.set('filter[from]', from);
  if (till)        params.set('filter[till]', till);
  if (location_id) params.set('filter[location_id]', location_id);
  try {
    const data = await bq('GET', `/inventory?${params}`);
    return wrapMany(data, 'inventory');
  } catch {
    // fallback: try availability endpoint
    const data = await bq('GET', `/availability?${params}`);
    return wrapMany(data, 'inventory');
  }
}

export async function BOOQABLE_LIST_INVENTORY_BREAKDOWNS({ product_id, from, till, location_id } = {}) {
  const params = new URLSearchParams();
  if (product_id)  params.set('filter[product_id]', product_id);
  if (from)        params.set('filter[from]', from);
  if (till)        params.set('filter[till]', till);
  if (location_id) params.set('filter[location_id]', location_id);
  const data = await bq('GET', `/inventory_breakdowns?${params}`);
  return wrapMany(data, 'inventory_breakdowns');
}

// ─── Stock ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_STOCK_ITEMS({ product_group_id, product_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (product_group_id) params.set('filter[product_group_id]', product_group_id);
  if (product_id)       params.set('filter[product_id]', product_id);
  const data = await bq('GET', `/stock_items?${params}`);
  return wrapMany(data, 'stock_items');
}

export async function BOOQABLE_LIST_STOCK_ITEM_PLANNINGS({ order_id, product_id, starts_at, stops_at, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id)   params.set('filter[order_id]', order_id);
  if (product_id) params.set('filter[product_id]', product_id);
  if (starts_at)  params.set('filter[starts_at]', starts_at);
  if (stops_at)   params.set('filter[stops_at]', stops_at);
  const data = await bq('GET', `/stock_item_plannings?${params}`);
  return wrapMany(data, 'stock_item_plannings');
}

// ─── Plannings ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_PLANNINGS({ order_id, product_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id)   params.set('filter[order_id]', order_id);
  if (product_id) params.set('filter[product_id]', product_id);
  const data = await bq('GET', `/plannings?${params}`);
  return wrapMany(data, 'plannings');
}

export async function BOOQABLE_SEARCH_PLANNINGS({ starts_at_gte, stops_at_lte, product_id, location_id, per_page = 50, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (starts_at_gte) params.set('filter[starts_at][gte]', starts_at_gte);
  if (stops_at_lte)  params.set('filter[stops_at][lte]', stops_at_lte);
  if (product_id)    params.set('filter[product_id]', product_id);
  if (location_id)   params.set('filter[location_id]', location_id);
  const data = await bq('GET', `/plannings?${params}`);
  return wrapMany(data, 'plannings');
}

// ─── Availability check (high-level helper) ────────────────────
// Returns { available: bool, stockCount: N } for a product+daterange

export async function BOOQABLE_CHECK_AVAILABILITY({ product_id, starts_at, stops_at, quantity = 1 } = {}) {
  try {
    const params = new URLSearchParams({
      'filter[product_id]': product_id,
      'filter[starts_at]':  starts_at,
      'filter[stops_at]':   stops_at,
    });
    const data = await bq('GET', `/inventory?${params}`);
    const items = wrapMany(data, 'inventory').inventory || [];
    // boomerang inventory shows stock_count, planned_count, available_count
    const avail = items[0];
    if (!avail) return { available: false, stockCount: 0, error: 'No inventory data' };
    const availCount = avail.available_count ?? avail.stock_count ?? 0;
    return { available: availCount >= quantity, availableCount: availCount, stockCount: avail.stock_count };
  } catch (e) {
    return { available: null, error: e.message };
  }
}

// ─── Documents ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_DOCUMENTS({ order_id, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id) params.set('filter[order_id]', order_id);
  if (type)     params.set('filter[document_type]', type);
  const data = await bq('GET', `/documents?${params}`);
  return wrapMany(data, 'documents');
}

export async function BOOQABLE_SEARCH_DOCUMENTS({ q, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q)    params.set('filter[q]', q);
  if (type) params.set('filter[document_type]', type);
  const data = await bq('GET', `/documents?${params}`);
  return wrapMany(data, 'documents');
}

// ─── Payments ──────────────────────────────────────────────────

export async function BOOQABLE_LIST_PAYMENTS({ order_id, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id) params.set('filter[order_id]', order_id);
  const data = await bq('GET', `/payments?${params}`);
  return wrapMany(data, 'payments');
}

export async function BOOQABLE_LIST_PAYMENT_METHODS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/payment_methods?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'payment_methods');
}

// ─── Notes ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_NOTES({ notable_id, notable_type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (notable_id)   params.set('filter[notable_id]', notable_id);
  if (notable_type) params.set('filter[notable_type]', notable_type);
  const data = await bq('GET', `/notes?${params}`);
  return wrapMany(data, 'notes');
}

// ─── Locations ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_LOCATIONS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/locations?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'locations');
}

// ─── Users & Employees ─────────────────────────────────────────

export async function BOOQABLE_LIST_USERS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/users?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'users');
}

export async function BOOQABLE_LIST_EMPLOYEES({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/employees?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'employees');
}

// ─── Pricing ───────────────────────────────────────────────────

export async function BOOQABLE_LIST_PRICE_RULESETS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/price_rulesets?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'price_rulesets');
}

export async function BOOQABLE_LIST_PRICE_STRUCTURES({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/price_structures?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'price_structures');
}

export async function BOOQABLE_LIST_TAX_RATES({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/tax_rates?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'tax_rates');
}

export async function BOOQABLE_LIST_TAX_VALUES({ order_id, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (order_id) params.set('filter[order_id]', order_id);
  const data = await bq('GET', `/tax_values?${params}`);
  return wrapMany(data, 'tax_values');
}

export async function BOOQABLE_LIST_COUPONS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/coupons?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'coupons');
}

// ─── Bundles ───────────────────────────────────────────────────

export async function BOOQABLE_SEARCH_BUNDLES({ q, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (q) params.set('filter[q]', q);
  const data = await bq('GET', `/bundles?${params}`);
  return wrapMany(data, 'bundles');
}

export async function BOOQABLE_LIST_BUNDLE_ITEMS({ bundle_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (bundle_id) params.set('filter[bundle_id]', bundle_id);
  const data = await bq('GET', `/bundle_items?${params}`);
  return wrapMany(data, 'bundle_items');
}

// ─── Properties ────────────────────────────────────────────────

export async function BOOQABLE_LIST_PROPERTIES({ owner_id, owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (owner_id)   params.set('filter[owner_id]', owner_id);
  if (owner_type) params.set('filter[owner_type]', owner_type);
  const data = await bq('GET', `/properties?${params}`);
  return wrapMany(data, 'properties');
}

export async function BOOQABLE_LIST_DEFAULT_PROPERTIES({ owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (owner_type) params.set('filter[owner_type]', owner_type);
  const data = await bq('GET', `/default_properties?${params}`);
  return wrapMany(data, 'default_properties');
}

// ─── Misc ──────────────────────────────────────────────────────

export async function BOOQABLE_LIST_BARCODES({ owner_id, owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (owner_id)   params.set('filter[owner_id]', owner_id);
  if (owner_type) params.set('filter[owner_type]', owner_type);
  const data = await bq('GET', `/barcodes?${params}`);
  return wrapMany(data, 'barcodes');
}

export async function BOOQABLE_LIST_CLUSTERS({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/clusters?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'clusters');
}

export async function BOOQABLE_LIST_EMAIL_TEMPLATES({ per_page = 25, page = 1 } = {}) {
  const data = await bq('GET', `/email_templates?page[number]=${page}&page[size]=${per_page}`);
  return wrapMany(data, 'email_templates');
}

export async function BOOQABLE_LIST_PHOTOS({ owner_id, owner_type, per_page = 50, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (owner_id)   params.set('filter[owner_id]', owner_id);
  if (owner_type) params.set('filter[owner_type]', owner_type);
  const data = await bq('GET', `/photos?${params}`);
  return wrapMany(data, 'photos');
}

export async function BOOQABLE_LIST_PROVINCES({ country_code, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ 'page[number]': page, 'page[size]': per_page });
  if (country_code) params.set('filter[country_code]', country_code);
  const data = await bq('GET', `/provinces?${params}`);
  return wrapMany(data, 'provinces');
}

// ─── Company ───────────────────────────────────────────────────

export async function BOOQABLE_UPDATE_COMPANIES({ name, email, phone, website, timezone, currency, address1, city, zipcode, country_code, tax_percentage }) {
  const attrs = {};
  if (name)          attrs.name          = name;
  if (email)         attrs.email         = email;
  if (phone)         attrs.phone         = phone;
  if (website)       attrs.website       = website;
  if (timezone)      attrs.timezone      = timezone;
  if (currency)      attrs.currency      = currency;
  if (address1)      attrs.address1      = address1;
  if (city)          attrs.city          = city;
  if (zipcode)       attrs.zipcode       = zipcode;
  if (country_code)  attrs.country_code  = country_code;
  if (tax_percentage !== undefined) attrs.tax_percentage = tax_percentage;
  const data = await bq('PATCH', '/companies/current', {
    data: { type: 'companies', attributes: attrs },
  });
  return wrapOne(data, 'company');
}

// ─── Claude Tool Definitions ────────────────────────────────────
// Import BOOQABLE_TOOLS into any agent and pass to client.messages.create({ tools: BOOQABLE_TOOLS })
// Then call dispatchBooqableTool(toolName, toolInput) in your tool_use loop.

export const BOOQABLE_TOOLS = [
  {
    name: 'BOOQABLE_FIND_OR_CONFIRM_CUSTOMER',
    description: 'ALWAYS call this before BOOQABLE_CREATE_CUSTOMER. Searches Booqable by email, then full name, then partial name. Returns { found: false } if safe to create, or { found: true, customer, requiresConfirmation: true } if a match exists — in which case you MUST stop and ask the user whether to use the existing record or create a new one.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Full name to search' },
        email: { type: 'string', description: 'Email to search' },
      },
    },
  },
  {
    name: 'BOOQABLE_CREATE_CUSTOMER',
    description: 'Create a new customer in Booqable. ONLY call this after BOOQABLE_FIND_OR_CONFIRM_CUSTOMER returns { found: false }, or after the user explicitly confirms they want a new record.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Full name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        address1:     { type: 'string' },
        city:         { type: 'string' },
        zipcode:      { type: 'string' },
        country_code: { type: 'string', description: 'e.g. US' },
        deposit_type:  { type: 'string', enum: ['none', 'percentage', 'fixed'] },
        deposit_value: { type: 'number' },
      },
      required: ['name', 'email'],
    },
  },
  {
    name: 'BOOQABLE_GET_CUSTOMER',
    description: 'Get a single Booqable customer by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_GET_CUSTOMERS',
    description: 'List all Booqable customers (paginated).',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 100 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_CUSTOMERS',
    description: 'Search Booqable customers by name, email, or phone.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Search term' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
      required: ['q'],
    },
  },
  {
    name: 'BOOQABLE_DELETE_CUSTOMER',
    description: 'Delete a Booqable customer by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_CHECK_AVAILABILITY',
    description: 'Check whether a product is available for a given date range and quantity.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Booqable product ID' },
        starts_at:  { type: 'string', description: 'ISO 8601 datetime' },
        stops_at:   { type: 'string', description: 'ISO 8601 datetime' },
        quantity:   { type: 'number', description: 'Units needed', default: 1 },
      },
      required: ['product_id', 'starts_at', 'stops_at'],
    },
  },
  {
    name: 'BOOQABLE_CREATE_LINE',
    description: 'Add a line item (equipment) to an existing Booqable order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id:   { type: 'string', description: 'Booqable order ID' },
        item_id:    { type: 'string', description: 'Product or bundle ID' },
        product_id: { type: 'string', description: 'Alias for item_id' },
        quantity:   { type: 'number', default: 1 },
        starts_at:  { type: 'string', description: 'ISO 8601 datetime' },
        stops_at:   { type: 'string', description: 'ISO 8601 datetime' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'BOOQABLE_UPDATE_ORDER',
    description: 'Update an existing Booqable order (status, dates, note).',
    input_schema: {
      type: 'object',
      properties: {
        id:        { type: 'string', description: 'Order ID' },
        status:    { type: 'string', enum: ['concept', 'reserved', 'started', 'stopped', 'archived', 'canceled'] },
        starts_at: { type: 'string' },
        stops_at:  { type: 'string' },
        note:      { type: 'string' },
        tag_list:  { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'BOOQABLE_CREATE_ORDER',
    description: 'Create a new rental order in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id:   { type: 'string', description: 'Booqable customer ID' },
        starts_at:     { type: 'string', description: 'ISO 8601 datetime' },
        stops_at:      { type: 'string', description: 'ISO 8601 datetime' },
        tag_list:      { type: 'array', items: { type: 'string' } },
        note:          { type: 'string' },
        location_id:   { type: 'string' },
        deposit_type:  { type: 'string', enum: ['none', 'percentage', 'fixed'] },
        deposit_value: { type: 'number' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'BOOQABLE_GET_ORDER',
    description: 'Get a single Booqable order by ID.',
    input_schema: {
      type: 'object',
      properties: {
        id:      { type: 'string' },
        include: { type: 'string', description: 'Comma-separated relations to include, e.g. lines,customer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'BOOQABLE_GET_NEW_ORDER',
    description: 'Get a blank new-order template from Booqable.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'BOOQABLE_LIST_ORDERS',
    description: 'List Booqable orders, optionally filtered by status or customer.',
    input_schema: {
      type: 'object',
      properties: {
        per_page:    { type: 'number', default: 25 },
        page:        { type: 'number', default: 1 },
        status:      { type: 'string', enum: ['new', 'concept', 'reserved', 'started', 'stopped', 'archived', 'canceled'] },
        customer_id: { type: 'string' },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_ORDERS',
    description: 'Search Booqable orders by number, customer name, or date range.',
    input_schema: {
      type: 'object',
      properties: {
        q:             { type: 'string', description: 'Order number or customer name fragment' },
        status:        { type: 'string' },
        starts_at_gte: { type: 'string', description: 'ISO date, orders starting on or after' },
        stops_at_lte:  { type: 'string', description: 'ISO date, orders ending on or before' },
        per_page:      { type: 'number', default: 25 },
        page:          { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_DELETE_ORDER',
    description: 'Delete a Booqable order by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_CREATE_PRODUCT_GROUP',
    description: 'Create a new product group (equipment category) in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        name:                    { type: 'string' },
        sku:                     { type: 'string' },
        description:             { type: 'string' },
        tag_list:                { type: 'array', items: { type: 'string' } },
        price_type:              { type: 'string', enum: ['simple', 'structure'] },
        price_period:            { type: 'string', enum: ['hour', 'day', 'week', 'month'] },
        base_price_in_cents:     { type: 'number' },
        flat_fee_price_in_cents: { type: 'number' },
        show_in_store:           { type: 'boolean' },
        trackable:               { type: 'boolean' },
        lag_time:                { type: 'number', description: 'Minutes between rentals' },
        lead_time:               { type: 'number', description: 'Minutes prep before rental' },
      },
      required: ['name'],
    },
  },
  {
    name: 'BOOQABLE_GET_PRODUCT_GROUP',
    description: 'Get a single Booqable product group by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_LIST_PRODUCT_GROUPS',
    description: 'List all Booqable product groups.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 100 },
        page:     { type: 'number', default: 1 },
        tag:      { type: 'string', description: 'Filter by tag' },
      },
    },
  },
  {
    name: 'BOOQABLE_DELETE_PRODUCT_GROUP',
    description: 'Delete a Booqable product group by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_GET_PRODUCT',
    description: 'Get a single Booqable product (variant) by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'BOOQABLE_LIST_PRODUCTS',
    description: 'List Booqable products, optionally filtered by product group.',
    input_schema: {
      type: 'object',
      properties: {
        product_group_id: { type: 'string' },
        per_page:         { type: 'number', default: 100 },
        page:             { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_PRODUCTS',
    description: 'Search Booqable products by keyword (name or SKU).',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Search keyword' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
      required: ['q'],
    },
  },
  {
    name: 'BOOQABLE_GET_INVENTORY_LEVELS',
    description: 'Get inventory availability levels for a product over a date range.',
    input_schema: {
      type: 'object',
      properties: {
        product_id:  { type: 'string' },
        from:        { type: 'string', description: 'ISO date' },
        till:        { type: 'string', description: 'ISO date' },
        location_id: { type: 'string' },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_INVENTORY_BREAKDOWNS',
    description: 'List detailed inventory breakdowns by date range.',
    input_schema: {
      type: 'object',
      properties: {
        product_id:  { type: 'string' },
        from:        { type: 'string', description: 'ISO date' },
        till:        { type: 'string', description: 'ISO date' },
        location_id: { type: 'string' },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_STOCK_ITEMS',
    description: 'List individual stock items (serialized units) in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        product_group_id: { type: 'string' },
        product_id:       { type: 'string' },
        per_page:         { type: 'number', default: 100 },
        page:             { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_STOCK_ITEM_PLANNINGS',
    description: 'List stock item plannings (which units are assigned to which orders).',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        per_page: { type: 'number', default: 100 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PLANNINGS',
    description: 'List plannings (order-product scheduling blocks).',
    input_schema: {
      type: 'object',
      properties: {
        order_id:   { type: 'string' },
        product_id: { type: 'string' },
        per_page:   { type: 'number', default: 100 },
        page:       { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_PLANNINGS',
    description: 'Search plannings by date range, product, or location.',
    input_schema: {
      type: 'object',
      properties: {
        starts_at_gte: { type: 'string', description: 'ISO date' },
        stops_at_lte:  { type: 'string', description: 'ISO date' },
        product_id:    { type: 'string' },
        location_id:   { type: 'string' },
        per_page:      { type: 'number', default: 50 },
        page:          { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_LINES',
    description: 'List order line items, optionally filtered by order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        per_page: { type: 'number', default: 100 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_DOCUMENTS',
    description: 'List Booqable documents (quotes, contracts, invoices) for an order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        type:     { type: 'string', enum: ['quote', 'contract', 'invoice'] },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_DOCUMENTS',
    description: 'Search Booqable documents by number or type.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Document number fragment' },
        type:     { type: 'string', enum: ['quote', 'contract', 'invoice'] },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PAYMENTS',
    description: 'List payments, optionally filtered by order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PAYMENT_METHODS',
    description: 'List available payment methods configured in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_NOTES',
    description: 'List notes attached to a Booqable record (order, customer, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        notable_id:   { type: 'string', description: 'ID of the parent record' },
        notable_type: { type: 'string', description: 'e.g. Order, Customer' },
        per_page:     { type: 'number', default: 25 },
        page:         { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_LOCATIONS',
    description: 'List Booqable pickup/dropoff locations.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_USERS',
    description: 'List Booqable user accounts.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_EMPLOYEES',
    description: 'List Booqable employees.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PRICE_RULESETS',
    description: 'List price rulesets configured in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PRICE_STRUCTURES',
    description: 'List price structures configured in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_TAX_RATES',
    description: 'List tax rates configured in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_TAX_VALUES',
    description: 'List tax values applied to an order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_COUPONS',
    description: 'List discount coupons in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_BUNDLES',
    description: 'Search Booqable product bundles by name.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_BUNDLE_ITEMS',
    description: 'List items inside a Booqable bundle.',
    input_schema: {
      type: 'object',
      properties: {
        bundle_id: { type: 'string' },
        per_page:  { type: 'number', default: 100 },
        page:      { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_ITEMS',
    description: 'List all items (products + bundles) in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Name filter' },
        type:     { type: 'string', description: 'ProductGroup or Bundle' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_SEARCH_ITEMS',
    description: 'Search Booqable items by name or SKU.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string' },
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
      required: ['q'],
    },
  },
  {
    name: 'BOOQABLE_LIST_BARCODES',
    description: 'List barcodes attached to a Booqable record.',
    input_schema: {
      type: 'object',
      properties: {
        owner_id:   { type: 'string' },
        owner_type: { type: 'string', description: 'e.g. StockItem, Product' },
        per_page:   { type: 'number', default: 100 },
        page:       { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_CLUSTERS',
    description: 'List Booqable clusters (location groupings).',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_EMAIL_TEMPLATES',
    description: 'List email templates configured in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', default: 25 },
        page:     { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PHOTOS',
    description: 'List photos attached to a Booqable record.',
    input_schema: {
      type: 'object',
      properties: {
        owner_id:   { type: 'string' },
        owner_type: { type: 'string', description: 'e.g. ProductGroup' },
        per_page:   { type: 'number', default: 50 },
        page:       { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PROPERTIES',
    description: 'List custom properties on a Booqable record.',
    input_schema: {
      type: 'object',
      properties: {
        owner_id:   { type: 'string' },
        owner_type: { type: 'string', description: 'e.g. Order, Customer' },
        per_page:   { type: 'number', default: 100 },
        page:       { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_DEFAULT_PROPERTIES',
    description: 'List default property definitions in Booqable.',
    input_schema: {
      type: 'object',
      properties: {
        owner_type: { type: 'string', description: 'e.g. Order, Customer' },
        per_page:   { type: 'number', default: 100 },
        page:       { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_LIST_PROVINCES',
    description: 'List provinces/states, optionally filtered by country.',
    input_schema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'e.g. US' },
        per_page:     { type: 'number', default: 100 },
        page:         { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'BOOQABLE_UPDATE_COMPANIES',
    description: 'Update the Booqable company/account settings.',
    input_schema: {
      type: 'object',
      properties: {
        name:         { type: 'string' },
        email:        { type: 'string' },
        phone:        { type: 'string' },
        website:      { type: 'string' },
        timezone:     { type: 'string' },
        currency:     { type: 'string', description: 'ISO currency code, e.g. USD' },
        address1:     { type: 'string' },
        city:         { type: 'string' },
        zipcode:      { type: 'string' },
        country_code: { type: 'string' },
        tax_percentage: { type: 'number' },
      },
    },
  },
];

// ─── Dispatcher ────────────────────────────────────────────────
// Use in agent tool_use loops:
//   const result = await dispatchBooqableTool(toolUse.name, toolUse.input);

const BOOQABLE_FN_MAP = {
  BOOQABLE_FIND_OR_CONFIRM_CUSTOMER,
  BOOQABLE_CREATE_CUSTOMER,           BOOQABLE_GET_CUSTOMER,
  BOOQABLE_GET_CUSTOMERS,             BOOQABLE_SEARCH_CUSTOMERS,
  BOOQABLE_SEARCH_CUSTOMERS_BY_EMAIL, BOOQABLE_SEARCH_CUSTOMERS_BY_NAME,
  BOOQABLE_DELETE_CUSTOMER,           BOOQABLE_CREATE_ORDER,
  BOOQABLE_UPDATE_ORDER,              BOOQABLE_GET_ORDER,
  BOOQABLE_GET_NEW_ORDER,             BOOQABLE_LIST_ORDERS,
  BOOQABLE_SEARCH_ORDERS,             BOOQABLE_DELETE_ORDER,
  BOOQABLE_CREATE_LINE,               BOOQABLE_CREATE_PRODUCT_GROUP,
  BOOQABLE_GET_PRODUCT_GROUP,         BOOQABLE_LIST_PRODUCT_GROUPS,
  BOOQABLE_DELETE_PRODUCT_GROUP,      BOOQABLE_GET_PRODUCT,
  BOOQABLE_LIST_PRODUCTS,             BOOQABLE_SEARCH_PRODUCTS,
  BOOQABLE_GET_INVENTORY_LEVELS,      BOOQABLE_CHECK_AVAILABILITY,
  BOOQABLE_LIST_INVENTORY_BREAKDOWNS, BOOQABLE_LIST_STOCK_ITEMS,
  BOOQABLE_LIST_STOCK_ITEM_PLANNINGS, BOOQABLE_LIST_PLANNINGS,
  BOOQABLE_SEARCH_PLANNINGS,          BOOQABLE_LIST_LINES,
  BOOQABLE_LIST_DOCUMENTS,            BOOQABLE_SEARCH_DOCUMENTS,
  BOOQABLE_LIST_PAYMENTS,             BOOQABLE_LIST_PAYMENT_METHODS,
  BOOQABLE_LIST_NOTES,                BOOQABLE_LIST_LOCATIONS,
  BOOQABLE_LIST_USERS,                BOOQABLE_LIST_EMPLOYEES,
  BOOQABLE_LIST_PRICE_RULESETS,       BOOQABLE_LIST_PRICE_STRUCTURES,
  BOOQABLE_LIST_TAX_RATES,            BOOQABLE_LIST_TAX_VALUES,
  BOOQABLE_LIST_COUPONS,              BOOQABLE_SEARCH_BUNDLES,
  BOOQABLE_LIST_BUNDLE_ITEMS,         BOOQABLE_LIST_ITEMS,
  BOOQABLE_SEARCH_ITEMS,              BOOQABLE_LIST_BARCODES,
  BOOQABLE_LIST_CLUSTERS,             BOOQABLE_LIST_EMAIL_TEMPLATES,
  BOOQABLE_LIST_PHOTOS,               BOOQABLE_LIST_PROPERTIES,
  BOOQABLE_LIST_DEFAULT_PROPERTIES,   BOOQABLE_LIST_PROVINCES,
  BOOQABLE_UPDATE_COMPANIES,
};

export async function dispatchBooqableTool(name, input) {
  const fn = BOOQABLE_FN_MAP[name];
  if (!fn) throw new Error(`Unknown Booqable tool: ${name}`);
  return fn(input || {});
}
