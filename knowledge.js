// ============================================================
// KNOWLEDGE AGENT — Gorilla Rental Learning Brain
// Learns from URLs, YouTube, PDFs, manual input
// Feeds intelligence to all other agents
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { logActivity, createTask } from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { MEMORY_TOOLS, dispatchMemoryTool } from './memory.js';
import { sendSMS } from './ghl.js';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_KEY });

const DATA = {
  knowledge:     path.join(__dirname, 'data/knowledge.json'),
  learningQueue: path.join(__dirname, 'data/learning-queue.json'),
  competitors:   path.join(__dirname, 'data/competitors.json'),
  sharedContext: path.join(__dirname, 'data/shared-context.json'),
};

// ── Data helpers ──────────────────────────────────────────────
export function readJSON(fp, fallback = {}) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
export function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// ── scrapeURL ─────────────────────────────────────────────────
export async function scrapeURL(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GorillaRentalBot/1.0)' },
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, nav, footer, header, iframe, noscript, [role="navigation"]').remove();

    const title   = $('title').text().trim() || '';
    const h1      = $('h1').first().text().trim() || '';
    const metaDesc = $('meta[name="description"]').attr('content') || '';

    const paragraphs = [];
    $('p, h2, h3, h4, li, td').each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 30) paragraphs.push(t);
    });

    const content = paragraphs.join('\n').slice(0, 8000);

    return { url, title, h1, metaDesc, content, scrapedAt: new Date().toISOString(), success: true };
  } catch (err) {
    return { url, title: '', h1: '', metaDesc: '', content: '', scrapedAt: new Date().toISOString(), success: false, error: err.message };
  }
}

// ── extractKnowledgeWithClaude ────────────────────────────────
async function extractKnowledgeWithClaude(textContent, sourceInfo = '') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a knowledge extraction expert for Gorilla Rental — an aerial work platform (boom lift & scissor lift) rental company in South Florida.

Extract structured knowledge from the following content and return ONLY valid JSON with these fields:
{
  "summary": "2-3 sentence summary",
  "category": "competitor|equipment|pricing|safety|regulations|industry_news|business|general",
  "keyFacts": ["fact1", "fact2", ...],
  "competitiveIntel": "any competitor pricing, positioning, or strategy insights (empty string if none)",
  "technicalKnowledge": ["technical spec or fact1", ...],
  "businessInsights": ["business insight1", ...],
  "actionItems": ["recommended action1", ...],
  "confidenceScore": 0.0-1.0,
  "relevanceScore": 0.0-1.0
}

Source: ${sourceInfo}

Content:
${textContent}

