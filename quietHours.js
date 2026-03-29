// ============================================================
// QUIET-HOURS.JS
// No outbound SMS, email, or calls between 6pm and 8am ET.
// If blocked, returns { blocked: true, reason } so the caller
// can surface it to Andrei instead of silently dropping it.
// ============================================================

const QUIET_START = 18; // 6pm
const QUIET_END   = 8;  // 8am
const TZ          = 'America/New_York'; // South Florida

export function isQuietHours() {
  const now  = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: TZ })
      .format(now)
  );
  return hour >= QUIET_START || hour < QUIET_END;
}

export function quietHoursBlock(type = 'message') {
  return {
    blocked: true,
    ok:      false,
    error:   `Quiet hours active (6pm–8am ET). ${type} not sent.`,
    reason:  'quiet_hours',
  };
}

export function formatQuietAlert(type, to, summary) {
  const now = new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
  return `🔕 <b>Quiet hours</b> (${now} ET) — ${type} to <b>${to}</b> was held.\n\n${summary}\n\nReply to send it now or I'll send it after 8am.`;
}
