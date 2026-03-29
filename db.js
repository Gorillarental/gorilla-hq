// ============================================================
// DB.JS — Pipeline storage via PostgreSQL
// Falls back to JSON file if DATABASE_URL is not set
// ============================================================

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_FILE  = path.join(__dirname, 'data/pipeline.json');
const CASHFLOW_FILE  = path.join(__dirname, 'data/cashflow.json');

let pool = null;

// ─── Fallback tracking ──────────────────────────────────────
let _fallbackCount = 0;

export function recordFallback() {
  _fallbackCount++;
  if (_fallbackCount === 3) {
    // Lazy import to avoid circular dep
    import('./telegram.js').then(({ sendTelegram }) => {
      sendTelegram('⚠️ <b>Database Alert</b>\nPostgreSQL has been unavailable for 3+ consecutive operations. System is running on JSON fallback. Data may be inconsistent.').catch(() => {});
    }).catch(() => {});
  }
}

export function resetFallbackCount() { _fallbackCount = 0; }

export function getDataSource() {
  return getPool() ? 'postgresql' : 'json';
}

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

// ─── DB health check ───────────────────────────────────────
export async function checkDBHealth() {
  const p = getPool();
  if (!p) {
    console.warn('[DB] ⚠️ PostgreSQL pool not initialized — using JSON fallback');
    return false;
  }
  try {
    await p.query('SELECT 1');
    console.log('[DB] ✅ PostgreSQL connected');
    resetFallbackCount();
    return true;
  } catch (e) {
    console.error('[DB] ❌ PostgreSQL health check failed:', e.message);
    return false;
  }
}

// ─── File fallback helpers ─────────────────────────────────
function fileRead() {
  try {
    if (!fs.existsSync(PIPELINE_FILE)) { fs.writeFileSync(PIPELINE_FILE, '[]'); return []; }
    return JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8'));
  } catch { return []; }
}
function fileWrite(data) { fs.writeFileSync(PIPELINE_FILE, JSON.stringify(data, null, 2)); }

// ─── Init (creates table if not exists) ────────────────────
export async function initDB() {
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS pipeline (
      job_id TEXT PRIMARY KEY,
      data   JSONB        NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS cashflow (
      id         TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      job_id     TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id         TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS approvals (
      id         TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id         TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      chat_id    TEXT PRIMARY KEY,
      agent      TEXT         NOT NULL,
      history    JSONB        NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] ✅ All tables ready');
}

// ─── Get all jobs ──────────────────────────────────────────
export async function getPipeline() {
  const p = getPool();
  if (!p) { console.warn('[DB] PostgreSQL unavailable — falling back to JSON. Data may be stale.'); recordFallback(); return fileRead(); }
  const { rows } = await p.query(
    "SELECT data FROM pipeline ORDER BY (data->>'createdAt') ASC"
  );
  return rows.map(r => r.data);
}

// ─── Upsert a single job ───────────────────────────────────
export async function upsertJob(job) {
  const p = getPool();
  if (!p) {
    console.warn('[DB] PostgreSQL unavailable — falling back to JSON. Data may be stale.'); recordFallback();
    const pipeline = fileRead();
    const idx = pipeline.findIndex(j => j.jobId === job.jobId);
    if (idx >= 0) pipeline[idx] = job; else pipeline.push(job);
    fileWrite(pipeline);
    return;
  }
  await p.query(
    `INSERT INTO pipeline (job_id, data) VALUES ($1, $2)
     ON CONFLICT (job_id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [job.jobId, job]
  );
}

// ─── Update fields on a job ────────────────────────────────
export async function updateJob(jobId, updates) {
  const p = getPool();
  if (!p) {
    const pipeline = fileRead();
    const idx = pipeline.findIndex(j => j.jobId === jobId);
    if (idx < 0) return null;
    Object.assign(pipeline[idx], updates);
    fileWrite(pipeline);
    return pipeline[idx];
  }
  const { rows } = await p.query('SELECT data FROM pipeline WHERE job_id = $1', [jobId]);
  if (!rows.length) return null;
  const updated = { ...rows[0].data, ...updates };
  await p.query(
    'UPDATE pipeline SET data = $1, updated_at = NOW() WHERE job_id = $2',
    [updated, jobId]
  );
  return updated;
}

// ─── Get single job ────────────────────────────────────────
export async function getJob(jobId) {
  const p = getPool();
  if (!p) {
    return fileRead().find(j => j.jobId === jobId) || null;
  }
  const { rows } = await p.query('SELECT data FROM pipeline WHERE job_id = $1', [jobId]);
  return rows[0]?.data || null;
}

// ─── Reservations ──────────────────────────────────────────
export async function dbUpsertReservation(res) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO reservations (job_id, data) VALUES ($1, $2)
     ON CONFLICT (job_id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [res.jobId, res]
  );
}

export async function dbGetReservation(jobId) {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT data FROM reservations WHERE job_id = $1', [jobId]);
  return rows[0]?.data || null;
}

export async function dbGetAllReservations() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query("SELECT data FROM reservations ORDER BY (data->>'createdAt') DESC");
  return rows.map(r => r.data);
}

// ─── Deliveries ────────────────────────────────────────────
export async function dbUpsertDelivery(delivery) {
  const p = getPool();
  if (!p) return;
  const id = delivery.id || `DEL-${delivery.jobId}`;
  await p.query(
    `INSERT INTO deliveries (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [id, { ...delivery, id }]
  );
}

export async function dbGetDeliveries(filter = {}) {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query("SELECT data FROM deliveries ORDER BY (data->>'scheduledDate') ASC");
  let result = rows.map(r => r.data);
  if (filter.date)   result = result.filter(d => d.scheduledDate === filter.date);
  if (filter.status) result = result.filter(d => d.status === filter.status);
  return result;
}

export async function dbUpdateDelivery(id, updates) {
  const p = getPool();
  if (!p) return;
  const { rows } = await p.query('SELECT data FROM deliveries WHERE id = $1', [id]);
  if (!rows.length) return;
  const updated = { ...rows[0].data, ...updates };
  await p.query('UPDATE deliveries SET data = $1, updated_at = NOW() WHERE id = $2', [updated, id]);
  return updated;
}

// ─── Approvals ─────────────────────────────────────────────
export async function dbUpsertApproval(approval) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO approvals (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [approval.id, approval]
  );
}

export async function dbGetApproval(id) {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT data FROM approvals WHERE id = $1', [id]);
  return rows[0]?.data || null;
}

export async function dbGetAllApprovals() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query("SELECT data FROM approvals ORDER BY (data->>'createdAt') DESC");
  return rows.map(r => r.data);
}

// ─── Leads ─────────────────────────────────────────────────
export async function dbUpsertLead(lead) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO leads (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, created_at = NOW()`,
    [lead.id, lead]
  );
}

export async function dbGetAllLeads() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query("SELECT data FROM leads ORDER BY created_at DESC");
  return rows.map(r => r.data);
}

// ─── Conversations (persistent chat history) ───────────────
export async function dbGetConversation(chatId, agent) {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    'SELECT history FROM conversations WHERE chat_id = $1 AND agent = $2',
    [chatId, agent]
  );
  return rows[0]?.history || [];
}

export async function dbSaveConversation(chatId, agent, history) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO conversations (chat_id, agent, history, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET history = $3, updated_at = NOW()`,
    [chatId, agent, JSON.stringify(history)]
  );
}