Return only the JSON object, no other text.`,
    }],
  });

  const text = response.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(text);
}

// ── learnFromURL ──────────────────────────────────────────────
export async function learnFromURL(url, category = 'general', addedBy = 'system') {
  try {
    const scraped = await scrapeURL(url);
    if (!scraped.success && !scraped.content) {
      return { success: false, error: scraped.error || 'Scrape failed', url };
    }

    const textContent = [scraped.title, scraped.h1, scraped.metaDesc, scraped.content].filter(Boolean).join('\n\n');
    const extracted = await extractKnowledgeWithClaude(textContent, url);

    const entry = {
      id:                  `KN-${Date.now()}`,
      url,
      title:               scraped.title || scraped.h1 || url,
      summary:             extracted.summary || '',
      category:            extracted.category || category,
      keyFacts:            extracted.keyFacts || [],
      competitiveIntel:    extracted.competitiveIntel || '',
      technicalKnowledge:  extracted.technicalKnowledge || [],
      businessInsights:    extracted.businessInsights || [],
      actionItems:         extracted.actionItems || [],
      confidenceScore:     extracted.confidenceScore || 0.5,
      relevanceScore:      extracted.relevanceScore || 0.5,
      addedBy,
      learnedAt:           new Date().toISOString(),
      rawContent:          textContent.slice(0, 2000),
      type:                'url',
    };

    const knowledge = readJSON(DATA.knowledge, { entries: [], lastUpdated: null });
    if (!knowledge.entries) knowledge.entries = [];

    // Upsert by URL
    const idx = knowledge.entries.findIndex(e => e.url === url);
    if (idx >= 0) {
      knowledge.entries[idx] = entry;
    } else {
      knowledge.entries.push(entry);
    }
    knowledge.lastUpdated = new Date().toISOString();
    writeJSON(DATA.knowledge, knowledge);

    // Update competitor intel if applicable
    if (entry.category === 'competitor' && entry.competitiveIntel) {
      const competitors = readJSON(DATA.competitors, []);
      const comp = Array.isArray(competitors) ? competitors.find(c => url.includes(c.url?.replace('https://www.', '').replace('https://', ''))) : null;
      if (comp) {
        comp.lastIntel = entry.competitiveIntel;
        comp.lastUpdated = new Date().toISOString();
        writeJSON(DATA.competitors, competitors);
      }
    }

    await logActivity({ agent: 'knowledge', action: 'url_learned', description: `Learned from ${url} — relevance: ${Math.round((entry.relevanceScore||0)*100)}/100`, status: 'success', notify: false }).catch(()=>{});
    console.log(`[Knowledge] ✅ Learned from URL: ${url}`);
    return { success: true, entry };
  } catch (err) {
    console.error(`[Knowledge] ❌ learnFromURL error: ${err.message}`);
    return { success: false, error: err.message, url };
  }
}

// ── learnFromYouTube ──────────────────────────────────────────
export async function learnFromYouTube(youtubeUrl, addedBy = 'system') {
  try {
    // Extract video ID
    const match = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (!match) throw new Error('Could not extract YouTube video ID');
    const videoId = match[1];

    let transcript = '';
    let title = youtubeUrl;

    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const parts = await YoutubeTranscript.fetchTranscript(videoId);
      transcript = parts.map(p => p.text).join(' ').slice(0, 8000);
    } catch (transcriptErr) {
      console.warn(`[Knowledge] YouTube transcript fallback: ${transcriptErr.message}`);
      const scraped = await scrapeURL(youtubeUrl);
      transcript = scraped.content || '';
      title = scraped.title || title;
    }

    if (!transcript) throw new Error('No transcript or content available');

    const extracted = await extractKnowledgeWithClaude(transcript, `YouTube: ${youtubeUrl}`);

    const entry = {
      id:                  `KN-${Date.now()}`,
      url:                 youtubeUrl,
      title:               title || `YouTube: ${videoId}`,
      summary:             extracted.summary || '',
      category:            extracted.category || 'general',
      keyFacts:            extracted.keyFacts || [],
      competitiveIntel:    extracted.competitiveIntel || '',
      technicalKnowledge:  extracted.technicalKnowledge || [],
      businessInsights:    extracted.businessInsights || [],
      actionItems:         extracted.actionItems || [],
      confidenceScore:     extracted.confidenceScore || 0.5,
      relevanceScore:      extracted.relevanceScore || 0.5,
      addedBy,
      learnedAt:           new Date().toISOString(),
      rawContent:          transcript.slice(0, 2000),
      type:                'youtube',
    };

    const knowledge = readJSON(DATA.knowledge, { entries: [], lastUpdated: null });
    if (!knowledge.entries) knowledge.entries = [];

    const idx = knowledge.entries.findIndex(e => e.url === youtubeUrl);
    if (idx >= 0) {
      knowledge.entries[idx] = entry;
    } else {
      knowledge.entries.push(entry);
    }
    knowledge.lastUpdated = new Date().toISOString();
    writeJSON(DATA.knowledge, knowledge);

    console.log(`[Knowledge] ✅ Learned from YouTube: ${youtubeUrl}`);
    return { success: true, entry };
  } catch (err) {
    console.error(`[Knowledge] ❌ learnFromYouTube error: ${err.message}`);
    return { success: false, error: err.message, url: youtubeUrl };
  }
}

// ── learnFromPDF ──────────────────────────────────────────────
export async function learnFromPDF(pdfBuffer, fileName, addedBy = 'system') {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(pdfBuffer);
    const text = data.text.slice(0, 8000);

    const extracted = await extractKnowledgeWithClaude(text, `PDF: ${fileName}`);

    const entry = {
      id:                  `KN-${Date.now()}`,
      url:                 null,
      title:               fileName,
      summary:             extracted.summary || '',
      category:            extracted.category || 'general',
      keyFacts:            extracted.keyFacts || [],
      competitiveIntel:    extracted.competitiveIntel || '',
      technicalKnowledge:  extracted.technicalKnowledge || [],
      businessInsights:    extracted.businessInsights || [],
      actionItems:         extracted.actionItems || [],
      confidenceScore:     extracted.confidenceScore || 0.5,
      relevanceScore:      extracted.relevanceScore || 0.5,
      addedBy,
      learnedAt:           new Date().toISOString(),
      rawContent:          text.slice(0, 2000),
      type:                'pdf',
    };

    const knowledge = readJSON(DATA.knowledge, { entries: [], lastUpdated: null });
    if (!knowledge.entries) knowledge.entries = [];
    knowledge.entries.push(entry);
    knowledge.lastUpdated = new Date().toISOString();
    writeJSON(DATA.knowledge, knowledge);

    console.log(`[Knowledge] ✅ Learned from PDF: ${fileName}`);
    return { success: true, entry };
  } catch (err) {
    console.error(`[Knowledge] ❌ learnFromPDF error: ${err.message}`);
    return { success: false, error: err.message, fileName };
  }
}

// ── teach ─────────────────────────────────────────────────────
export async function teach(title, content, category = 'general', addedBy = 'system') {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Organize this knowledge for Gorilla Rental's knowledge base and return ONLY valid JSON:
{
  "summary": "2-3 sentence summary",
  "category": "${category}",
  "keyFacts": ["fact1", "fact2", ...],
  "competitiveIntel": "",
  "technicalKnowledge": [],
  "businessInsights": [],
  "actionItems": [],
  "confidenceScore": 1.0,
  "relevanceScore": 1.0
}

Title: ${title}
Content: ${content}

Return only the JSON object.`,
      }],
    });

    const text = response.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let extracted;
    try {
      extracted = JSON.parse(text);
    } catch {
      extracted = { summary: content.slice(0, 200), category, keyFacts: [], competitiveIntel: '', technicalKnowledge: [], businessInsights: [], actionItems: [], confidenceScore: 1.0, relevanceScore: 1.0 };
    }

    const entry = {
      id:                  `KN-${Date.now()}`,
      url:                 null,
      title,
      summary:             extracted.summary || content.slice(0, 200),
      category:            extracted.category || category,
      keyFacts:            extracted.keyFacts || [],
      competitiveIntel:    extracted.competitiveIntel || '',
      technicalKnowledge:  extracted.technicalKnowledge || [],
      businessInsights:    extracted.businessInsights || [],
      actionItems:         extracted.actionItems || [],
      confidenceScore:     extracted.confidenceScore || 1.0,
      relevanceScore:      extracted.relevanceScore || 1.0,
      addedBy,
      learnedAt:           new Date().toISOString(),
      rawContent:          content.slice(0, 2000),
      type:                'manual',
    };

    const knowledge = readJSON(DATA.knowledge, { entries: [], lastUpdated: null });
    if (!knowledge.entries) knowledge.entries = [];
    knowledge.entries.push(entry);
    knowledge.lastUpdated = new Date().toISOString();
    writeJSON(DATA.knowledge, knowledge);

    console.log(`[Knowledge] ✅ Taught: ${title}`);
    return { success: true, entry };
  } catch (err) {
    console.error(`[Knowledge] ❌ teach error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── query ─────────────────────────────────────────────────────
export async function query(question, context = '') {
  const knowledge = readJSON(DATA.knowledge, { entries: [] });
  const entries = knowledge.entries || [];

  // Score entries by keyword overlap
  const qWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const scored = entries.map(e => {
    const text = [e.title, e.summary, (e.keyFacts || []).join(' '), (e.technicalKnowledge || []).join(' ')].join(' ').toLowerCase();
    const score = qWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { entry: e, score };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  const relevantKnowledge = scored
    .filter(s => s.score > 0)
    .map(s => `[${s.entry.category}] ${s.entry.title}\n${s.entry.summary}\nKey Facts: ${(s.entry.keyFacts || []).join('; ')}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are an expert aerial work platform engineer and South Florida rental industry specialist for Gorilla Rental — a boom lift and scissor lift rental company.
You have deep knowledge of equipment specifications, pricing, safety regulations, and the South Florida market.
Answer questions accurately and helpfully using the knowledge base provided.
MEMORY TOOLS: You have persistent long-term memory via MEMORY_SEARCH and MEMORY_ADD. Search memory for additional context before answering. Save important new facts learned.

RELEVANT KNOWLEDGE BASE:
${relevantKnowledge || 'No directly relevant entries found.'}

${context ? `ADDITIONAL CONTEXT:\n${context}` : ''}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt,
    messages: [{ role: 'user', content: question }],
    tools: MEMORY_TOOLS,
  });

  let finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  if (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults   = await Promise.all(toolUseBlocks.map(async tu => ({
      type: 'tool_result', tool_use_id: tu.id,
      content: JSON.stringify(await dispatchMemoryTool(tu.name, tu.input).catch(e => ({ error: e.message }))),
    })));
    const followUp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, tools: MEMORY_TOOLS,
      messages: [{ role: 'user', content: question }, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }],
    });
    finalText = followUp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  const sources = scored.filter(s => s.score > 0).slice(0, 5).map(s => ({ id: s.entry.id, title: s.entry.title, category: s.entry.category }));

  return {
    answer:       finalText,
    question,
    sourcesUsed:  sources.length,
    sources,
  };
}

