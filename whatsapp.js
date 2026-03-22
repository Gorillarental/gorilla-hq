// ============================================================
// WHATSAPP.JS — Andrei approval workflow via GHL SMS/WhatsApp
// ============================================================

import { sendSMS } from './ghl.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEmailWithPDF } from './chip.js';

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const APPROVALS_FILE  = path.join(__dirname, 'data', 'approvals.json');
const ANDREI_WHATSAPP = '+15619286999';
const JEFF_EMAIL      = 'jeff@grouplandev.com';

// ─── File helpers ───────────────────────────────────────────

function loadApprovals() {
  try {
    if (!fs.existsSync(APPROVALS_FILE)) {
      fs.writeFileSync(APPROVALS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveApprovals(approvals) {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));
}

// ─── Notify Andrei ──────────────────────────────────────────

export async function notifyAndrei(message) {
  return sendSMS(ANDREI_WHATSAPP, message);
}

// ─── Request Approval ───────────────────────────────────────

export async function requestApproval(approvalId, message, metadata = {}) {
  const approvals = loadApprovals();

  const approval = {
    id:        approvalId,
    message,
    metadata,
    status:    'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    reminders:  [],
  };

  approvals.push(approval);
  saveApprovals(approvals);

  // Primary: Telegram inline keyboard (tap to approve/deny)
  try {
    const { sendApprovalRequest } = await import('./telegram.js');
    await sendApprovalRequest(approvalId, message, metadata);
  } catch {}

  // Backup: WhatsApp SMS
  await notifyAndrei(message).catch(() => {});

  console.log(`[WhatsApp] ✅ Approval requested: ${approvalId}`);
  return approvalId;
}

// ─── Check Approval ─────────────────────────────────────────

export async function checkApproval(approvalId) {
  const approvals = loadApprovals();
  return approvals.find(a => a.id === approvalId) || null;
}

// ─── Grant Approval ─────────────────────────────────────────

export async function grantApproval(approvalId) {
  const approvals = loadApprovals();
  const idx = approvals.findIndex(a => a.id === approvalId);
  if (idx === -1) throw new Error(`Approval ${approvalId} not found`);
  approvals[idx].status     = 'approved';
  approvals[idx].resolvedAt = new Date().toISOString();
  saveApprovals(approvals);
  console.log(`[WhatsApp] ✅ Approved: ${approvalId}`);
  return approvals[idx];
}

// ─── Deny Approval ──────────────────────────────────────────

export async function denyApproval(approvalId) {
  const approvals = loadApprovals();
  const idx = approvals.findIndex(a => a.id === approvalId);
  if (idx === -1) throw new Error(`Approval ${approvalId} not found`);
  approvals[idx].status     = 'denied';
  approvals[idx].resolvedAt = new Date().toISOString();
  saveApprovals(approvals);
  console.log(`[WhatsApp] ❌ Denied: ${approvalId}`);
  return approvals[idx];
}

// ─── List Pending ───────────────────────────────────────────

export async function listPendingApprovals() {
  const approvals = loadApprovals();
  return approvals.filter(a => a.status === 'pending');
}

// ─── Stale Reminder ─────────────────────────────────────────

export async function sendReminderIfStale() {
  const approvals = loadApprovals();
  const now       = Date.now();

  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;

    const ageMs   = now - new Date(approval.createdAt).getTime();
    const ageHrs  = ageMs / (1000 * 60 * 60);

    if (ageHrs >= 2) {
      const reminderCount = approval.reminders?.length || 0;
      const lastReminder  = approval.reminders?.[reminderCount - 1];
      const lastReminderAge = lastReminder
        ? (now - new Date(lastReminder).getTime()) / (1000 * 60 * 60)
        : 999;

      // Only send one reminder per hour
      if (lastReminderAge >= 1) {
        const msg = `⏰ REMINDER — Approval still pending (${Math.floor(ageHrs)}h old)\nID: ${approval.id}\n\n${approval.message}`;

        try {
          await notifyAndrei(msg);
          approval.reminders = [...(approval.reminders || []), new Date().toISOString()];
          console.log(`[WhatsApp] Reminder sent for ${approval.id}`);
        } catch (err) {
          console.error(`[WhatsApp] Reminder failed: ${err.message}`);
        }
      }
    }

    // After 4 hours: also email Jeff
    if (ageHrs >= 4) {
      const jeffAlerted = approval.jeffAlerted;
      if (!jeffAlerted) {
        try {
          await sendEmailWithPDF({
            to:      JEFF_EMAIL,
            subject: `[Gorilla Rental] Stale Approval — ${approval.id}`,
            body:    `Approval has been pending for ${Math.floor(ageHrs)} hours with no response from Andrei.\n\nApproval ID: ${approval.id}\n\nDetails:\n${approval.message}`,
          });
          approval.jeffAlerted = true;
          console.log(`[WhatsApp] Jeff alerted for stale approval: ${approval.id}`);
        } catch (err) {
          console.error(`[WhatsApp] Jeff email failed: ${err.message}`);
        }
      }
    }
  }

  saveApprovals(approvals);
}