export async function dbClearConversation(chatId) {
  const p = getPool();
  if (!p) return;
  await p.query('DELETE FROM conversations WHERE chat_id = $1', [chatId]);
}

// ─── Cashflow file helpers ─────────────────────────────────
function cfFileRead() {
  try {
    if (!fs.existsSync(CASHFLOW_FILE)) { fs.writeFileSync(CASHFLOW_FILE, '[]'); return []; }
    return JSON.parse(fs.readFileSync(CASHFLOW_FILE, 'utf8'));
  } catch { return []; }
}
function cfFileWrite(rows) { fs.writeFileSync(CASHFLOW_FILE, JSON.stringify(rows, null, 2)); }

// ─── Add cashflow entry ────────────────────────────────────
export async function dbAddCashflow(entry) {
  const id   = `CF-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const data = { ...entry, id, createdAt: new Date().toISOString() };
  const p    = getPool();
  if (!p) {
    const rows = cfFileRead();
    rows.push(data);
    cfFileWrite(rows);
    return data;
  }
  await p.query(
    'INSERT INTO cashflow (id, data) VALUES ($1, $2)',
    [id, data]
  );
  return data;
}

// ─── Get all cashflow entries ──────────────────────────────
export async function dbGetCashflow() {
  const p = getPool();
  if (!p) return cfFileRead();
  const { rows } = await p.query("SELECT data FROM cashflow ORDER BY (data->>'date') ASC, created_at ASC");
  return rows.map(r => r.data);
}

// ─── Get cashflow summary for a month ─────────────────────
export async function dbGetCashflowSummary(month) {
  const all     = await dbGetCashflow();
  const entries = month ? all.filter(r => String(r.date || '').slice(0, 7) === month) : all;
  let income = 0, expenses = 0;
  const byCategory = {};
  for (const e of entries) {
    const amt = Math.abs(e.amount || 0);
    const cat = e.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = 0;
    if ((e.type || '').toLowerCase() === 'income') { income += amt; byCategory[cat] += amt; }
    else { expenses += amt; byCategory[cat] -= amt; }
  }
  return { income, expenses, net: income - expenses, byCategory, entries };
}
