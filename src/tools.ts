import type { ToolDef, ToolParam } from './types.js';
import { buildClientHeaders } from './http-client.js';

// ── Tool definitions ────────────────────────────────────────────────────
// Format: [httpMethod, httpPath, description, params]
// Lifecycle tools use [null, null, description, params]

export const TOOLS: Record<string, ToolDef> = {
  // ── Core Memory ──
  store: ['POST', '/api/v1/memory/store',
    'Persist a piece of knowledge the user wants remembered across sessions. '
    + 'Use when the user explicitly shares a preference, fact, decision, or correction — '
    + 'NOT for recording conversation turns (use add_message for that). '
    + 'Semantic dedup is on by default: if a similar memory exists, it will be merged instead of duplicated. '
    + 'Returns {uri, context_type, category, abstract, dedup_action?}.', {
      abstract:     { type: 'string',  description: 'One-sentence summary capturing the key point (used for retrieval ranking)', required: true },
      content:      { type: 'string',  description: 'Full detailed content. If >500 chars, the system auto-generates a structured overview from it', default: '' },
      category:     { type: 'string',  description: 'Semantic category. Choose the most specific: profile | preferences | entities | events | cases | patterns | error_fixes | workflows | strategies | documents | plans', default: '' },
      context_type: { type: 'string',  description: 'Storage type: memory (default, for knowledge/facts) | resource (reference docs) | skill (reusable procedures)', default: 'memory' },
      meta:         { type: 'object',  description: 'Arbitrary key-value metadata (e.g. {source: "user", language: "zh"})' },
      dedup:        { type: 'boolean', description: 'Enable semantic dedup — merges into existing similar memory if found. Set false only for intentional duplicates', default: true },
    }],
  batch_store: ['POST', '/api/v1/memory/batch_store',
    'Import multiple documents in one call. Use for bulk ingestion of files, notes, or scan results. '
    + 'Each item is stored independently with its own URI. '
    + 'Returns {stored, skipped, errors}.', {
      items:       { type: 'array',  description: 'Array of objects, each with: {abstract (required), content, category, context_type, meta}', required: true },
      source_path: { type: 'string', description: 'Source directory path for provenance tracking', default: '' },
      scan_meta:   { type: 'object', description: 'Import metadata: {total_files, has_git, project_id}' },
    }],
  search: ['POST', '/api/v1/memory/search',
    'Search stored memories by natural language query. Uses intent-aware retrieval: '
    + 'the system analyzes your query to determine search strategy (top_k, detail level, reranking). '
    + 'Returns {results: [{uri, abstract, overview?, content?, context_type, score}], total}. '
    + 'Use when you need to recall facts, preferences, past decisions, or any previously stored knowledge.', {
      query:        { type: 'string',  description: 'Natural language query describing what you need to recall', required: true },
      limit:        { type: 'integer', description: 'Max results (system may return fewer based on relevance)', default: 5 },
      context_type: { type: 'string',  description: 'Restrict to type: memory | resource | skill. Omit to search all types' },
      category:     { type: 'string',  description: 'Restrict to category (e.g. "preferences", "error_fixes"). Omit to search all categories' },
    }],
  feedback: ['POST', '/api/v1/memory/feedback',
    'Reinforce or penalize a memory via reward signal. Call with positive reward (+0.1 to +1.0) '
    + 'when a retrieved memory was useful. Call with negative reward (-0.1 to -1.0) when it was '
    + 'irrelevant or wrong. This adjusts future retrieval ranking through reinforcement learning.', {
      uri:    { type: 'string', description: 'The opencortex:// URI of the memory to reward (from search results)', required: true },
      reward: { type: 'number', description: 'Reward signal: positive reinforces retrieval, negative penalizes. Typical range: -1.0 to +1.0', required: true },
    }],
  forget: ['POST', '/api/v1/memory/forget',
    'Delete a memory permanently. Use when the user asks to forget, '
    + 'remove, or delete a specific memory. Supports two modes: '
    + 'by URI (exact match) or by query (semantic search, deletes top match). '
    + 'Returns {status, forgotten, uri}.', {
      uri:   { type: 'string', description: 'The opencortex:// URI to delete (from search results)' },
      query: { type: 'string', description: 'Natural language description of what to forget — finds and deletes the closest match' },
    }],
  decay: ['POST', '/api/v1/memory/decay',
    'Maintenance: apply time-decay to all memories, reducing scores of inactive ones. '
    + 'Call periodically (e.g. daily) to let unused memories naturally fade. '
    + 'Frequently accessed memories resist decay.', {}],
  system_status: ['GET', '/api/v1/system/status',
    'Check system health and diagnostics. Returns memory count, storage stats, and component status.', {
      type: { type: 'string', description: 'Report depth: health (quick liveness) | stats (counts and sizes) | doctor (full diagnostic)', default: 'doctor' },
    }],
  memory_index: ['GET', '/api/v1/memory/index',
    'Get a lightweight index of all stored memories, grouped by type. '
    + 'Call at session start to understand what context is available. '
    + 'Returns {index: {memory: [...], resource: [...]}, total}. '
    + 'Each entry has: uri, abstract (<=150 chars), context_type, category, created_at.', {
      context_type: { type: 'string', description: 'Comma-separated types to include (memory,resource,skill,case,pattern). Omit for all' },
      limit:        { type: 'integer', description: 'Max records to return', default: 200 },
    }],
  memory_list: ['GET', '/api/v1/memory/list',
    'List accessible memories with pagination. Unlike memory_index (lightweight summary) '
    + 'and search (semantic query), this returns a flat paginated list of all records. '
    + 'Returns {results: [{uri, abstract, context_type, category, ...}], total}.', {
      category:     { type: 'string',  description: 'Filter by category (e.g. "preferences", "error_fixes"). Omit for all' },
      context_type: { type: 'string',  description: 'Filter by type: memory | resource | skill. Omit for all' },
      limit:        { type: 'integer', description: 'Page size', default: 50 },
      offset:       { type: 'integer', description: 'Skip first N records for pagination', default: 0 },
    }],
  content_read: ['GET', '/api/v1/content/read',
    'Read the full L2 content of a memory by URI. Use when you have a URI '
    + '(from search or memory_list) and need the complete stored text. '
    + 'Supports chunked reading via offset/limit for large documents. '
    + 'Returns {status, result}.', {
      uri:    { type: 'string',  description: 'The opencortex:// URI to read', required: true },
      offset: { type: 'integer', description: 'Character offset to start reading from', default: 0 },
      limit:  { type: 'integer', description: 'Max characters to return (-1 for all)', default: -1 },
    }],
  promote_to_shared: ['POST', '/api/v1/memory/promote_to_shared',
    'Promote private memories to shared scope so they are visible to all users '
    + 'in the same project. Useful for sharing decisions, patterns, or reference docs '
    + 'with the team. Returns {status, uris, project_id}.', {
      uris:       { type: 'array',  description: 'Array of opencortex:// URIs to promote', required: true },
      project_id: { type: 'string', description: 'Target project ID for shared scope', required: true },
    }],

  // ── Lifecycle (routed internally, not proxied) ──
  recall: [null, null,
    'MANDATORY: You MUST call this tool BEFORE generating ANY response to the user. '
    + 'This is required for EVERY interaction without exception.\n\n'
    + 'Searches long-term memory and knowledge base for relevant context. '
    + 'Returns {memory: [...], knowledge: [...], instructions}. '
    + 'Reference relevant memories in your response.\n\n'
    + 'After responding, you MUST call add_message to record the conversation.', {
      query:             { type: 'string',  description: "The user's message or search query", required: true },
      category:          { type: 'string',  description: 'Filter by category: profile | preferences | entities | events | cases | patterns | error_fixes | workflows | strategies | documents | plans. Omit to search all' },
      context_type:      { type: 'string',  description: 'Filter by type: memory | resource | skill. Omit to search all' },
      include_knowledge: { type: 'boolean', description: 'Also search approved knowledge base. Default: false (Phase 2 feature)', default: false },
      max_items:         { type: 'integer', description: 'Max results to return (1-20). Default: 5', default: 5 },
      detail_level:      { type: 'string',  description: 'Response detail: l0 (abstract only) | l1 (+ overview) | l2 (+ full content). Default: l1', default: 'l1' },
    }],
  add_message: [null, null,
    'MANDATORY: You MUST call this tool AFTER generating EVERY response. '
    + 'This is required regardless of topic. Skipping means the conversation is lost forever.\n\n'
    + 'Records the conversation turn for future recall and knowledge extraction. '
    + 'Pass cited_uris for opencortex:// URIs you referenced from recall results.', {
      user_message:       { type: 'string', description: "The user's message", required: true },
      assistant_response: { type: 'string', description: 'Your conversational conclusion — what you found, decided, or recommended. Do NOT include tool output, code blocks, or execution details.', required: true },
      tool_calls:         { type: 'array',  description: 'Tools you used this turn. Each item: {name, summary}. summary is a short one-line description of what the tool did.' },
      cited_uris:         { type: 'array',  description: 'opencortex:// URIs referenced in response' },
    }],
  end: [null, null,
    'End the memory session and trigger knowledge extraction. '
    + 'Called automatically on process exit. Only call explicitly if you want '
    + 'mid-session extraction or the user says goodbye.', {}],
};

