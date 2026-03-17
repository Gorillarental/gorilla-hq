// ============================================================
// KNOWLEDGE.JS — Learning Agent
// Learns from data, answers queries, weekly reports
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client    = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

const DATA = {
  knowledge: path.join(__dirname, 'data/knowledge.json'),
  pipeline:  path.join(__dirname, 'data/pipeline.json'),
};

function readJSON(fp, fallback = {}) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

export async function teach(title, content, materialType = 'general') {
  const knowledge = readJSON(DATA.knowledge);
  if (!knowledge.entries) knowledge.entries = [];

  knowledge.entries.push({
    id:           `KN-${Date.now()}`,
    title,
    materialType,
    content,
    addedAt:      new Date().toISOString(),
  });

  writeJSON(DATA.knowledge, knowledge);
  console.log(`[Knowledge] ✅ Learned: ${title}`);
  return { ok: true, title, materialType };
}

export async function query(question) {
  const knowledge = readJSON(DATA.knowledge);
  const pipeline  = readJSON(DATA.pipeline, []);

  const context = (knowledge.entries || [])
    .map(e => `[${e.materialType}] ${e.title}:\n${e.content}`)
    .join('\n\n---\n\n');

  const pipelineSummary = Array.isArray(pipeline)
    ? pipeline.slice(-10).map(j =>
        `${j.jobId} | ${j.customerName} | ${j.stage} | $${j.total?.toFixed(2) || '?'} | ${j.startDate || '?'} → ${j.endDate || '?'}`
      ).join('\n')
    : 'No pipeline data';

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    system: `You are the knowledge base for Gorilla Rental — a boom lift and scissor lift rental company in South Florida.
You have access to training materials, equipment specs, past rental data, and market intelligence.
Answer questions accurately and helpfully. If you don't know something, say so.

KNOWLEDGE BASE:
${context || 'No training material yet.'}

RECENT PIPELINE:
${pipelineSummary}`,
    messages: [{ role: 'user', content: question }],
  });

  return { answer: response.content[0].text, question };
}

export async function weeklyReport() {
  const pipeline = readJSON(DATA.pipeline, []);
  const now      = new Date();
  const weekAgo  = new Date(now.getTime() - 7 * 86400000);

  const weekJobs = Array.isArray(pipeline)
    ? pipeline.filter(j => new Date(j.createdAt || 0) >= weekAgo)
    : [];

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{
      role:    'user',
      content: `Generate a weekly business report for Gorilla Rental based on this data:

JOBS THIS WEEK (${weekJobs.length} total):
${weekJobs.map(j => `${j.jobId} | ${j.customerName} | ${j.stage} | $${j.total?.toFixed(2) || '?'}`).join('\n') || 'None'}

PIPELINE TOTALS:
Total jobs: ${pipeline.length}
Completed: ${pipeline.filter(j => j.stage === 'completed').length}
Active: ${pipeline.filter(j => j.stage === 'in_progress').length}
Quoted: ${pipeline.filter(j => j.stage === 'quote_sent').length}
Total revenue (closed): $${pipeline.filter(j => j.stage === 'completed').reduce((s, j) => s + (j.total || 0), 0).toFixed(2)}

Write a concise weekly summary with: jobs won, revenue, trends, and 2-3 recommendations.`,
    }],
  });

  return { report: response.content[0].text, generatedAt: now.toISOString() };
}

export function knowledgeRoutes(app) {
  app.post('/knowledge', async (req, res) => {
    try {
      const { type, title, content, material_type, question } = req.body;
      if (type === 'teach') {
        const result = await teach(title, content, material_type || 'general');
        res.json({ ok: true, ...result });
      } else if (type === 'query') {
        const result = await query(question);
        res.json({ ok: true, ...result });
      } else if (type === 'report') {
        const result = await weeklyReport();
        res.json({ ok: true, ...result });
      } else {
        res.status(400).json({ ok: false, error: 'type must be teach, query, or report' });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/knowledge', (req, res) => {
    try {
      const knowledge = readJSON(DATA.knowledge);
      res.json({ ok: true, entries: knowledge.entries || [], total: (knowledge.entries || []).length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('[Knowledge] ✅ Routes registered');
}
