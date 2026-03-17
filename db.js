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
const PIPELINE_FILE = path.join(__dirname, 'data/pipeline.json');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
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
  console.log('[DB] ✅ Pipeline table ready');
}

// ─── Get all jobs ──────────────────────────────────────────
export async function getPipeline() {
  const p = getPool();
  if (!p) return fileRead();
  const { rows } = await p.query(
    "SELECT data FROM pipeline ORDER BY (data->>'createdAt') ASC"
  );
  return rows.map(r => r.data);
}

// ─── Upsert a single job ───────────────────────────────────
export async function upsertJob(job) {
  const p = getPool();
  if (!p) {
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