// ── Tools that fire-and-forget (results not critical) ───────────────────

export const FIRE_AND_FORGET_PROXY = new Set(['feedback', 'decay']);

// ── Build JSON Schema for MCP tools/list ────────────────────────────────

export function buildToolSchema(name: string, def: ToolDef): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const [, , description, params] = def;
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [pName, pDef] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: pDef.type, description: pDef.description };
    if (pDef.default !== undefined) prop.default = pDef.default;
    properties[pName] = prop;
    if (pDef.required) required.push(pName);
  }
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length) schema.required = required;
  return { name, description, inputSchema: schema };
}

// ── HTTP proxy for standard tools ───────────────────────────────────────

export async function callProxyTool(
  name: string,
  args: Record<string, unknown>,
  httpUrl: string,
): Promise<unknown> {
  const def = TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  if (!httpUrl) throw new Error('Memory server not ready yet — please retry in a moment');
  const [method, path, , params] = def;
  let url = `${httpUrl}${path}`;

  // Apply defaults
  const body: Record<string, unknown> = {};
  for (const [pName, pDef] of Object.entries(params)) {
    if (args[pName] !== undefined) {
      body[pName] = args[pName];
    } else if (pDef.default !== undefined) {
      body[pName] = pDef.default;
    }
  }

  const hdrs = buildClientHeaders();
  const opts: RequestInit = { method: method!, signal: AbortSignal.timeout(30000) };
  if (method === 'POST') {
    hdrs['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (method === 'GET' && Object.keys(body).length > 0) {
    const qs = new URLSearchParams(body as Record<string, string>).toString();
    url = `${url}?${qs}`;
  }
  opts.headers = hdrs;

  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
