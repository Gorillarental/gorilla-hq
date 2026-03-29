// ============================================================
// OUTCOMES.JS — Win/Loss/Expiry tracking + Handoff writer
// Writes to data/quote-outcomes.json and data/handoffs.json
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OUTCOMES_FILE = path.join(__dirname, 'data/quote-outcomes.json');
const HANDOFFS_FILE = path.join(__dirname, 'data/handoffs.json');

function readJSON(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function msToClose(createdAt, closedAt) {
  try {
    const created = new Date(createdAt);
    const closed  = new Date(closedAt);
    return Math.round((closed - created) / (1000 * 60 * 60 * 24));
  } catch { return 0; }
}

// ─── recordWin ────────────────────────────────────────────────
export async function recordWin(quoteData) {
  const closedAt = new Date().toISOString();
  const entry = {
    id:           `OUTCOME-${Date.now()}`,
    quoteNumber:  quoteData.quoteNumber || quoteData.jobId || '',
    customerName: quoteData.customerName || '',
    customerEmail: quoteData.customerEmail || '',
    equipment:    Array.isArray(quoteData.equipment)
      ? quoteData.equipment.map(e => e.name || e.sku).join(', ')
      : (quoteData.equipment || ''),
    quotedTotal:  quoteData.total || 0,
    outcome:      'won',
    lostReason:   '',
    closedAt,
    daysToClose:  msToClose(quoteData.createdAt, closedAt),
  };

  const file = readJSON(OUTCOMES_FILE, { outcomes: [] });
  file.outcomes.push(entry);
  writeJSON(OUTCOMES_FILE, file);
  console.log(`[Outcomes] Win recorded: ${entry.quoteNumber}`);
  return entry;
}

// ─── recordLoss ───────────────────────────────────────────────
export async function recordLoss(quoteData, reason = '') {
  const closedAt = new Date().toISOString();
  const entry = {
    id:           `OUTCOME-${Date.now()}`,
    quoteNumber:  quoteData.quoteNumber || quoteData.jobId || '',
    customerName: quoteData.customerName || '',
    customerEmail: quoteData.customerEmail || '',
    equipment:    Array.isArray(quoteData.equipment)
      ? quoteData.equipment.map(e => e.name || e.sku).join(', ')
      : (quoteData.equipment || ''),
    quotedTotal:  quoteData.total || 0,
    outcome:      'lost',
    lostReason:   reason,
    closedAt,
    daysToClose:  msToClose(quoteData.createdAt, closedAt),
  };

  const file = readJSON(OUTCOMES_FILE, { outcomes: [] });
  file.outcomes.push(entry);
  writeJSON(OUTCOMES_FILE, file);
  console.log(`[Outcomes] Loss recorded: ${entry.quoteNumber} — ${reason}`);
  return entry;
}

// ─── recordExpiry ─────────────────────────────────────────────
export async function recordExpiry(quoteData) {
  const closedAt = new Date().toISOString();
  const entry = {
    id:           `OUTCOME-${Date.now()}`,
    quoteNumber:  quoteData.quoteNumber || quoteData.jobId || '',
    customerName: quoteData.customerName || '',
    customerEmail: quoteData.customerEmail || '',
    equipment:    Array.isArray(quoteData.equipment)
      ? quoteData.equipment.map(e => e.name || e.sku).join(', ')
      : (quoteData.equipment || ''),
    quotedTotal:  quoteData.total || 0,
    outcome:      'expired',
    lostReason:   'No response — quote expired',
    closedAt,
    daysToClose:  msToClose(quoteData.createdAt, closedAt),
  };

  const file = readJSON(OUTCOMES_FILE, { outcomes: [] });
  file.outcomes.push(entry);
  writeJSON(OUTCOMES_FILE, file);
  console.log(`[Outcomes] Expiry recorded: ${entry.quoteNumber}`);
  return entry;
}

// ─── writeHandoff ─────────────────────────────────────────────
export async function writeHandoff(handoffData) {
  const handoffs = readJSON(HANDOFFS_FILE, []);
  // Update existing handoff for same quoteNumber if present
  const idx = handoffs.findIndex(h => h.quoteNumber === handoffData.quoteNumber);
  if (idx >= 0) {
    handoffs[idx] = { ...handoffs[idx], ...handoffData };
  } else {
    handoffs.push(handoffData);
  }
  writeJSON(HANDOFFS_FILE, handoffs);
  console.log(`[Outcomes] Handoff written: ${handoffData.quoteNumber}`);
  return handoffData;
}

// ─── getOutcomeSummary ────────────────────────────────────────
export function getOutcomeSummary() {
  const file = readJSON(OUTCOMES_FILE, { outcomes: [] });
  const outcomes = file.outcomes || [];
  const now   = new Date();
  const month = now.getMonth();
  const year  = now.getFullYear();

  const thisMonth = outcomes.filter(o => {
    const d = new Date(o.closedAt);
    return d.getMonth() === month && d.getFullYear() === year;
  });

  const won     = outcomes.filter(o => o.outcome === 'won').length;
  const lost    = outcomes.filter(o => o.outcome === 'lost').length;
  const expired = outcomes.filter(o => o.outcome === 'expired').length;
  const total   = won + lost + expired;

  const wonThisMonth = thisMonth.filter(o => o.outcome === 'won').reduce((s, o) => s + (o.quotedTotal || 0), 0);

  return {
    won,
    lost,
    expired,
    total,
    winRate:      total > 0 ? `${Math.round((won / total) * 100)}%` : '0%',
    wonThisMonth,
  };
}
