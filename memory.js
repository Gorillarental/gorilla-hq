// ============================================================
// MEMORY.JS — Supermemory tool layer
// Shared across quote, ops, admin, finance agents
// Gives every agent persistent memory: add, search, list, delete
// Get API key: https://app.supermemory.ai
// ============================================================

import Supermemory from 'supermemory';
import { CONFIG } from './config.js';

let _client = null;
function getClient() {
  if (!_client) {
    if (!CONFIG.SUPERMEMORY_KEY) throw new Error('SUPERMEMORY_API_KEY is not set');
    _client = new Supermemory({ apiKey: CONFIG.SUPERMEMORY_KEY });
  }
  return _client;
}

// ─── Core operations ───────────────────────────────────────────

export async function MEMORY_ADD({ content, metadata = {} }) {
  const client = getClient();
  return client.documents.add({ content, metadata });
}

export async function MEMORY_SEARCH({ q, limit = 10 }) {
  const client = getClient();
  return client.search.memories({ q, limit });
}

export async function MEMORY_LIST({ limit = 20 } = {}) {
  const client = getClient();
  return client.documents.list({ limit });
}

export async function MEMORY_DELETE({ id }) {
  const client = getClient();
  return client.documents.delete(id);
}

export async function MEMORY_GET({ id }) {
  const client = getClient();
  return client.documents.get(id);
}

// ─── Claude Tool Definitions ───────────────────────────────────

export const MEMORY_TOOLS = [
  {
    name: 'MEMORY_ADD',
    description: 'Save important information to long-term memory. Use this to remember customer preferences, job details, agreements, notes, or anything that should persist across conversations.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember. Be specific and include context (e.g. "Customer John Smith prefers morning deliveries and always rents the 65ft boom lift for 2-week periods").',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured tags, e.g. { "type": "customer_preference", "jobId": "GR-2026-0012", "customer": "John Smith" }',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'MEMORY_SEARCH',
    description: 'Search long-term memory for relevant information. Use this to recall customer history, past job details, preferences, notes, or any previously saved context before answering a question.',
    input_schema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Natural language search query, e.g. "John Smith delivery preferences" or "GR-2026-0012 payment notes"',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10)',
          default: 10,
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'MEMORY_LIST',
    description: 'List recent memories stored in long-term memory.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
      },
    },
  },
  {
    name: 'MEMORY_DELETE',
    description: 'Delete a specific memory by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory document ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'MEMORY_GET',
    description: 'Retrieve a specific memory document by ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory document ID' },
      },
      required: ['id'],
    },
  },
];

// ─── Dispatcher ────────────────────────────────────────────────

const MEMORY_FN_MAP = {
  MEMORY_ADD, MEMORY_SEARCH, MEMORY_LIST, MEMORY_DELETE, MEMORY_GET,
};

export async function dispatchMemoryTool(name, input) {
  const fn = MEMORY_FN_MAP[name];
  if (!fn) throw new Error(`Unknown memory tool: ${name}`);
  return fn(input || {});
}