// ── engineeringQuery ──────────────────────────────────────────
export async function engineeringQuery(question, jobContext = '') {
  const knowledge = readJSON(DATA.knowledge, { entries: [] });
  const entries = knowledge.entries || [];

  const qWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const scored = entries.map(e => {
    const text = [e.title, e.summary, (e.keyFacts || []).join(' '), (e.technicalKnowledge || []).join(' ')].join(' ').toLowerCase();
    const score = qWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { entry: e, score };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  const relevantKnowledge = scored
    .filter(s => s.score > 0)
    .map(s => `[${s.entry.category}] ${s.entry.title}\n${s.entry.summary}\nTechnical: ${(s.entry.technicalKnowledge || []).join('; ')}`)
    .join('\n\n---\n\n');

  const engSystemPrompt = `You are a senior aerial work platform engineer and safety expert with 20+ years of experience.
You have deep expertise in OSHA 1926.453, ANSI/SIA A92 standards, and Florida building codes.
You specialize in boom lifts, scissor lifts, and aerial work platforms for construction, maintenance, and industrial applications.
Provide technically precise, safety-conscious answers. Always cite relevant standards when applicable.
MEMORY TOOLS: You have persistent long-term memory via MEMORY_SEARCH and MEMORY_ADD. Search memory for job history or past decisions before answering.

KNOWLEDGE BASE:
${relevantKnowledge || 'No directly relevant entries found.'}

${jobContext ? `JOB CONTEXT:\n${jobContext}` : ''}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1024, system: engSystemPrompt,
    messages: [{ role: 'user', content: question }],
    tools: MEMORY_TOOLS,
  });

  let finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  if (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults   = await Promise.all(toolUseBlocks.map(async tu => ({
      type: 'tool_result', tool_use_id: tu.id,
      content: JSON.stringify(await dispatchMemoryTool(tu.name, tu.input).catch(e => ({ error: e.message }))),
    })));
    const followUp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024, system: engSystemPrompt, tools: MEMORY_TOOLS,
      messages: [{ role: 'user', content: question }, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }],
    });
    finalText = followUp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  const sources = scored.filter(s => s.score > 0).slice(0, 5).map(s => ({ id: s.entry.id, title: s.entry.title, category: s.entry.category }));

  return {
    answer:       finalText,
    question,
    sourcesUsed:  sources.length,
    sources,
  };
}

// ── getAgentContext ───────────────────────────────────────────
export function getAgentContext(agentType) {
  const categoryMap = {
    quote:     ['pricing', 'competitor', 'equipment'],
    admin:     ['business', 'regulations', 'pricing'],
    ops:       ['equipment', 'safety', 'engineering'],
    finance:   ['business', 'pricing', 'competitor'],
    marketing: ['competitor', 'business', 'industry_news'],
  };

  const relevantCategories = categoryMap[agentType] || ['general'];
  const knowledge = readJSON(DATA.knowledge, { entries: [] });
  const entries = knowledge.entries || [];

  const filtered = entries
    .filter(e => relevantCategories.includes(e.category))
    .sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt))
    .slice(0, 20);

  if (!filtered.length) return '';

  return filtered.map(e =>
    `[${e.category.toUpperCase()}] ${e.title}\n${e.summary}${e.keyFacts?.length ? '\nKey: ' + e.keyFacts.slice(0, 3).join('; ') : ''}${e.competitiveIntel ? '\nIntel: ' + e.competitiveIntel : ''}`
  ).join('\n\n');
}

// ── addToLearningQueue ────────────────────────────────────────
export async function addToLearningQueue(url, addedBy = 'system', priority = 'normal') {
  if (priority === 'high') {
    return await learnFromURL(url, 'general', addedBy);
  }

  const queue = readJSON(DATA.learningQueue, []);
  const existing = Array.isArray(queue) ? queue.find(q => q.url === url && q.status === 'pending') : null;
  if (existing) return { queued: true, url, note: 'already in queue' };

  const item = {
    id:       `Q-${Date.now()}`,
    url,
    addedBy,
    priority,
    status:   'pending',
    addedAt:  new Date().toISOString(),
  };

  const arr = Array.isArray(queue) ? queue : [];
  arr.push(item);
  writeJSON(DATA.learningQueue, arr);

  console.log(`[Knowledge] Queued: ${url}`);
  return { queued: true, url };
}

// ── processLearningQueue ──────────────────────────────────────
export async function processLearningQueue() {
  const queue = readJSON(DATA.learningQueue, []);
  const arr = Array.isArray(queue) ? queue : [];
  const pending = arr.filter(q => q.status === 'pending');

  let processed = 0;
  for (const item of pending) {
    try {
      const result = await learnFromURL(item.url, 'general', item.addedBy);
      item.status = result.success ? 'completed' : 'failed';
      item.processedAt = new Date().toISOString();
      if (!result.success) item.error = result.error;
      processed++;
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
      item.processedAt = new Date().toISOString();
    }
    writeJSON(DATA.learningQueue, arr);
  }

  console.log(`[Knowledge] Queue processed: ${processed} items`);
  return { processed };
}

// ── broadcastKnowledgeUpdate (private) ───────────────────────
async function broadcastKnowledgeUpdate(results) {
  const knowledge = readJSON(DATA.knowledge, { entries: [] });
  const entries = knowledge.entries || [];

  const sharedContext = {
    lastUpdated:      new Date().toISOString(),
    totalEntries:     entries.length,
    latestInsights:   entries
      .sort((a, b) => new Date(b.learnedAt) - new Date(a.learnedAt))
      .slice(0, 10)
      .map(e => ({ title: e.title, summary: e.summary, category: e.category })),
    competitorPricing: entries
      .filter(e => e.category === 'competitor' && e.competitiveIntel)
      .slice(0, 5)
      .map(e => ({ title: e.title, intel: e.competitiveIntel })),
    equipmentSpecs:   entries
      .filter(e => e.category === 'equipment' && e.technicalKnowledge?.length)
      .slice(0, 5)
      .map(e => ({ title: e.title, specs: e.technicalKnowledge })),
    safetyAlerts:     entries
      .filter(e => e.category === 'safety' && e.keyFacts?.length)
      .slice(0, 5)
      .map(e => ({ title: e.title, facts: e.keyFacts })),
    actionItems:      entries
      .flatMap(e => e.actionItems || [])
      .filter(Boolean)
      .slice(0, 10),
  };

  writeJSON(DATA.sharedContext, sharedContext);
  console.log(`[Knowledge] Shared context updated: ${entries.length} entries`);
}

// ── dailyLearningSweep ────────────────────────────────────────
export async function dailyLearningSweep() {
  console.log('[Knowledge] Starting daily learning sweep...');

  const competitors = readJSON(DATA.competitors, []);
  const competitorURLs = Array.isArray(competitors)
    ? competitors.filter(c => c.url).map(c => ({ url: c.url, category: c.type || 'competitor' }))
    : [];

  const hardcodedURLs = [
    { url: 'https://www.osha.gov/aerial-lifts', category: 'safety' },
    { url: 'https://www.constructiondive.com', category: 'industry_news' },
    { url: 'https://www.equipmentworld.com', category: 'industry_news' },
    { url: 'https://www.genielift.com/en/products', category: 'equipment' },
    { url: 'https://www.jlg.com/en/equipment', category: 'equipment' },
  ];

  const allURLs = [...competitorURLs, ...hardcodedURLs];

  const learned = [];
  const failed  = [];
  const newInsights = [];

  for (const item of allURLs) {
    try {
      const result = await learnFromURL(item.url, item.category, 'daily_sweep');
      if (result.success) {
        learned.push({ url: item.url, title: result.entry.title });
        if (result.entry.actionItems?.length || result.entry.competitiveIntel) {
          newInsights.push({
            url:     item.url,
            title:   result.entry.title,
            actions: result.entry.actionItems || [],
            intel:   result.entry.competitiveIntel || '',
          });
        }
      } else {
        failed.push({ url: item.url, error: result.error });
      }
    } catch (err) {
      failed.push({ url: item.url, error: err.message });
    }

    // 2 second delay between requests
    await new Promise(r => setTimeout(r, 2000));
  }

  const results = { learned, failed, newInsights, sweepAt: new Date().toISOString() };

  // Notify if new insights found
  if (newInsights.length > 0) {
    const summary = `🧠 GORILLA AI LEARNING SWEEP\n\nLearned: ${learned.length} | Failed: ${failed.length} | New Insights: ${newInsights.length}\n\n` +
      newInsights.slice(0, 3).map(i => `• ${i.title}: ${i.intel || i.actions[0] || ''}`).join('\n');
    try {
      await sendSMS('+15619286999', summary);
    } catch (smsErr) {
      console.error('[Knowledge] SMS notify error:', smsErr.message);
    }
  }

  await broadcastKnowledgeUpdate(results);

  console.log(`[Knowledge] Sweep complete: ${learned.length} learned, ${failed.length} failed`);
  return results;
}

// ── weeklyKnowledgeReport ─────────────────────────────────────
export async function weeklyKnowledgeReport() {
  const knowledge = readJSON(DATA.knowledge, { entries: [] });
  const entries   = knowledge.entries || [];
  const now       = new Date();
  const weekAgo   = new Date(now.getTime() - 7 * 86400000);

  const newEntries = entries.filter(e => new Date(e.learnedAt) >= weekAgo);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    messages: [{
      role: 'user',
      content: `Generate a weekly knowledge report for Gorilla Rental based on recent learnings.

NEW ENTRIES THIS WEEK (${newEntries.length}):
${newEntries.map(e => `- [${e.category}] ${e.title}: ${e.summary}`).join('\n') || 'None'}

ALL TIME STATS:
Total entries: ${entries.length}
Categories: ${[...new Set(entries.map(e => e.category))].join(', ')}
Recent action items: ${entries.flatMap(e => e.actionItems || []).slice(0, 5).join('; ') || 'None'}
Competitor intel: ${entries.filter(e => e.competitiveIntel).length} entries with competitive data

Write a concise report covering:
1. Important learnings this week
2. Competitor intelligence updates
3. Equipment/technical updates
4. Recommended actions for the business
5. What to learn next week`,
    }],
  });

  return {
    report:        response.content[0].text,
    newEntries:    newEntries.length,
    totalEntries:  entries.length,
    generatedAt:   now.toISOString(),
  };
}

// ── knowledgeRoutes ───────────────────────────────────────────
export function knowledgeRoutes(app) {
  // POST /knowledge/learn
  app.post('/knowledge/learn', async (req, res) => {
    try {
      const { url, category, addedBy, priority } = req.body;
      if (!url) return res.status(400).json({ ok: false, error: 'url required' });
      if (priority === 'high') {
        const result = await learnFromURL(url, category || 'general', addedBy || 'api');
        return res.json({ ok: result.success, ...result });
      } else {
        const result = await addToLearningQueue(url, addedBy || 'api', priority || 'normal');
        return res.json({ ok: true, ...result });
      }
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/youtube
  app.post('/knowledge/youtube', async (req, res) => {
    try {
      const { url, addedBy } = req.body;
      if (!url) return res.status(400).json({ ok: false, error: 'url required' });
      const result = await learnFromYouTube(url, addedBy || 'api');
      res.json({ ok: result.success, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/teach
  app.post('/knowledge/teach', async (req, res) => {
    try {
      const { title, content, category, addedBy } = req.body;
      if (!title || !content) return res.status(400).json({ ok: false, error: 'title and content required' });
      const result = await teach(title, content, category || 'general', addedBy || 'api');
      res.json({ ok: result.success, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/query
  app.post('/knowledge/query', async (req, res) => {
    try {
      const { question, context } = req.body;
      if (!question) return res.status(400).json({ ok: false, error: 'question required' });
      const result = await query(question, context || '');
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/engineering
  app.post('/knowledge/engineering', async (req, res) => {
    try {
      const { question, jobContext } = req.body;
      if (!question) return res.status(400).json({ ok: false, error: 'question required' });
      const result = await engineeringQuery(question, jobContext || '');
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/sweep
  app.post('/knowledge/sweep', async (req, res) => {
    try {
      res.json({ ok: true, message: 'Sweep started in background' });
      dailyLearningSweep().catch(e => console.error('[Knowledge] Sweep error:', e.message));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /knowledge/report
  app.get('/knowledge/report', async (req, res) => {
    try {
      const result = await weeklyKnowledgeReport();
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /knowledge
  app.get('/knowledge', (req, res) => {
    try {
      const knowledge = readJSON(DATA.knowledge, { entries: [] });
      let entries = knowledge.entries || [];
      if (req.query.category) {
        entries = entries.filter(e => e.category === req.query.category);
      }
      res.json({ ok: true, entries, total: entries.length, lastUpdated: knowledge.lastUpdated });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/process-queue
  app.post('/knowledge/process-queue', async (req, res) => {
    try {
      const result = await processLearningQueue();
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /knowledge/pdf
  app.post('/knowledge/pdf', async (req, res) => {
    try {
      const { content, fileName, addedBy } = req.body;
      if (!content) return res.status(400).json({ ok: false, error: 'content (base64) required' });
      const pdfBuffer = Buffer.from(content, 'base64');
      const result = await learnFromPDF(pdfBuffer, fileName || 'upload.pdf', addedBy || 'api');
      res.json({ ok: result.success, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[Knowledge] ✅ Routes registered');
}
