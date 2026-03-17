// ============================================================
// COMPANY ONBOARDING — Gorilla Rental AI
// Ingests all available business data and builds a company
// snapshot that every AI agent uses as context.
//
// Sources:
//   - SharePoint: Cashflow Excel (Gorilla Cash flow.xlsx)
//   - config.js:  Equipment catalog, pricing, drivers
//   - data/:      Pipeline, leads, reservations, invoices
//
// Output:
//   - data/company-snapshot.json  → used by all agents
//   - data/onboarding-log.json    → audit trail
//   - knowledge base              → 4+ entries fed via teach()
// ============================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EQUIPMENT_CATALOG, PRICING, DRIVERS, CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');

// ─── Utilities ─────────────────────────────────────────────
function readJSON(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function fmt(n) { return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// ─── Step 1: SharePoint cashflow ───────────────────────────
async function ingestCashflow() {
  try {
    const { readCashflow } = await import('./sharepoint.js');
    const rows = await readCashflow();
    console.log(`   ✅ SharePoint cashflow: ${rows.length} transactions`);
    return { rows, source: 'sharepoint' };
  } catch (e) {
    console.warn(`   ⚠️  SharePoint unavailable: ${e.message}`);
    console.log('   Falling back to local data...');
    return { rows: [], source: 'unavailable', error: e.message };
  }
}

// ─── Step 2: Equipment from config ─────────────────────────
function ingestEquipment() {
  const units = EQUIPMENT_CATALOG.map(eq => ({
    ...eq,
    status:     'available',
    dailyLabel:   eq.daily   ? `$${eq.daily}`   : 'call',
    weeklyLabel:  eq.weekly  ? `$${eq.weekly}`  : 'call',
    monthlyLabel: eq.monthly ? `$${eq.monthly}` : 'call',
  }));
  console.log(`   ✅ Equipment catalog: ${units.length} units`);
  return units;
}

// ─── Step 3: Local data files ──────────────────────────────
function ingestLocalData() {
  const pipeline     = readJSON(path.join(DATA_DIR, 'pipeline.json'),     []);
  const leads        = readJSON(path.join(DATA_DIR, 'leads.json'),        []);
  const reservations = readJSON(path.join(DATA_DIR, 'reservations.json'), []);
  const invoices     = readJSON(path.join(DATA_DIR, 'invoices.json'),     []);
  const contracts    = readJSON(path.join(DATA_DIR, 'contracts.json'),    []);

  console.log(`   ✅ Pipeline: ${pipeline.length} jobs`);
  console.log(`   ✅ Leads: ${leads.length}`);
  console.log(`   ✅ Reservations: ${reservations.length}`);
  console.log(`   ✅ Invoices: ${invoices.length}`);
  console.log(`   ✅ Contracts: ${contracts.length}`);

  return { pipeline, leads, reservations, invoices, contracts };
}

// ─── Step 4: Build snapshot ────────────────────────────────
function buildSnapshot(cashflowResult, equipment, localData) {
  const { rows: cashflow } = cashflowResult;

  // Financial aggregation
  let totalIncome = 0, totalExpenses = 0;
  const monthlyBreakdown = {};
  const categoryBreakdown = {};

  for (const row of cashflow) {
    const month   = String(row.date || '').slice(0, 7);
    const amount  = Math.abs(row.amount || 0);
    const type    = (row.type || '').toLowerCase();
    const cat     = row.category || 'Uncategorized';

    if (!monthlyBreakdown[month]) monthlyBreakdown[month] = { income: 0, expenses: 0 };
    if (!categoryBreakdown[cat])  categoryBreakdown[cat]  = { income: 0, expenses: 0 };

    if (type === 'income') {
      totalIncome += amount;
      monthlyBreakdown[month].income += amount;
      categoryBreakdown[cat].income  += amount;
    } else {
      totalExpenses += amount;
      monthlyBreakdown[month].expenses += amount;
      categoryBreakdown[cat].expenses  += amount;
    }
  }

  // Pipeline stats
  const { pipeline, leads, reservations, invoices, contracts } = localData;
  const stageCount = pipeline.reduce((acc, j) => { acc[j.stage] = (acc[j.stage] || 0) + 1; return acc; }, {});
  const pipelineRevenue = pipeline
    .filter(j => !['cancelled'].includes(j.stage))
    .reduce((sum, j) => sum + (parseFloat(j.total || j.amount || 0) || 0), 0);

  // Best customers (by pipeline revenue)
  const customerRevenue = {};
  for (const j of pipeline) {
    const name = j.customerName || j.customer || 'Unknown';
    customerRevenue[name] = (customerRevenue[name] || 0) + (parseFloat(j.total || 0) || 0);
  }
  const topCustomers = Object.entries(customerRevenue)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, total]) => ({ name, total }));

  return {
    lastUpdated:     new Date().toISOString(),
    schemaVersion:   '2.0',

    company: {
      name:     CONFIG.BRAND.NAME,
      phone:    CONFIG.BRAND.PHONE,
      email:    CONFIG.BRAND.EMAIL,
      website:  CONFIG.BRAND.WEBSITE,
      location: CONFIG.BRAND.LOCATION,
    },

    equipment: {
      total: equipment.length,
      units: equipment,
      types: [...new Set(equipment.map(e => e.type))],
    },

    pricing: {
      taxRate:      PRICING.TAX_RATE,
      deliveryFee:  PRICING.DELIVERY_FEE,
      deposit:      PRICING.DEPOSIT,
    },

    drivers: DRIVERS,

    financials: {
      totalIncome,
      totalExpenses,
      netProfit:        totalIncome - totalExpenses,
      transactionCount: cashflow.length,
      cashflowSource:   cashflowResult.source,
      monthlyBreakdown,
      categoryBreakdown,
      recentTransactions: cashflow.slice(-10),
    },

    pipeline: {
      total:           pipeline.length,
      byStage:         stageCount,
      pipelineRevenue,
      topCustomers,
      activeJobs:      pipeline.filter(j => j.stage === 'in_progress').length,
      completedJobs:   pipeline.filter(j => j.stage === 'completed').length,
    },

    leads: {
      total:     leads.length,
      new:       leads.filter(l => l.status === 'new').length,
      contacted: leads.filter(l => l.status === 'contacted').length,
      converted: leads.filter(l => l.status === 'converted').length,
    },

    documents: {
      reservations: reservations.length,
      invoices:     invoices.length,
      contracts:    contracts.length,
    },
  };
}

