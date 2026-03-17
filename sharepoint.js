// ============================================================
// SHAREPOINT.JS — Microsoft Graph / SharePoint integration
// Gorilla Rental — Cashflow & Receipt management
//
// REQUIRED AZURE PERMISSIONS (Application type):
//   - Sites.ReadWrite.All
//   - Files.ReadWrite.All
//   - Mail.Send (already have)
//
// How to add permissions:
//   portal.azure.com → Azure Active Directory → App registrations
//   → find your CLIENT_ID app → API permissions → Add a permission
//   → Microsoft Graph → Application permissions
//   → add Sites.ReadWrite.All + Files.ReadWrite.All
//   → Grant admin consent
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import * as XLSX from 'xlsx';
import fetch from 'node-fetch';

const TENANT_ID     = process.env.TENANT_ID;
const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const SITE_NAME     = 'GorillaRental';
const CASHFLOW_FILE = 'Gorilla Cash flow.xlsx';

// ─── Auth ───────────────────────────────────────────────────

async function getToken() {
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

async function getSiteId(token) {
  const res = await fetch(
    `${GRAPH_BASE}/sites?search=${encodeURIComponent(SITE_NAME)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`getSiteId error: ${JSON.stringify(data)}`);
  const site = data.value?.find(s => s.name === SITE_NAME || s.displayName === SITE_NAME) || data.value?.[0];
  if (!site) throw new Error(`Site "${SITE_NAME}" not found`);
  return site.id;
}

async function getDriveId(token, siteId) {
  const res = await fetch(
    `${GRAPH_BASE}/sites/${siteId}/drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`getDriveId error: ${JSON.stringify(data)}`);
  return data.id;
}

// ─── Helper: get current month folder name ─────────────────

function currentMonthFolder() {
  const now = new Date();
  return now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); // "March 2026"
}

// ─── Read Cashflow ──────────────────────────────────────────

export async function readCashflow() {
  try {
    const token  = await getToken();
    const siteId = await getSiteId(token);
    const driveId = await getDriveId(token, siteId);

    // Download the Excel file from SharePoint root
    const dlRes = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/${encodeURIComponent(CASHFLOW_FILE)}:/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!dlRes.ok) throw new Error(`Download cashflow error: ${dlRes.status} ${await dlRes.text()}`);

    const buffer    = Buffer.from(await dlRes.arrayBuffer());
    const workbook  = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet     = workbook.Sheets[sheetName];
    const rows      = XLSX.utils.sheet_to_json(sheet, { defval: null });

    // Normalize row keys to camelCase fields
    return rows.map(row => ({
      date:        row['Date']        || row['date']        || null,
      description: row['Description'] || row['description'] || null,
      category:    row['Category']    || row['category']    || null,
      amount:      parseFloat(row['Amount'] || row['amount'] || 0) || 0,
      type:        row['Type']        || row['type']        || null,
      jobId:       row['Job ID']      || row['jobId']       || row['JobID'] || null,
      receipt:     row['Receipt']     || row['receipt']     || null,
    }));
  } catch (err) {
    console.error('[SharePoint] readCashflow error:', err.message);
    throw err;
  }
}

// ─── Add Cashflow Entry ─────────────────────────────────────

