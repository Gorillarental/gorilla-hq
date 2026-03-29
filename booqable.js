// ============================================================
// BOOQABLE.JS — Booqable API v1 Tool Layer
// All 49 actions available to quote, ops, admin, finance agents
// ============================================================

import { CONFIG } from './config.js';

function booqableHeaders() {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${CONFIG.BOOQABLE.API_KEY}`,
  };
}

async function bq(method, path, body) {
  const url = `${CONFIG.BOOQABLE.BASE_URL}${path}`;
  const opts = { method, headers: booqableHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Booqable ${method} ${path} → ${res.status}: ${text}`);
  return data;
}

// ─── Customers ─────────────────────────────────────────────────

export async function BOOQABLE_CREATE_CUSTOMER({ name, email, phone, address1, city, zipcode, country_code, tax_region_id, deposit_type, deposit_value, properties_attributes }) {
  return bq('POST', '/customers', {
    customer: { name, email, phone, address1, city, zipcode, country_code, tax_region_id, deposit_type, deposit_value, properties_attributes },
  });
}

export async function BOOQABLE_GET_CUSTOMER({ id }) {
  return bq('GET', `/customers/${id}`);
}

export async function BOOQABLE_GET_CUSTOMERS({ per_page = 100, page = 1 } = {}) {
  return bq('GET', `/customers?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_SEARCH_CUSTOMERS({ q, per_page = 25, page = 1 } = {}) {
  return bq('GET', `/customers?q=${encodeURIComponent(q || '')}&per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_DELETE_CUSTOMER({ id }) {
  return bq('DELETE', `/customers/${id}`);
}

// ─── Find-or-confirm customer (always search before creating) ──
//
// Returns one of:
//   { found: false }                                    → safe to create
//   { found: true, customer, requiresConfirmation: true } → ask user first
//
export async function findOrConfirmCustomer({ name, email }) {
  // 1. Search by email
  if (email) {
    const byEmail = await BOOQABLE_SEARCH_CUSTOMERS({ q: email, per_page: 5 });
    const hit = byEmail?.customers?.find(c =>
      c.email?.toLowerCase() === email.toLowerCase()
    );
    if (hit) return { found: true, customer: hit, requiresConfirmation: true };
  }

  if (name) {
    // 2. Search by full name
    const byFullName = await BOOQABLE_SEARCH_CUSTOMERS({ q: name, per_page: 10 });
    if (byFullName?.customers?.length) {
      const exact = byFullName.customers.find(
        c => c.name?.toLowerCase() === name.toLowerCase()
      );
      const hit = exact || byFullName.customers[0];
      return { found: true, customer: hit, requiresConfirmation: true };
    }

    // 3. Search by partial name (first name only)
    const firstName = name.trim().split(' ')[0];
    if (firstName && firstName.length >= 3) {
      const byFirst = await BOOQABLE_SEARCH_CUSTOMERS({ q: firstName, per_page: 10 });
      if (byFirst?.customers?.length) {
        return { found: true, customer: byFirst.customers[0], requiresConfirmation: true };
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

export async function BOOQABLE_CREATE_ORDER({ customer_id, starts_at, stops_at, tag_list, note, location_id, deposit_type, deposit_value }) {
  return bq('POST', '/orders', {
    order: { customer_id, starts_at, stops_at, tag_list, note, location_id, deposit_type, deposit_value },
  });
}

export async function BOOQABLE_GET_ORDER({ id, include } = {}) {
  const qs = include ? `?include=${encodeURIComponent(include)}` : '';
  return bq('GET', `/orders/${id}${qs}`);
}

export async function BOOQABLE_GET_NEW_ORDER() {
  return bq('GET', '/orders/new');
}

export async function BOOQABLE_LIST_ORDERS({ per_page = 25, page = 1, status, customer_id } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (status)      params.set('q[status_eq]', status);
  if (customer_id) params.set('q[customer_id_eq]', customer_id);
  return bq('GET', `/orders?${params}`);
}

export async function BOOQABLE_SEARCH_ORDERS({ q, status, starts_at_gte, stops_at_lte, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (q)             params.set('q[number_or_customer_name_cont]', q);
  if (status)        params.set('q[status_eq]', status);
  if (starts_at_gte) params.set('q[starts_at_gteq]', starts_at_gte);
  if (stops_at_lte)  params.set('q[stops_at_lteq]', stops_at_lte);
  return bq('GET', `/orders?${params}`);
}

export async function BOOQABLE_DELETE_ORDER({ id }) {
  return bq('DELETE', `/orders/${id}`);
}

// ─── Lines ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_LINES({ order_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id) params.set('q[order_id_eq]', order_id);
  return bq('GET', `/lines?${params}`);
}

// ─── Products & Product Groups ─────────────────────────────────

export async function BOOQABLE_CREATE_PRODUCT_GROUP({ name, slug, sku, description, tag_list, tax_category_id, price_type, price_period, base_price_in_cents, flat_fee_price_in_cents, show_in_store, trackable, lag_time, lead_time }) {
  return bq('POST', '/product_groups', {
    product_group: { name, slug, sku, description, tag_list, tax_category_id, price_type, price_period, base_price_in_cents, flat_fee_price_in_cents, show_in_store, trackable, lag_time, lead_time },
  });
}

export async function BOOQABLE_GET_PRODUCT_GROUP({ id }) {
  return bq('GET', `/product_groups/${id}`);
}

export async function BOOQABLE_LIST_PRODUCT_GROUPS({ per_page = 100, page = 1, tag } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (tag) params.set('q[tag_list_cont]', tag);
  return bq('GET', `/product_groups?${params}`);
}

export async function BOOQABLE_DELETE_PRODUCT_GROUP({ id }) {
  return bq('DELETE', `/product_groups/${id}`);
}

export async function BOOQABLE_GET_PRODUCT({ id }) {
  return bq('GET', `/products/${id}`);
}

export async function BOOQABLE_LIST_PRODUCTS({ product_group_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (product_group_id) params.set('q[product_group_id_eq]', product_group_id);
  return bq('GET', `/products?${params}`);
}

// ─── Items ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_ITEMS({ q, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (q)    params.set('q[name_cont]', q);
  if (type) params.set('q[type_eq]', type);
  return bq('GET', `/items?${params}`);
}

export async function BOOQABLE_SEARCH_ITEMS({ q, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (q) params.set('q[name_or_sku_cont]', q);
  return bq('GET', `/items?${params}`);
}

// ─── Inventory ─────────────────────────────────────────────────

export async function BOOQABLE_GET_INVENTORY_LEVELS({ product_id, from, till, location_id } = {}) {
  const params = new URLSearchParams();
  if (product_id)  params.set('product_id', product_id);
  if (from)        params.set('from', from);
  if (till)        params.set('till', till);
  if (location_id) params.set('location_id', location_id);
  return bq('GET', `/inventory?${params}`);
}

export async function BOOQABLE_LIST_INVENTORY_BREAKDOWNS({ product_id, from, till, location_id } = {}) {
  const params = new URLSearchParams();
  if (product_id)  params.set('product_id', product_id);
  if (from)        params.set('from', from);
  if (till)        params.set('till', till);
  if (location_id) params.set('location_id', location_id);
  return bq('GET', `/inventory_breakdowns?${params}`);
}

// ─── Stock ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_STOCK_ITEMS({ product_group_id, product_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (product_group_id) params.set('q[product_group_id_eq]', product_group_id);
  if (product_id)       params.set('q[product_id_eq]', product_id);
  return bq('GET', `/stock_items?${params}`);
}

export async function BOOQABLE_LIST_STOCK_ITEM_PLANNINGS({ order_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id) params.set('q[order_id_eq]', order_id);
  return bq('GET', `/stock_item_plannings?${params}`);
}

// ─── Plannings ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_PLANNINGS({ order_id, product_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id)   params.set('q[order_id_eq]', order_id);
  if (product_id) params.set('q[product_id_eq]', product_id);
  return bq('GET', `/plannings?${params}`);
}

export async function BOOQABLE_SEARCH_PLANNINGS({ starts_at_gte, stops_at_lte, product_id, location_id, per_page = 50, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (starts_at_gte) params.set('q[starts_at_gteq]', starts_at_gte);
  if (stops_at_lte)  params.set('q[stops_at_lteq]', stops_at_lte);
  if (product_id)    params.set('q[product_id_eq]', product_id);
  if (location_id)   params.set('q[location_id_eq]', location_id);
  return bq('GET', `/plannings?${params}`);
}

// ─── Documents ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_DOCUMENTS({ order_id, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id) params.set('q[order_id_eq]', order_id);
  if (type)     params.set('q[type_eq]', type);
  return bq('GET', `/documents?${params}`);
}

export async function BOOQABLE_SEARCH_DOCUMENTS({ q, type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (q)    params.set('q[number_cont]', q);
  if (type) params.set('q[type_eq]', type);
  return bq('GET', `/documents?${params}`);
}

// ─── Payments ──────────────────────────────────────────────────

export async function BOOQABLE_LIST_PAYMENTS({ order_id, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id) params.set('q[order_id_eq]', order_id);
  return bq('GET', `/payments?${params}`);
}

export async function BOOQABLE_LIST_PAYMENT_METHODS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/payment_methods?per_page=${per_page}&page=${page}`);
}

// ─── Notes ─────────────────────────────────────────────────────

export async function BOOQABLE_LIST_NOTES({ notable_id, notable_type, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (notable_id)   params.set('q[notable_id_eq]', notable_id);
  if (notable_type) params.set('q[notable_type_eq]', notable_type);
  return bq('GET', `/notes?${params}`);
}

// ─── Locations ─────────────────────────────────────────────────

export async function BOOQABLE_LIST_LOCATIONS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/locations?per_page=${per_page}&page=${page}`);
}

// ─── Users & Employees ─────────────────────────────────────────

export async function BOOQABLE_LIST_USERS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/users?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_EMPLOYEES({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/employees?per_page=${per_page}&page=${page}`);
}

// ─── Pricing ───────────────────────────────────────────────────

export async function BOOQABLE_LIST_PRICE_RULESETS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/price_rulesets?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_PRICE_STRUCTURES({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/price_structures?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_TAX_RATES({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/tax_rates?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_TAX_VALUES({ order_id, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (order_id) params.set('q[order_id_eq]', order_id);
  return bq('GET', `/tax_values?${params}`);
}

export async function BOOQABLE_LIST_COUPONS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/coupons?per_page=${per_page}&page=${page}`);
}

// ─── Bundles ───────────────────────────────────────────────────

export async function BOOQABLE_SEARCH_BUNDLES({ q, per_page = 25, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (q) params.set('q[name_cont]', q);
  return bq('GET', `/bundles?${params}`);
}

export async function BOOQABLE_LIST_BUNDLE_ITEMS({ bundle_id, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (bundle_id) params.set('q[bundle_id_eq]', bundle_id);
  return bq('GET', `/bundle_items?${params}`);
}

// ─── Properties ────────────────────────────────────────────────

export async function BOOQABLE_LIST_PROPERTIES({ owner_id, owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (owner_id)   params.set('q[owner_id_eq]', owner_id);
  if (owner_type) params.set('q[owner_type_eq]', owner_type);
  return bq('GET', `/properties?${params}`);
}

export async function BOOQABLE_LIST_DEFAULT_PROPERTIES({ owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (owner_type) params.set('q[owner_type_eq]', owner_type);
  return bq('GET', `/default_properties?${params}`);
}

// ─── Misc ──────────────────────────────────────────────────────

export async function BOOQABLE_LIST_BARCODES({ owner_id, owner_type, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (owner_id)   params.set('q[owner_id_eq]', owner_id);
  if (owner_type) params.set('q[owner_type_eq]', owner_type);
  return bq('GET', `/barcodes?${params}`);
}

export async function BOOQABLE_LIST_CLUSTERS({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/clusters?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_EMAIL_TEMPLATES({ per_page = 25, page = 1 } = {}) {
  return bq('GET', `/email_templates?per_page=${per_page}&page=${page}`);
}

export async function BOOQABLE_LIST_PHOTOS({ owner_id, owner_type, per_page = 50, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (owner_id)   params.set('q[owner_id_eq]', owner_id);
  if (owner_type) params.set('q[owner_type_eq]', owner_type);
  return bq('GET', `/photos?${params}`);
}

export async function BOOQABLE_LIST_PROVINCES({ country_code, per_page = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page, page });
  if (country_code) params.set('q[country_code_eq]', country_code);
  return bq('GET', `/provinces?${params}`);
}

// ─── Company ───────────────────────────────────────────────────

export async function BOOQABLE_UPDATE_COMPANIES({ name, email, phone, website, timezone, currency, address1, city, zipcode, country_code, tax_percentage, billing_settings }) {
  return bq('PUT', '/companies/current', {
    company: { name, email, phone, website, timezone, currency, address1, city, zipcode, country_code, tax_percentage, billing_settings },
  });
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
  BOOQABLE_CREATE_CUSTOMER,       BOOQABLE_GET_CUSTOMER,
  BOOQABLE_GET_CUSTOMERS,         BOOQABLE_SEARCH_CUSTOMERS,
  BOOQABLE_DELETE_CUSTOMER,       BOOQABLE_CREATE_ORDER,
  BOOQABLE_GET_ORDER,             BOOQABLE_GET_NEW_ORDER,
  BOOQABLE_LIST_ORDERS,           BOOQABLE_SEARCH_ORDERS,
  BOOQABLE_DELETE_ORDER,          BOOQABLE_CREATE_PRODUCT_GROUP,
  BOOQABLE_GET_PRODUCT_GROUP,     BOOQABLE_LIST_PRODUCT_GROUPS,
  BOOQABLE_DELETE_PRODUCT_GROUP,  BOOQABLE_GET_PRODUCT,
  BOOQABLE_LIST_PRODUCTS,         BOOQABLE_GET_INVENTORY_LEVELS,
  BOOQABLE_LIST_INVENTORY_BREAKDOWNS, BOOQABLE_LIST_STOCK_ITEMS,
  BOOQABLE_LIST_STOCK_ITEM_PLANNINGS, BOOQABLE_LIST_PLANNINGS,
  BOOQABLE_SEARCH_PLANNINGS,      BOOQABLE_LIST_LINES,
  BOOQABLE_LIST_DOCUMENTS,        BOOQABLE_SEARCH_DOCUMENTS,
  BOOQABLE_LIST_PAYMENTS,         BOOQABLE_LIST_PAYMENT_METHODS,
  BOOQABLE_LIST_NOTES,            BOOQABLE_LIST_LOCATIONS,
  BOOQABLE_LIST_USERS,            BOOQABLE_LIST_EMPLOYEES,
  BOOQABLE_LIST_PRICE_RULESETS,   BOOQABLE_LIST_PRICE_STRUCTURES,
  BOOQABLE_LIST_TAX_RATES,        BOOQABLE_LIST_TAX_VALUES,
  BOOQABLE_LIST_COUPONS,          BOOQABLE_SEARCH_BUNDLES,
  BOOQABLE_LIST_BUNDLE_ITEMS,     BOOQABLE_LIST_ITEMS,
  BOOQABLE_SEARCH_ITEMS,          BOOQABLE_LIST_BARCODES,
  BOOQABLE_LIST_CLUSTERS,         BOOQABLE_LIST_EMAIL_TEMPLATES,
  BOOQABLE_LIST_PHOTOS,           BOOQABLE_LIST_PROPERTIES,
  BOOQABLE_LIST_DEFAULT_PROPERTIES, BOOQABLE_LIST_PROVINCES,
  BOOQABLE_UPDATE_COMPANIES,
};

export async function dispatchBooqableTool(name, input) {
  const fn = BOOQABLE_FN_MAP[name];
  if (!fn) throw new Error(`Unknown Booqable tool: ${name}`);
  return fn(input || {});
}
