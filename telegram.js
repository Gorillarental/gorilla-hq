// ============================================================
// TELEGRAM.JS — Full Telegram interface for Gorilla IQ
// - Inbound message routing via Gorilla IQ
// - Inline keyboard approvals (YES/NO buttons)
// - Photo/document → receipt processing
// - Multi-chat support
// ============================================================

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT   = process.env.TELEGRAM_CHAT_ID;   // Andrei's personal chat
const API_BASE     = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Core send helpers ────────────────────────────────────────

export async function sendTelegram(text, chatId = OWNER_CHAT) {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        text:       text.slice(0, 4096), // Telegram max
        parse_mode: 'HTML',
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendInlineKeyboard(chatId, text, buttons) {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:      chatId,
        text:         text.slice(0, 4096),
        parse_mode:   'HTML',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '✅') {
  if (!BOT_TOKEN) return;
  await fetch(`${API_BASE}/answerCallbackQuery`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

async function editMessageText(chatId, messageId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`${API_BASE}/editMessageText`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    chatId,
      message_id: messageId,
      text:       text.slice(0, 4096),
      parse_mode: 'HTML',
    }),
  }).catch(() => {});
}

async function downloadFile(fileId) {
  if (!BOT_TOKEN) return null;
  try {
    const infoRes = await fetch(`${API_BASE}/getFile?file_id=${fileId}`);
    const info    = await infoRes.json();
    const path    = info?.result?.file_path;
    if (!path) return null;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`);
    return Buffer.from(await fileRes.arrayBuffer());
  } catch {
    return null;
  }
}

// ─── Approval requests (with inline YES/NO buttons) ──────────

export async function sendApprovalRequest(approvalId, message, metadata = {}, chatId = OWNER_CHAT) {
  const buttons = [[
    { text: '✅ Approve', callback_data: `approve:${approvalId}` },
    { text: '❌ Deny',    callback_data: `deny:${approvalId}`    },
  ]];
  return sendInlineKeyboard(chatId, message, buttons);
}

// ─── notifyAll — kept for backwards compatibility ─────────────

export async function notifyAll(message, chatId = OWNER_CHAT) {
  await sendTelegram(`🦍 <b>Gorilla HQ</b>\n${escapeHtml(message)}`, chatId).catch(() => {});
  try {
    const { notifyAndrei } = await import('./whatsapp.js');
    await notifyAndrei(message);
  } catch {}
}

// ─── HTML escape ──────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Typing indicator ─────────────────────────────────────────

async function sendTyping(chatId) {
  await fetch(`${API_BASE}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

// ─── Handle text messages via Gorilla IQ ─────────────────────

async function handleTextMessage(message) {
  const chatId   = String(message.chat.id);
  const text     = message.text?.trim() ?? '';
  const fromName = message.from?.first_name ?? 'there';

  if (!text) return;

  // Built-in commands
  if (text === '/start') {
    await sendTelegram(
      `👋 Hey ${fromName}! <b>Gorilla IQ</b> is online.\n\nI'm the master brain for Gorilla Rental. Just tell me what you need:\n\n• "Create a quote for 2 boom lifts"\n• "Send a $500 Stripe link to John"\n• "What's today's schedule?"\n• "Status of active rentals"\n• "Create a Stripe link for $1,500"\n\n/status — Quick overview`,
      chatId
    );
    return;
  }

  if (text === '/status') {
    await sendTyping(chatId);
    const { getStatusSummary } = await import('./gorilla-iq.js');
    const summary = await getStatusSummary();
    await sendTelegram(summary, chatId);
    return;
  }

  if (text === '/help') {
    await sendTelegram(
      `🦍 <b>Gorilla IQ Commands</b>\n\n<b>Quotes</b>\n"Quote for 40ft boom lift, 7 days, Miami"\n\n<b>Payments</b>\n"Stripe link $500 for deposit"\n\n<b>Ops</b>\n"Today's deliveries"\n"Schedule pickup for Job GR-2026-0012"\n\n<b>Finance</b>\n"Monthly revenue report"\n"Any rentals ending soon?"\n\n<b>Admin</b>\n"Send contract for GR-2026-0010"\n"Receipt" + attach photo\n\n<b>Marketing</b>\n"Add lead: John Smith, contractor, 305-555-0100"\n\n/status — System overview`,
      chatId
    );
    return;
  }

  // Route through Gorilla IQ
  await sendTyping(chatId);
  try {
    const { gorillaIQ } = await import('./gorilla-iq.js');
    const result = await gorillaIQ(text, chatId);
    if (result.reply) {
      await sendTelegram(escapeHtml(result.reply), chatId);
    }
  } catch (err) {
    console.error('[Telegram] Gorilla IQ error:', err.message);
    await sendTelegram('⚠️ Something went wrong. Try again in a moment.', chatId);
  }
}

// ─── Handle photos and documents (receipts, statements) ───────

async function handleFileMessage(message) {
  const chatId = String(message.chat.id);

  await sendTyping(chatId);
  await sendTelegram('📄 Got your file. Processing…', chatId);

  try {
    // Get the best file: prefer document over compressed photo
    let fileId, fileName, mimeType;

    if (message.document) {
      fileId   = message.document.file_id;
      fileName = message.document.file_name ?? 'file';
      mimeType = message.document.mime_type ?? 'application/octet-stream';
    } else if (message.photo) {
      // photo array — last element is highest res
      const photo = message.photo[message.photo.length - 1];
      fileId   = photo.file_id;
      fileName = 'receipt.jpg';
      mimeType = 'image/jpeg';
    } else {
      return;
    }

    const caption = message.caption?.trim() ?? '';
    const buffer  = await downloadFile(fileId);

    if (!buffer) {
      await sendTelegram('⚠️ Could not download the file. Please try again.', chatId);
      return;
    }

    // Route to admin receipt processing
    const { processReceipt } = await import('./admin.js');
    const result = await processReceipt(buffer, fileName, mimeType, {
      note:   caption || undefined,
      source: 'telegram',
    });

    const msg = [
      '✅ <b>Receipt processed</b>',
      result.vendor   ? `🏪 Vendor: ${result.vendor}`   : null,
      result.amount   ? `💰 Amount: $${result.amount}`   : null,
      result.category ? `📂 Category: ${result.category}` : null,
      result.date     ? `📅 Date: ${result.date}`        : null,
      result.sharePointUrl ? `📁 Saved to SharePoint` : null,
      result.message  ? `\n${result.message}` : null,
    ].filter(Boolean).join('\n');

    await sendTelegram(msg, chatId);
  } catch (err) {
    console.error('[Telegram] File processing error:', err.message);
    await sendTelegram(`⚠️ Could not process file: ${err.message}`, chatId);
  }
}

// ─── Handle inline keyboard callbacks (approval buttons) ──────

async function handleCallbackQuery(query) {
  const callbackId = query.id;
  const chatId     = String(query.message?.chat?.id);
  const messageId  = query.message?.message_id;
  const data       = query.data ?? '';

  const [action, approvalId] = data.split(':');

  if (!approvalId) {
    await answerCallbackQuery(callbackId, '⚠️ Invalid action');
    return;
  }

  try {
    const { grantApproval, denyApproval, listPendingApprovals } = await import('./whatsapp.js');
    const { sendPaymentLink, recordPaymentInCashflow }          = await import('./admin.js');

    if (action === 'approve') {
      await grantApproval(approvalId);
      await answerCallbackQuery(callbackId, '✅ Approved');

      // Execute post-approval actions
      const approvals = await listPendingApprovals().catch(() => []);
      const approval  = approvals.find(a => a.id === approvalId);
      const meta      = approval?.metadata ?? {};

      if (meta.type === 'deposit' || meta.type === 'balance') {
        await sendPaymentLink(meta.jobId, meta.type).catch(() => {});
      }
      if (meta.type === 'extra_charge' && meta.jobId && meta.amount) {
        await sendPaymentLink(meta.jobId, 'extra_charge').catch(() => {});
        await recordPaymentInCashflow(meta.jobId, meta.amount, 'income', meta.description || 'Extra charge', 'Extra Charges').catch(() => {});
      }

      await editMessageText(chatId, messageId,
        `✅ <b>APPROVED</b> — ${approvalId}\n${query.message?.text ?? ''}`
      );

    } else if (action === 'deny') {
      await denyApproval(approvalId);
      await answerCallbackQuery(callbackId, '❌ Denied');
      await editMessageText(chatId, messageId,
        `❌ <b>DENIED</b> — ${approvalId}\n${query.message?.text ?? ''}`
      );
    }
  } catch (err) {
    console.error('[Telegram] Callback error:', err.message);
    await answerCallbackQuery(callbackId, '⚠️ Error processing');
  }
}

// ─── Main webhook handler ─────────────────────────────────────

export function telegramWebhookHandler(req, res) {
  res.sendStatus(200); // Always respond fast

  const update = req.body;
  if (!update) return;

  if (update.callback_query) {
    handleCallbackQuery(update.callback_query).catch(err =>
      console.error('[Telegram] Callback error:', err.message)
    );
    return;
  }

  const message = update.message;
  if (!message) return;

  if (message.text) {
    handleTextMessage(message).catch(err =>
      console.error('[Telegram] Text error:', err.message)
    );
  } else if (message.photo || message.document) {
    handleFileMessage(message).catch(err =>
      console.error('[Telegram] File error:', err.message)
    );
  }
}
