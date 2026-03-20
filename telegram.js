// ============================================================
// TELEGRAM.JS — Telegram bot notifications for Gorilla HQ
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a message via Telegram Bot API.
 */
export async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Notify Andrei via both WhatsApp (GHL) AND Telegram.
 * Drop-in replacement for notifyAndrei from whatsapp.js.
 */
export async function notifyAll(message) {
  // Send Telegram (always attempted if configured)
  sendTelegram(`🦍 <b>Gorilla HQ</b>\n${escapeHtml(message)}`).catch(() => {});

  // Also send via WhatsApp/GHL
  try {
    const { notifyAndrei } = await import('./whatsapp.js');
    await notifyAndrei(message);
  } catch {}
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Telegram webhook handler (receive messages from Telegram) ──

export function telegramWebhookHandler(req, res) {
  res.sendStatus(200); // Always acknowledge quickly

  const update = req.body;
  const message = update?.message;
  if (!message?.text) return;

  const chatId   = message.chat.id;
  const text     = message.text.trim();
  const fromName = message.from?.first_name ?? 'Unknown';

  console.log(`[Telegram] Message from ${fromName} (${chatId}): ${text}`);

  // Forward to the main WhatsApp/agent handler logic
  handleTelegramCommand(chatId, text, fromName).catch(console.error);
}

async function handleTelegramCommand(chatId, text, fromName) {
  const lower = text.toLowerCase();

  // Basic commands
  if (lower === '/start' || lower === 'hi' || lower === 'hello') {
    await sendTelegram(`👋 Hey ${fromName}! Gorilla HQ is online.\n\nAvailable commands:\n/status — system status\n/pipeline — active rentals\n/approvals — pending approvals`);
    return;
  }

  if (lower === '/status' || lower === 'status') {
    await sendTelegram(`✅ <b>Gorilla HQ Status</b>\nAll agents running.\nTimestamp: ${new Date().toLocaleString()}`);
    return;
  }

  // Forward everything else to the main agent (chip)
  try {
    const { chipChat } = await import('./chip.js');
    const reply = await chipChat(text, `telegram_${chatId}`);
    if (reply) await sendTelegram(escapeHtml(reply));
  } catch {
    await sendTelegram('⚠️ Agent unavailable. Try again in a moment.');
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