// ─── Step 5: Feed into knowledge base ─────────────────────
async function feedKnowledge(snapshot) {
  let taught = 0;
  try {
    const { teach } = await import('./knowledge.js');

    // 1. Equipment fleet & pricing
    const eqLines = snapshot.equipment.units.map(e =>
      `  ${e.name} (${e.sku}): Daily ${e.dailyLabel} | Weekly ${e.weeklyLabel} | Monthly ${e.monthlyLabel}`
    ).join('\n');
    await teach(
      'Gorilla Rental — Equipment Fleet & Pricing',
      `Complete equipment catalog for Gorilla Rental (South Florida aerial lift rentals):\n\n${eqLines}\n\nAdditional fees:\n  Delivery/Pickup: ${fmt(snapshot.pricing.deliveryFee)}\n  Security Deposit: ${fmt(snapshot.pricing.deposit)}\n  Tax Rate: ${(snapshot.pricing.taxRate * 100).toFixed(0)}%`,
      'business', 'onboarding'
    );
    console.log('   ✅ Knowledge: Equipment fleet & pricing');
    taught++;

    // 2. Financial history (only if we have data)
    if (snapshot.financials.transactionCount > 0) {
      const monthLines = Object.entries(snapshot.financials.monthlyBreakdown)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([m, v]) => `  ${m}: Income ${fmt(v.income)}, Expenses ${fmt(v.expenses)}, Net ${fmt(v.income - v.expenses)}`)
        .join('\n');
      await teach(
        'Gorilla Rental — Financial History',
        `Financial summary for Gorilla Rental:\n\nTotal Income: ${fmt(snapshot.financials.totalIncome)}\nTotal Expenses: ${fmt(snapshot.financials.totalExpenses)}\nNet Profit: ${fmt(snapshot.financials.netProfit)}\nTransactions recorded: ${snapshot.financials.transactionCount}\n\nMonthly breakdown:\n${monthLines || '  No monthly data available'}`,
        'business', 'onboarding'
      );
      console.log('   ✅ Knowledge: Financial history');
      taught++;
    }

    // 3. Company overview & SOPs
    const driverList = snapshot.drivers.map(d => `  ${d.name} — ${d.phone}`).join('\n');
    await teach(
      'Gorilla Rental — Company Overview & Operations',
      `Gorilla Rental — South Florida aerial work platform rental company.\n\nSERVICES:\n  • Boom Lifts: 40ft to 125ft reach (electric and diesel)\n  • Scissor Lifts: 32ft electric\n  • Scaffolding: modular, daily rate\n  • Shore Posts: monthly rate\n  • Overhead Protection\n\nSERVICE AREA: South Florida — Broward County (primary), Miami-Dade, Palm Beach\n\nTARGET CUSTOMERS:\n  • General Contractors, Painters, Landscapers, Roofers\n  • Drywall, Framing, Excavation companies\n\nTEAM (DRIVERS):\n${driverList}\n\nCONTACT:\n  Phone: ${snapshot.company.phone}\n  Email: ${snapshot.company.email}\n  Website: ${snapshot.company.website}\n\nPRICING POLICY:\n  • Delivery included in delivery fee (${fmt(snapshot.pricing.deliveryFee)})\n  • Refundable deposit ${fmt(snapshot.pricing.deposit)} per rental\n  • Tax: ${(snapshot.pricing.taxRate * 100).toFixed(0)}% Florida sales tax`,
      'business', 'onboarding'
    );
    console.log('   ✅ Knowledge: Company overview');
    taught++;

    // 4. Pipeline & customers (only if we have data)
    if (snapshot.pipeline.total > 0) {
      const stageLines = Object.entries(snapshot.pipeline.byStage)
        .map(([s, c]) => `  ${s}: ${c} job${c !== 1 ? 's' : ''}`)
        .join('\n');
      const topCustLines = snapshot.pipeline.topCustomers.length > 0
        ? snapshot.pipeline.topCustomers.map(c => `  ${c.name}: ${fmt(c.total)}`).join('\n')
        : '  No customers yet';
      await teach(
        'Gorilla Rental — Pipeline & Customer Data',
        `Job pipeline summary:\n\nTotal jobs: ${snapshot.pipeline.total}\nActive rentals: ${snapshot.pipeline.activeJobs}\nCompleted jobs: ${snapshot.pipeline.completedJobs}\nPipeline revenue: ${fmt(snapshot.pipeline.pipelineRevenue)}\n\nJobs by stage:\n${stageLines}\n\nTop customers by revenue:\n${topCustLines}\n\nLeads: ${snapshot.leads.total} total, ${snapshot.leads.new} new, ${snapshot.leads.converted} converted`,
        'business', 'onboarding'
      );
      console.log('   ✅ Knowledge: Pipeline & customers');
      taught++;
    }

  } catch (e) {
    console.warn(`   ⚠️  Knowledge feed warning: ${e.message}`);
  }
  return taught;
}

