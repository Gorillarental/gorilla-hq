// ============================================================
// CHIP.JS — Email delivery via Microsoft 365 / Azure
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import { isQuietHours, quietHoursBlock } from './quietHours.js';

const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CHIP_EMAIL    = process.env.CHIP_EMAIL;

async function getGraphToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function sendEmailWithPDF({ to, subject, body, htmlBody = null, pdfBuffer = null, pdfName = null, attachments = [] }) {
  if (isQuietHours()) return quietHoursBlock('email');

  const token = await getGraphToken();

  const emailAttachments = [];

  if (pdfBuffer) {
    emailAttachments.push({
      '@odata.type':  '#microsoft.graph.fileAttachment',
      name:           pdfName || 'Gorilla-Rental-Document.pdf',
      contentType:    'application/pdf',
      contentBytes:   pdfBuffer.toString('base64'),
    });
  }

  for (const att of attachments) {
    if (att.buffer) {
      emailAttachments.push({
        '@odata.type':  '#microsoft.graph.fileAttachment',
        name:           att.name || 'attachment.pdf',
        contentType:    att.contentType || 'application/pdf',
        contentBytes:   att.buffer.toString('base64'),
      });
    }
  }

  const message = {
    subject,
    body: {
      contentType: htmlBody ? 'HTML' : 'Text',
      content:     htmlBody || body,
    },
    toRecipients: [
      { emailAddress: { address: to } }
    ],
    attachments: emailAttachments,
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${CHIP_EMAIL}/sendMail`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chip email error: ${err}`);
  }

  console.log(`[Chip] ✅ Email sent to ${to}: ${subject}`);
  return { ok: true, to, subject };
}
