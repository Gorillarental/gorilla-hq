// ops-server.js — Gorilla Ops API server (port 3001)
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, EQUIPMENT_CATALOG, DRIVERS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'ops-public')));

const DATA = {
  deliveries:      path.join(__dirname, 'data/deliveries.json'),
  workorders:      path.join(__dirname, 'data/workorders.json'),
  parts:           path.join(__dirname, 'data/parts.json'),
  serviceRequests: path.join(__dirname, 'data/service-requests.json'),
  pipeline:        path.join(__dirname, 'data/pipeline.json'),
};

function readJSON(fp, fallback = []) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// Health
app.get('/health', (req, res) => res.json({ ok: true, service: 'Gorilla Ops', version: '2.0.0', timestamp: new Date().toISOString() }));

// Equipment
app.get('/api/equipment', (req, res) => {
  const pipeline = readJSON(DATA.pipeline);
  const active = pipeline.filter(j => j.stage === 'in_progress').flatMap(j => (j.equipment || []).map(e => e.sku));
  const catalog = EQUIPMENT_CATALOG.map(e => ({ ...e, status: active.includes(e.sku) ? 'rented' : 'available' }));
  res.json({ ok: true, equipment: catalog });
});

// Deliveries
app.get('/api/deliveries', (req, res) => {
  const deliveries = readJSON(DATA.deliveries);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const upcoming = deliveries.filter(d => d.date >= today && d.date <= cutoff);
  const todayJobs = deliveries.filter(d => d.date === today);
  res.json({ ok: true, today: todayJobs, upcoming });
});

// Work orders
app.get('/api/workorders', (req, res) => res.json({ ok: true, workorders: readJSON(DATA.workorders) }));

app.post('/api/workorder', (req, res) => {
  const { jobId, description, priority = 'medium', assignedTo } = req.body;
  const wo = { id: `WO-${Date.now()}`, jobId, description, priority, assignedTo, status: 'open', createdAt: new Date().toISOString() };
  const list = readJSON(DATA.workorders);
  list.push(wo);
  writeJSON(DATA.workorders, list);
  res.json({ ok: true, workorder: wo });
});

// Drivers
app.get('/api/drivers', (req, res) => res.json({ ok: true, drivers: DRIVERS }));

// Mark delivery complete
app.post('/api/delivery/complete', (req, res) => {
  const { jobId, notes } = req.body;
  const deliveries = readJSON(DATA.deliveries);
  const idx = deliveries.findIndex(d => d.jobId === jobId);
  if (idx !== -1) { deliveries[idx].status = 'completed'; deliveries[idx].completedAt = new Date().toISOString(); deliveries[idx].notes = notes; writeJSON(DATA.deliveries, deliveries); }
  const pipeline = readJSON(DATA.pipeline);
  const pi = pipeline.findIndex(j => j.jobId === jobId);
  if (pi !== -1) { pipeline[pi].stage = 'in_progress'; writeJSON(DATA.pipeline, pipeline); }
  res.json({ ok: true, jobId });
});

// Mark pickup complete
app.post('/api/pickup/complete', (req, res) => {
  const { jobId, inspectionNotes } = req.body;
  const deliveries = readJSON(DATA.deliveries);
  const idx = deliveries.findIndex(d => d.jobId === jobId && d.type === 'pickup');
  if (idx !== -1) { deliveries[idx].status = 'completed'; deliveries[idx].completedAt = new Date().toISOString(); deliveries[idx].inspectionNotes = inspectionNotes; writeJSON(DATA.deliveries, deliveries); }
  const pipeline = readJSON(DATA.pipeline);
  const pi = pipeline.findIndex(j => j.jobId === jobId);
  if (pi !== -1) { pipeline[pi].stage = 'returned'; writeJSON(DATA.pipeline, pipeline); }
  res.json({ ok: true, jobId });
});

// Service requests
app.get('/api/service-requests', (req, res) => res.json({ ok: true, requests: readJSON(DATA.serviceRequests) }));

app.post('/api/service-request', (req, res) => {
  const { equipment, issue, reportedBy } = req.body;
  const sr = { id: `SR-${Date.now()}`, equipment, issue, reportedBy, status: 'open', createdAt: new Date().toISOString() };
  const list = readJSON(DATA.serviceRequests);
  list.push(sr);
  writeJSON(DATA.serviceRequests, list);
  res.json({ ok: true, request: sr });
});

const PORT = process.env.OPS_PORT || 3001;
app.listen(PORT, () => console.log(`[Gorilla Ops] Running on port ${PORT}`));

export default app;