// ─── Main export ───────────────────────────────────────────
export async function runOnboarding() {
  console.log('\n' + '═'.repeat(52));
  console.log('  🦍  GORILLA RENTAL — COMPANY ONBOARDING');
  console.log('═'.repeat(52) + '\n');

  const log = { startedAt: new Date().toISOString(), steps: [], errors: [] };

  // Step 1 — SharePoint cashflow
  console.log('📊 Step 1: Reading cashflow from SharePoint...');
  const cashflowResult = await ingestCashflow();
  log.steps.push({ step: 'cashflow', count: cashflowResult.rows.length, source: cashflowResult.source });

  // Step 2 — Equipment
  console.log('\n🏗️  Step 2: Reading equipment catalog...');
  const equipment = ingestEquipment();
  log.steps.push({ step: 'equipment', count: equipment.length });

  // Step 3 — Local data
  console.log('\n📋 Step 3: Reading local data files...');
  const localData = ingestLocalData();
  log.steps.push({ step: 'local_data', ...Object.fromEntries(Object.entries(localData).map(([k, v]) => [k, v.length])) });

  // Step 4 — Build snapshot
  console.log('\n💾 Step 4: Building company snapshot...');
  const snapshot = buildSnapshot(cashflowResult, equipment, localData);
  writeJSON(path.join(DATA_DIR, 'company-snapshot.json'), snapshot);
  console.log('   ✅ Snapshot saved → data/company-snapshot.json');

  // Step 5 — Feed knowledge
  console.log('\n🧠 Step 5: Feeding knowledge base...');
  const taught = await feedKnowledge(snapshot);
  log.steps.push({ step: 'knowledge', entriesCreated: taught });

  // Save log
  log.completedAt = new Date().toISOString();
  log.summary = {
    cashflowTransactions: cashflowResult.rows.length,
    cashflowSource:       cashflowResult.source,
    equipmentUnits:       equipment.length,
    pipelineJobs:         localData.pipeline.length,
    leadsTotal:           localData.leads.length,
    knowledgeEntries:     taught,
    financials: {
      totalIncome:   snapshot.financials.totalIncome,
      totalExpenses: snapshot.financials.totalExpenses,
      netProfit:     snapshot.financials.netProfit,
    },
  };
  writeJSON(path.join(DATA_DIR, 'onboarding-log.json'), log);

  // Final report
  console.log('\n' + '═'.repeat(52));
  console.log('  ✅  ONBOARDING COMPLETE');
  console.log('═'.repeat(52));
  console.log(`  📊  Cashflow transactions : ${cashflowResult.rows.length} (${cashflowResult.source})`);
  console.log(`  🏗️   Equipment units       : ${equipment.length}`);
  console.log(`  📋  Pipeline jobs          : ${localData.pipeline.length}`);
  console.log(`  👥  Leads                  : ${localData.leads.length}`);
  console.log(`  🧠  Knowledge entries      : ${taught}`);
  if (cashflowResult.rows.length > 0) {
    console.log(`  💰  Total income           : ${fmt(snapshot.financials.totalIncome)}`);
    console.log(`  💸  Total expenses         : ${fmt(snapshot.financials.totalExpenses)}`);
    console.log(`  📈  Net profit             : ${fmt(snapshot.financials.netProfit)}`);
  }
  console.log('═'.repeat(52) + '\n');

  if (cashflowResult.source === 'unavailable') {
    console.log('⚠️  SharePoint note:');
    console.log('   The cashflow Excel could not be read from SharePoint.');
    console.log('   Check Azure app permissions:');
    console.log('     - Sites.ReadWrite.All');
    console.log('     - Files.ReadWrite.All');
    console.log('     - Admin consent must be granted');
    console.log(`   Error: ${cashflowResult.error}\n`);
  }

  return log.summary;
}

// ─── Run directly ─────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOnboarding().catch(e => {
    console.error('\n❌ Onboarding failed:', e.message);
    process.exit(1);
  });
}