export async function addCashflowEntry(entry) {
  try {
    const token   = await getToken();
    const siteId  = await getSiteId(token);
    const driveId = await getDriveId(token, siteId);

    // Download current Excel
    const dlRes = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/${encodeURIComponent(CASHFLOW_FILE)}:/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let workbook;
    let sheetName;

    if (dlRes.ok) {
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      workbook  = XLSX.read(buffer, { type: 'buffer' });
      sheetName = workbook.SheetNames[0];
    } else {
      // Create new workbook if file doesn't exist
      workbook  = XLSX.utils.book_new();
      sheetName = 'Cashflow';
      const ws  = XLSX.utils.aoa_to_sheet([['Date','Description','Category','Amount','Type','Job ID','Receipt']]);
      XLSX.utils.book_append_sheet(workbook, ws, sheetName);
    }

    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // If sheet is empty, add headers
    if (!rows.length) {
      rows.push(['Date','Description','Category','Amount','Type','Job ID','Receipt']);
    }

    // Append new row
    rows.push([
      entry.date        || new Date().toISOString().slice(0, 10),
      entry.description || '',
      entry.category    || 'Expense',
      entry.amount      || 0,
      entry.type        || 'expense',
      entry.jobId       || '',
      entry.receipt     || '',
    ]);

    const newSheet = XLSX.utils.aoa_to_sheet(rows);
    workbook.Sheets[sheetName] = newSheet;

    const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Upload buffer back to SharePoint
    const upRes = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/${encodeURIComponent(CASHFLOW_FILE)}:/content`,
      {
        method:  'PUT',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        body: xlsxBuffer,
      }
    );
    if (!upRes.ok) throw new Error(`Upload cashflow error: ${upRes.status} ${await upRes.text()}`);

    console.log(`[SharePoint] ✅ Cashflow entry added: ${entry.description}`);
    return rows.length - 1; // data row count (excluding header)
  } catch (err) {
    console.error('[SharePoint] addCashflowEntry error:', err.message);
    throw err;
  }
}

// ─── Upload Receipt ─────────────────────────────────────────

export async function uploadReceipt(fileBuffer, fileName, mimeType) {
  try {
    const token    = await getToken();
    const siteId   = await getSiteId(token);
    const driveId  = await getDriveId(token, siteId);
    const folder   = currentMonthFolder(); // e.g. "March 2026"

    // Ensure RECEIPTS/Month folder exists
    // POST to /drive/root:/RECEIPTS:/children to create subfolder
    const folderCheckRes = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/RECEIPTS/${folder}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!folderCheckRes.ok) {
      // Create RECEIPTS folder first (ignore error if exists)
      await fetch(
        `${GRAPH_BASE}/drives/${driveId}/root:/RECEIPTS:/children`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: folder,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        }
      ).catch(() => {}); // ignore if already exists
    }

    // Upload file to RECEIPTS/Month folder
    const uploadRes = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/RECEIPTS/${folder}/${encodeURIComponent(fileName)}:/content`,
      {
        method:  'PUT',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': mimeType,
        },
        body: fileBuffer,
      }
    );
    if (!uploadRes.ok) throw new Error(`Upload receipt error: ${uploadRes.status} ${await uploadRes.text()}`);

    const fileData = await uploadRes.json();
    console.log(`[SharePoint] ✅ Receipt uploaded: ${fileName}`);
    return {
      url:             fileData['@microsoft.graph.downloadUrl'] || fileData.downloadUrl || null,
      webUrl:          fileData.webUrl,
      id:              fileData.id,
    };
  } catch (err) {
    console.error('[SharePoint] uploadReceipt error:', err.message);
    throw err;
  }
}

// ─── List Receipts ──────────────────────────────────────────

export async function listReceipts(month) {
  // month = "March 2026" format
  try {
    const token   = await getToken();
    const siteId  = await getSiteId(token);
    const driveId = await getDriveId(token, siteId);

    const res = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/root:/RECEIPTS/${encodeURIComponent(month)}:/children`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`listReceipts error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return (data.value || []).map(item => ({
      name:            item.name,
      webUrl:          item.webUrl,
      size:            item.size,
      createdDateTime: item.createdDateTime,
    }));
  } catch (err) {
    console.error('[SharePoint] listReceipts error:', err.message);
    throw err;
  }
}

// ─── Cashflow Summary ───────────────────────────────────────

export async function getCashflowSummary(month) {
  // month = "2026-03" format
  try {
    const rows = await readCashflow();

    const entries = rows.filter(row => {
      if (!row.date) return false;
      const rowMonth = String(row.date).slice(0, 7); // "2026-03"
      return rowMonth === month;
    });

    let income   = 0;
    let expenses = 0;
    const byCategory = {};

    for (const entry of entries) {
      const amount = Math.abs(entry.amount || 0);
      const cat    = entry.category || 'Uncategorized';
      if (!byCategory[cat]) byCategory[cat] = 0;

      if ((entry.type || '').toLowerCase() === 'income') {
        income += amount;
        byCategory[cat] += amount;
      } else {
        expenses += amount;
        byCategory[cat] -= amount;
      }
    }

    return {
      income,
      expenses,
      net: income - expenses,
      byCategory,
      entries,
    };
  } catch (err) {
    console.error('[SharePoint] getCashflowSummary error:', err.message);
    return { income: 0, expenses: 0, net: 0, byCategory: {}, entries: [] };
  }
}
