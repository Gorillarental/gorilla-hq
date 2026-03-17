// ============================================================
// LOGGER — Activity log and task management for all agents
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSMS } from './ghl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE   = path.join(__dirname, 'data/activity-log.json');
const TASKS_FILE = path.join(__dirname, 'data/tasks.json');

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// ─── logActivity ──────────────────────────────────────────────
export async function logActivity({ agent, action, description, jobId, metadata, status, notify } = {}) {
  const logs = readJSON(LOG_FILE, []);
  const entry = {
    id:          `LOG-${Date.now()}`,
    agent:       agent       || 'system',
    action:      action      || 'action',
    description: description || '',
    jobId:       jobId       || null,
    metadata:    metadata    || {},
    status:      status      || 'success',
    notify:      notify      || false,
    timestamp:   new Date().toISOString(),
  };
  logs.push(entry);
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  writeJSON(LOG_FILE, logs);

  if (notify === true) {
    const emoji = { success: '✅', error: '❌', warning: '⚠️', pending: '⏳' }[entry.status] || '📋';
    await sendSMS('+15619286999', `${emoji} ${description}`).catch(() => {});
  }

  return entry;
}

// ─── createTask ───────────────────────────────────────────────
export async function createTask({ title, description, agent, priority, jobId, dueDate, actionUrl, actionPayload, createdBy } = {}) {
  const tasks = readJSON(TASKS_FILE, []);
  const task = {
    id:            `TASK-${Date.now()}`,
    title:         title         || 'Untitled Task',
    description:   description   || '',
    agent:         agent         || 'system',
    priority:      priority      || 'medium',
    jobId:         jobId         || null,
    dueDate:       dueDate       || null,
    actionUrl:     actionUrl     || null,
    actionPayload: actionPayload || null,
    createdBy:     createdBy     || 'system',
    status:        'pending',
    createdAt:     new Date().toISOString(),
    completedAt:   null,
  };
  tasks.push(task);
  writeJSON(TASKS_FILE, tasks);

  if (priority === 'high') {
    await sendSMS('+15619286999', `🔴 HIGH PRIORITY TASK: ${title}`).catch(() => {});
  }

  return task;
}

// ─── completeTask ─────────────────────────────────────────────
export function completeTask(taskId, notes) {
  const tasks = readJSON(TASKS_FILE, []);
  const idx   = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);
  tasks[idx].status      = 'completed';
  tasks[idx].completedAt = new Date().toISOString();
  tasks[idx].notes       = notes || null;
  writeJSON(TASKS_FILE, tasks);
  return tasks[idx];
}

// ─── dismissTask ──────────────────────────────────────────────
export function dismissTask(taskId) {
  const tasks = readJSON(TASKS_FILE, []);
  const idx   = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);
  tasks[idx].status      = 'dismissed';
  tasks[idx].dismissedAt = new Date().toISOString();
  writeJSON(TASKS_FILE, tasks);
  return tasks[idx];
}

// ─── updateTaskStatus ─────────────────────────────────────────
export function updateTaskStatus(taskId, status) {
  const tasks = readJSON(TASKS_FILE, []);
  const idx   = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);
  tasks[idx].status = status;
  writeJSON(TASKS_FILE, tasks);
  return tasks[idx];
}

// ─── getActivityLog ───────────────────────────────────────────
export function getActivityLog({ agent, limit = 100, hours = 168 } = {}) {
  const logs   = readJSON(LOG_FILE, []);
  const cutoff = new Date(Date.now() - hours * 3600000);
  let result   = logs.filter(l => new Date(l.timestamp) >= cutoff);
  if (agent && agent !== 'all') result = result.filter(l => l.agent === agent);
  result = result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return result.slice(0, limit);
}

// ─── getTasks ─────────────────────────────────────────────────
export function getTasks({ status, agent, priority } = {}) {
  const tasks = readJSON(TASKS_FILE, []);
  let result  = tasks;
  if (status)   result = result.filter(t => t.status === status);
  if (agent)    result = result.filter(t => t.agent === agent);
  if (priority) result = result.filter(t => t.priority === priority);
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return result.sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
}

// ─── loggerRoutes ─────────────────────────────────────────────
export function loggerRoutes(app) {
  app.get('/api/activity', (req, res) => {
    try {
      const { agent, limit, hours } = req.query;
      const logs = getActivityLog({
        agent: agent || undefined,
        limit: limit ? parseInt(limit) : 100,
        hours: hours ? parseInt(hours) : 168,
      });
      res.json({ ok: true, logs, total: logs.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/tasks', (req, res) => {
    try {
      const { status, agent, priority } = req.query;
      const tasks = getTasks({
        status:   status   || undefined,
        agent:    agent    || undefined,
        priority: priority || undefined,
      });
      res.json({ ok: true, tasks, total: tasks.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/tasks', async (req, res) => {
    try {
      const task = await createTask(req.body);
      res.json({ ok: true, task });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/tasks/:taskId/complete', (req, res) => {
    try {
      const task = completeTask(req.params.taskId, req.body.notes);
      res.json({ ok: true, task });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/tasks/:taskId/dismiss', (req, res) => {
    try {
      const task = dismissTask(req.params.taskId);
      res.json({ ok: true, task });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/tasks/:taskId/status', (req, res) => {
    try {
      const task = updateTaskStatus(req.params.taskId, req.body.status);
      res.json({ ok: true, task });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Logger] ✅ Routes registered');
}
