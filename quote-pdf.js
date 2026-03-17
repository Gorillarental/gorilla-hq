// ============================================================
// QUOTE-PDF.JS — Branded PDF generation (PDFKit)
// ============================================================

import PDFDocument from 'pdfkit';

const LOGO_URL = 'https://gorillarental.us/wp-content/uploads/2025/12/Untitled-design-2.png';
const YELLOW   = '#f6ec0e';
const BLACK    = '#111111';
const GRAY     = '#555555';
const LGRAY    = '#dddddd';
const STRIPE   = '#f7f7f7';

const PAGE_W  = 595.28;
const MARGIN  = 48;
const CONTENT = PAGE_W - MARGIN * 2;  // 499.28

const COL = {
  name:   MARGIN,
  qty:    MARGIN + 224,
  period: MARGIN + 268,
  amount: MARGIN + 386,
};

async function fetchLogoBuffer() {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function line(doc, x, y, w, color = LGRAY, h = 0.75) {
  doc.rect(x, y, w, h).fill(color);
}

// Yellow background, black text section headers
function sectionHeader(doc, label, y) {
  doc.rect(MARGIN, y, CONTENT, 20).fill(YELLOW);
  doc.fillColor(BLACK).fontSize(8.5).font('Helvetica-Bold')
     .text(label, MARGIN + 8, y + 6, { width: CONTENT - 16, characterSpacing: 0.8 });
  return y + 20;
}

function twoCol(doc, left, right, y, labelColor = GRAY, valueColor = BLACK) {
  const mid = MARGIN + CONTENT / 2;
  doc.fillColor(labelColor).fontSize(8).font('Helvetica')
     .text(left[0], MARGIN, y, { width: 90 });
  doc.fillColor(valueColor).fontSize(8).font('Helvetica-Bold')
     .text(left[1], MARGIN + 92, y, { width: CONTENT / 2 - 96 });
  if (right) {
    doc.fillColor(labelColor).fontSize(8).font('Helvetica')
       .text(right[0], mid, y, { width: 80 });
    doc.fillColor(valueColor).fontSize(8).font('Helvetica-Bold')
       .text(right[1], mid + 82, y, { width: CONTENT / 2 - 86 });
  }
  return y + 16;
}

export async function generateQuotePDF(html, quote) {
  const q      = quote || {};
  const today  = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const logoBuffer = await fetchLogoBuffer();

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Gorilla Rental Quote ${q.jobId || ''}`, Author: 'Gorilla Rental' } });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── HEADER BAND — yellow bg, black text ──────────────────
    doc.rect(0, 0, PAGE_W, 82).fill(YELLOW);

    // Logo
    if (logoBuffer) {
      doc.image(logoBuffer, MARGIN, 12, { height: 56, fit: [180, 56] });
    } else {
      doc.rect(MARGIN, 16, 44, 44).fill(BLACK);
      doc.fillColor(YELLOW).fontSize(26).font('Helvetica-Bold').text('G', MARGIN + 10, 24);
      doc.fillColor(BLACK).fontSize(17).font('Helvetica-Bold')
         .text('GORILLA RENTAL', MARGIN + 56, 22, { characterSpacing: 1 });
    }

    // Document type + job ID (right side)
    doc.fillColor(BLACK).fontSize(14).font('Helvetica-Bold')
       .text('RENTAL QUOTE', MARGIN, 22, { width: CONTENT, align: 'right' });
    doc.fillColor('#444444').fontSize(8.5).font('Helvetica')
       .text(q.jobId || '', MARGIN, 42, { width: CONTENT, align: 'right' });
    doc.fillColor('#444444').fontSize(8).font('Helvetica')
       .text(today, MARGIN, 55, { width: CONTENT, align: 'right' });

    // Black accent bar below header
    doc.rect(0, 82, PAGE_W, 4).fill(BLACK);

    let y = 104;

    // ── CUSTOMER INFORMATION ─────────────────────────────────
    y = sectionHeader(doc, 'CUSTOMER INFORMATION', y);
    y += 8;
    y = twoCol(doc, ['Name',  q.customerName  || '—'], ['Phone',    q.customerPhone   || '—'], y);
    y = twoCol(doc, ['Email', q.customerEmail || '—'], ['Delivery', q.deliveryAddress || 'South Florida'], y);
    y += 6;
    line(doc, MARGIN, y, CONTENT);
    y += 12;

    // ── RENTAL PERIOD ────────────────────────────────────────
    y = sectionHeader(doc, 'RENTAL PERIOD', y);
    y += 8;
    y = twoCol(doc, ['Start Date', q.startDate || 'TBD'], ['End Date', q.endDate || 'TBD'], y);
    y = twoCol(doc, ['Duration',   q.duration  || 'TBD'], null, y);
    y += 6;
    line(doc, MARGIN, y, CONTENT);
    y += 12;

    // ── EQUIPMENT TABLE ──────────────────────────────────────
    y = sectionHeader(doc, 'EQUIPMENT', y);

    // Column headers — yellow bg, black text
    y += 2;
    doc.rect(MARGIN, y, CONTENT, 18).fill('#e8dc00');  // slightly darker yellow for contrast
    doc.fillColor(BLACK).fontSize(7.5).font('Helvetica-Bold');
    doc.text('DESCRIPTION',  COL.name   + 4, y + 5, { width: 216 });
    doc.text('QTY',          COL.qty,         y + 5, { width: 36, align: 'center' });
    doc.text('PERIOD',       COL.period  + 4, y + 5, { width: 106 });
    doc.text('AMOUNT',       COL.amount  + 4, y + 5, { width: 109, align: 'right' });
    y += 18;

    // Equipment rows
    (q.equipment || []).forEach((e, idx) => {
      const rowH = 22;
      if (idx % 2 === 1) doc.rect(MARGIN, y, CONTENT, rowH).fill(STRIPE);
      doc.fillColor(BLACK).fontSize(9).font('Helvetica-Bold')
         .text(e.name || '—', COL.name + 4, y + 7, { width: 216 });
      doc.fillColor(GRAY).fontSize(8.5).font('Helvetica')
         .text(String(e.quantity || 1), COL.qty,         y + 7, { width: 36, align: 'center' })
         .text(e.rentalPeriod || '—',   COL.period  + 4, y + 7, { width: 106 })
         .text(`$${(e.total || 0).toFixed(2)}`, COL.amount + 4, y + 7, { width: 109, align: 'right' });
      line(doc, MARGIN, y + rowH, CONTENT, '#eeeeee');
      y += rowH;
    });

    // Delivery row
    doc.rect(MARGIN, y, CONTENT, 22).fill(STRIPE);
    doc.fillColor(BLACK).fontSize(9).font('Helvetica-Bold')
       .text('Delivery & Setup Fee', COL.name + 4, y + 7, { width: 216 });
    doc.fillColor(GRAY).fontSize(8.5).font('Helvetica')
       .text('Flat rate', COL.period + 4, y + 7, { width: 106 })
       .text('$200.00',   COL.amount + 4, y + 7, { width: 109, align: 'right' });
    y += 22;
    line(doc, MARGIN, y, CONTENT, LGRAY);
    y += 16;

    // ── TOTALS ───────────────────────────────────────────────
    const TX = MARGIN + CONTENT - 210;

    const addTotalRow = (label, value, bold = false) => {
      doc.fillColor(bold ? BLACK : GRAY).fontSize(bold ? 10.5 : 8.5)
         .font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, TX, y, { width: 115 });
      doc.fillColor(bold ? BLACK : GRAY).fontSize(bold ? 10.5 : 8.5)
         .font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(value, TX + 115, y, { width: 95, align: 'right' });
      y += bold ? 15 : 13;
    };

    addTotalRow('Subtotal', `$${(q.subtotal || 0).toFixed(2)}`);
    addTotalRow('Tax (7%)', `$${(q.tax     || 0).toFixed(2)}`);
    y += 2;
    line(doc, TX, y, 210, BLACK, 1.5);
    y += 6;
    addTotalRow('TOTAL DUE', `$${(q.total || 0).toFixed(2)}`, true);
    y += 18;

    // ── DEPOSIT CTA ──────────────────────────────────────────
    line(doc, MARGIN, y, CONTENT);
    y += 14;
    doc.rect(MARGIN, y, CONTENT, 56).fill('#fffde7');
    doc.rect(MARGIN, y, 4, 56).fill(YELLOW);

    doc.fillColor(BLACK).fontSize(10.5).font('Helvetica-Bold')
       .text('Confirm Your Reservation', MARGIN + 14, y + 10, { width: CONTENT - 130 });
    doc.fillColor(GRAY).fontSize(8.5).font('Helvetica')
       .text('A $150.00 deposit is required to hold your equipment.\nPay securely online:', MARGIN + 14, y + 26, { width: CONTENT - 130 });
    if (q.depositLink) {
      doc.fillColor('#0055cc').fontSize(8).font('Helvetica')
         .text(q.depositLink, MARGIN + 14, y + 44, { width: CONTENT - 130, link: q.depositLink });
    }

    // Deposit pill — yellow bg, black text
    doc.rect(PAGE_W - MARGIN - 104, y + 8, 104, 38).fill(YELLOW);
    doc.fillColor(BLACK).fontSize(8.5).font('Helvetica-Bold')
       .text('DEPOSIT DUE', PAGE_W - MARGIN - 100, y + 13, { width: 96, align: 'center' });
    doc.fillColor(BLACK).fontSize(15).font('Helvetica-Bold')
       .text('$150.00', PAGE_W - MARGIN - 100, y + 26, { width: 96, align: 'center' });
    y += 56 + 14;

    // ── NOTES ────────────────────────────────────────────────
    if (q.notes) {
      line(doc, MARGIN, y, CONTENT);
      y += 10;
      doc.fillColor(GRAY).fontSize(8.5).font('Helvetica-Bold').text('NOTES', MARGIN, y);
      y += 13;
      doc.fillColor(GRAY).fontSize(8.5).font('Helvetica').text(q.notes, MARGIN, y, { width: CONTENT });
    }

    // ── FOOTER — yellow bg, black text ───────────────────────
    const footerY = 841.89 - 46;
    doc.rect(0, footerY - 2, PAGE_W, 2).fill(BLACK);
    doc.rect(0, footerY,     PAGE_W, 48).fill(YELLOW);

    if (logoBuffer) {
      doc.image(logoBuffer, MARGIN, footerY + 7, { height: 28, fit: [90, 28] });
    } else {
      doc.fillColor(BLACK).fontSize(10).font('Helvetica-Bold')
         .text('GORILLA RENTAL', MARGIN, footerY + 16, { width: 160 });
    }

    doc.fillColor('#333333').fontSize(8).font('Helvetica')
       .text('+1 (447) 474-4549  |  info@gorillarental.us  |  gorillarental.us',
             MARGIN, footerY + 17, { width: CONTENT, align: 'right' });

    doc.end();
  });
}

// ── HTML EMAIL TEMPLATE ──────────────────────────────────────
export function buildQuoteEmailHTML(quote) {
  const q     = quote || {};
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const equipRows = (q.equipment || []).map((e, i) => `
    <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f9f9f9'}">
      <td style="padding:11px 14px;font-size:14px;color:#111;font-weight:600;border-bottom:1px solid #eeeeee">${e.name || '—'}</td>
      <td style="padding:11px 14px;font-size:14px;color:#555;text-align:center;border-bottom:1px solid #eeeeee">${e.quantity || 1}</td>
      <td style="padding:11px 14px;font-size:14px;color:#555;border-bottom:1px solid #eeeeee">${e.rentalPeriod || '—'}</td>
      <td style="padding:11px 14px;font-size:14px;color:#111;font-weight:700;text-align:right;border-bottom:1px solid #eeeeee">$${(e.total || 0).toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Gorilla Rental Quote — ${q.jobId || ''}</title></head>
<body style="margin:0;padding:0;background:#e8e8e8;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e8;padding:36px 16px">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">

  <!-- HEADER — yellow bg, black text -->
  <tr><td style="background:#f6ec0e;border-radius:12px 12px 0 0;padding:24px 36px 20px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle">
          <img src="${LOGO_URL}" alt="Gorilla Rental" height="54" style="display:block;height:54px;max-width:200px">
        </td>
        <td align="right" style="vertical-align:middle">
          <div style="color:#111111;font-size:13px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase">Rental Quote</div>
          <div style="color:#444444;font-size:11px;margin-top:5px">${q.jobId || ''}</div>
          <div style="color:#555555;font-size:11px;margin-top:2px">${today}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- BLACK BAR -->
  <tr><td style="background:#111111;height:5px;font-size:5px;line-height:5px">&nbsp;</td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:36px 36px 28px">

    <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 10px">Hi ${q.customerName?.split(' ')[0] || 'there'}!</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 32px">
      Thanks for reaching out to <strong style="color:#111">Gorilla Rental</strong>. Your custom equipment quote is ready — details below and attached as a PDF.
      When you're ready to lock in your dates, use the deposit link at the bottom.
    </p>

    <!-- Rental details card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
      <tr><td style="background:#f6ec0e;padding:11px 18px">
        <span style="color:#111111;font-size:11px;font-weight:700;letter-spacing:1.2px">RENTAL DETAILS</span>
      </td></tr>
      <tr><td style="background:#fafafa;padding:18px">
        <table width="100%" cellpadding="0" cellspacing="4">
          <tr>
            <td style="font-size:12px;color:#999;width:38%;padding:5px 0">Customer</td>
            <td style="font-size:13px;color:#111;font-weight:700;padding:5px 0">${q.customerName || '—'}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#999;padding:5px 0">Phone</td>
            <td style="font-size:13px;color:#111;font-weight:700;padding:5px 0">${q.customerPhone || '—'}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#999;padding:5px 0">Delivery Address</td>
            <td style="font-size:13px;color:#111;font-weight:700;padding:5px 0">${q.deliveryAddress || 'South Florida'}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#999;padding:5px 0">Rental Period</td>
            <td style="font-size:13px;color:#111;font-weight:700;padding:5px 0">${q.startDate || 'TBD'} → ${q.endDate || 'TBD'}&nbsp;&nbsp;<span style="color:#888;font-weight:400">(${q.duration || ''})</span></td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- Equipment table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
      <tr style="background:#f6ec0e">
        <th style="padding:11px 14px;font-size:11px;color:#111111;font-weight:700;letter-spacing:1px;text-align:left">EQUIPMENT</th>
        <th style="padding:11px 14px;font-size:11px;color:#111111;font-weight:700;letter-spacing:1px;text-align:center;width:50px">QTY</th>
        <th style="padding:11px 14px;font-size:11px;color:#111111;font-weight:700;letter-spacing:1px;text-align:left;width:120px">PERIOD</th>
        <th style="padding:11px 14px;font-size:11px;color:#111111;font-weight:700;letter-spacing:1px;text-align:right;width:100px">AMOUNT</th>
      </tr>
      ${equipRows}
      <tr style="background:#f5f5f5">
        <td style="padding:11px 14px;font-size:13px;color:#666;border-bottom:1px solid #eee">Delivery &amp; Setup Fee</td>
        <td style="border-bottom:1px solid #eee"></td>
        <td style="padding:11px 14px;font-size:13px;color:#888;border-bottom:1px solid #eee">Flat rate</td>
        <td style="padding:11px 14px;font-size:13px;color:#666;text-align:right;border-bottom:1px solid #eee">$200.00</td>
      </tr>
    </table>

    <!-- Totals -->
    <table cellpadding="0" cellspacing="0" align="right" style="margin-bottom:32px;min-width:230px">
      <tr>
        <td style="padding:5px 0;font-size:13px;color:#888;padding-right:28px">Subtotal</td>
        <td style="padding:5px 0;font-size:13px;color:#555;text-align:right;min-width:90px">$${(q.subtotal || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:5px 0;font-size:13px;color:#888;padding-right:28px">Tax (7%)</td>
        <td style="padding:5px 0;font-size:13px;color:#555;text-align:right">$${(q.tax || 0).toFixed(2)}</td>
      </tr>
      <tr><td colspan="2" style="padding-top:6px;padding-bottom:6px"><div style="border-top:2px solid #111"></div></td></tr>
      <tr>
        <td style="font-size:17px;font-weight:800;color:#111;padding-right:28px">TOTAL</td>
        <td style="font-size:17px;font-weight:800;color:#111;text-align:right">$${(q.total || 0).toFixed(2)}</td>
      </tr>
    </table>

    <div style="clear:both"></div>

    <!-- Deposit CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border-radius:10px;overflow:hidden;border:1px solid #e8dc00;background:#fffde7">
      <tr><td style="padding:22px 26px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:16px;font-weight:800;color:#111;margin-bottom:7px">Ready to lock in your dates?</div>
              <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:18px">
                A <strong style="color:#111">$150 deposit</strong> secures your equipment.
                Your balance is due on delivery. Pay securely via Stripe:
              </div>
              ${q.depositLink ? `
              <a href="${q.depositLink}" style="display:inline-block;background:#f6ec0e;color:#111111;font-size:14px;font-weight:800;padding:13px 30px;border-radius:7px;text-decoration:none;letter-spacing:0.5px;border:2px solid #111">
                PAY $150 DEPOSIT &rarr;
              </a>` : ''}
            </td>
            <td align="right" style="vertical-align:top;padding-left:16px;white-space:nowrap">
              <div style="background:#f6ec0e;border:2px solid #111;border-radius:8px;padding:12px 20px;text-align:center">
                <div style="font-size:10px;font-weight:700;color:#111;letter-spacing:1px;margin-bottom:2px">DEPOSIT</div>
                <div style="font-size:22px;font-weight:900;color:#111">$150</div>
              </div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <p style="font-size:13px;color:#999;margin:0;line-height:1.6">
      Questions? Reply to this email or call <strong style="color:#111">+1 (447) 474-4549</strong>.
      We're here to help — the Gorilla Rental team.
    </p>

  </td></tr>

  <!-- FOOTER — yellow bg, black text -->
  <tr><td style="background:#111111;height:3px;font-size:3px;line-height:3px">&nbsp;</td></tr>
  <tr><td style="background:#f6ec0e;border-radius:0 0 12px 12px;padding:18px 36px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle">
          <img src="${LOGO_URL}" alt="Gorilla Rental" height="32" style="height:32px;display:block">
        </td>
        <td align="right" style="vertical-align:middle">
          <span style="color:#333;font-size:11px">+1 (447) 474-4549</span>
          <span style="color:#555;margin:0 5px">|</span>
          <span style="color:#333;font-size:11px">info@gorillarental.us</span>
          <span style="color:#555;margin:0 5px">|</span>
          <a href="https://gorillarental.us" style="color:#111;font-size:11px;font-weight:700;text-decoration:none">gorillarental.us</a>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// legacy alias
export function buildQuoteHTML(quote) {
  return buildQuoteEmailHTML(quote);
}
