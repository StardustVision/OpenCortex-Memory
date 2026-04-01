# TypeScript Migration + Module Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the entire OpenCortex-Memory MCP plugin from JavaScript (.mjs) to TypeScript, restructure oversized modules, replace hand-written JSON-RPC with `@modelcontextprotocol/sdk`, and remove ui-server.

**Architecture:** Source in `src/`, tsup compiles to `dist/*.mjs`. `common.mjs` splits into `config.ts` + `project.ts`. `mcp-server.mjs` splits into `server.ts` + `tools.ts` + `lifecycle.ts`. MCP SDK provides stdio transport + JSON-RPC handling.

**Tech Stack:** TypeScript 5.8, tsup 8, @modelcontextprotocol/sdk 1.x, tsx 4 (test runner), undici 7.x

**Spec:** `docs/superpowers/specs/2026-04-01-typescript-migration-design.md`

---

### Task 1: Build Infrastructure

**Files:**
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `src/.gitkeep` (placeholder so src/ exists)
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/cli.ts', 'src/scan.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node18',
  splitting: true,
  clean: true,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
  outExtension: () => ({ js: '.mjs' }),
});
```

- [ ] **Step 3: Update package.json**

Change these fields (keep everything else):

```jsonc
{
  "bin": {
    "opencortex-memory": "dist/server.mjs",
    "opencortex-mcp": "dist/server.mjs",
    "opencortex-cli": "dist/cli.mjs"
  },
  "files": [
    "dist",
    "skills",
    "gemini-extension.json",
    "README.md"
  ],
  "scripts": {
    "build": "tsup",
    "check": "tsc --noEmit",
    "prepublishOnly": "npm run build",
    "test": "tsx --test tests/server.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1",
    "undici": "^7.24.6"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsup": "^8",
    "tsx": "^4",
    "typescript": "^5.8"
  }
}
```

- [ ] **Step 4: Update .gitignore**

Add these lines:

```
dist/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: Installs typescript, tsup, tsx, @types/node, @modelcontextprotocol/sdk

- [ ] **Step 6: Commit**

```bash
git add tsconfig.json tsup.config.ts package.json package-lock.json .gitignore
git commit -m "chore: add TypeScript build infrastructure (tsup + tsc)"
```

---

### Task 2: Shared Types (`src/types.ts`)

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
// ── Configuration ─────────────────────────────────────────────────────

export interface McpConfig {
  mode: 'local' | 'remote';
  token: string;
  local: { http_port: number };
  remote: { http_url: string };
  [key: string]: unknown;
}

// ── Tool definitions ──────────────────────────────────────────────────

export interface ToolParam {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export type ToolDef = [
  method: 'GET' | 'POST' | null,
  path: string | null,
  description: string,
  params: Record<string, ToolParam>,
];

// ── Context API ───────────────────────────────────────────────────────

export interface ContextRequest {
  session_id: string;
  phase: 'prepare' | 'commit' | 'end';
  turn_id?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tool_calls?: Array<{ name: string; summary: string }>;
  cited_uris?: string[];
  config?: Record<string, unknown>;
}

export interface DegradedResult {
  _degraded: true;
  reason: string;
  [key: string]: unknown;
}

// ── Transcript ────────────────────────────────────────────────────────

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  uuid?: string;
  id?: string;
}

export interface Turn {
  turnUuid: string;
  userText: string;
  assistantText: string;
  toolUses: string[];
}

// ── Scan output ───────────────────────────────────────────────────────

export interface ScanItem {
  abstract: string;
  content: string;
  category: string;
  context_type: string;
  meta: { source: string; file_path: string; file_type: string };
}

export interface ScanOutput {
  items: ScanItem[];
  source_path: string;
  scan_meta: { total_files: number; has_git: boolean; project_id: string };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors (only types.ts exists, no other files reference it yet)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared TypeScript type definitions"
```

---

### Task 3: Config Module (`src/config.ts`)

**Files:**
- Create: `src/config.ts`

Extracts config-related code from `lib/common.mjs`: config discovery, defaults, env overrides, I/O helpers.

- [ ] **Step 1: Create src/config.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { McpConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PLUGIN_ROOT = join(__dirname, '..');
export const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ── Default MCP config ──────────────────────────────────────────────────

export const DEFAULT_MCP_CONFIG: McpConfig = {
  mode: 'local',
  token: '',
  local: { http_port: 8921 },
  remote: { http_url: 'http://127.0.0.1:8921' },
};

// ── stdin / stdout helpers ──────────────────────────────────────────────

export async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString().trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function output(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── MCP config discovery ────────────────────────────────────────────────

function findMcpConfig(): string | null {
  const candidates = [
    join(PROJECT_DIR, 'mcp.json'),
    join(PROJECT_DIR, 'opencortex.json'),
    join(PROJECT_DIR, '.opencortex.json'),
    join(homedir(), '.opencortex', 'mcp.json'),
    join(homedir(), '.opencortex', 'opencortex.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function _migrateLegacyConfig(legacyData: Record<string, unknown>): McpConfig {
  const mcp: McpConfig = { ...DEFAULT_MCP_CONFIG, local: { ...DEFAULT_MCP_CONFIG.local }, remote: { ...DEFAULT_MCP_CONFIG.remote } };
  if (legacyData.mcp_mode) mcp.mode = legacyData.mcp_mode as McpConfig['mode'];
  const port = legacyData.http_server_port as number | undefined;
  if (port) mcp.local.http_port = port;
  if (legacyData.http_server_host || legacyData.http_server_port) {
    const host = (legacyData.http_server_host as string) || '127.0.0.1';
    const p = (legacyData.http_server_port as number) || 8921;
    mcp.remote.http_url = `http://${host}:${p}`;
  }
  return mcp;
}

export function ensureDefaultConfig(): string {
  const configDir = join(homedir(), '.opencortex');
  const mcpPath = join(configDir, 'mcp.json');
  if (existsSync(mcpPath)) return mcpPath;

  mkdirSync(configDir, { recursive: true });

  const legacyPath = join(configDir, 'opencortex.json');
  let mcpData: McpConfig = { ...DEFAULT_MCP_CONFIG, local: { ...DEFAULT_MCP_CONFIG.local }, remote: { ...DEFAULT_MCP_CONFIG.remote } };
  if (existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      mcpData = _migrateLegacyConfig(legacy);
    } catch { /* fall through */ }
  }

  writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2) + '\n');
  _mcpConfig = undefined;
  return mcpPath;
}

export function writeMcpConfig(data: Partial<McpConfig>): string {
  const configDir = join(homedir(), '.opencortex');
  const mcpPath = join(configDir, 'mcp.json');
  mkdirSync(configDir, { recursive: true });
  const merged: McpConfig = { ...DEFAULT_MCP_CONFIG, ...data };
  if (data.local) merged.local = { ...DEFAULT_MCP_CONFIG.local, ...data.local };
  if (data.remote) merged.remote = { ...DEFAULT_MCP_CONFIG.remote, ...data.remote };
  writeFileSync(mcpPath, JSON.stringify(merged, null, 2) + '\n');
  _mcpConfig = undefined;
  return mcpPath;
}

// ── Cached MCP config ───────────────────────────────────────────────────

let _mcpConfig: McpConfig | undefined;

function _applyEnvOverrides(cfg: McpConfig): void {
  const env = process.env;
  if (env.OPENCORTEX_TOKEN) cfg.token = env.OPENCORTEX_TOKEN;
  if (env.OPENCORTEX_MODE) cfg.mode = env.OPENCORTEX_MODE as McpConfig['mode'];
  if (env.OPENCORTEX_HTTP_PORT) {
    const p = parseInt(env.OPENCORTEX_HTTP_PORT, 10);
    if (Number.isFinite(p)) cfg.local.http_port = p;
    else process.stderr.write(`[opencortex] OPENCORTEX_HTTP_PORT is not a valid integer: "${env.OPENCORTEX_HTTP_PORT}"\n`);
  }
  if (env.OPENCORTEX_HTTP_URL) cfg.remote.http_url = env.OPENCORTEX_HTTP_URL;
}

function _loadMcpConfig(): McpConfig {
  if (_mcpConfig !== undefined) return _mcpConfig;
  const p = findMcpConfig();
  if (!p) { _mcpConfig = { ...DEFAULT_MCP_CONFIG, local: { ...DEFAULT_MCP_CONFIG.local }, remote: { ...DEFAULT_MCP_CONFIG.remote } }; return _mcpConfig; }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    _mcpConfig = { ...DEFAULT_MCP_CONFIG, ...raw };
    if (raw.local) _mcpConfig.local = { ...DEFAULT_MCP_CONFIG.local, ...raw.local };
    if (raw.remote) _mcpConfig.remote = { ...DEFAULT_MCP_CONFIG.remote, ...raw.remote };
  } catch {
    _mcpConfig = { ...DEFAULT_MCP_CONFIG, local: { ...DEFAULT_MCP_CONFIG.local }, remote: { ...DEFAULT_MCP_CONFIG.remote } };
  }
  _applyEnvOverrides(_mcpConfig);
  return _mcpConfig;
}

export function getMcpConfig(dotKey: string, defaultVal?: unknown): unknown {
  const cfg = _loadMcpConfig() as Record<string, unknown>;
  const keys = dotKey.split('.');
  let cur: unknown = cfg;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return defaultVal;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? defaultVal;
}

export function getPluginConfig(dotKey: string, defaultVal?: unknown): unknown {
  return getMcpConfig(dotKey, defaultVal);
}

export function getPluginMode(): string {
  return getMcpConfig('mode', 'local') as string;
}

export function getConfigPath(): string | null {
  return findMcpConfig();
}

let _projectConfig: Record<string, unknown> | null | undefined;
export function getProjectConfig(): Record<string, unknown> | null {
  if (_projectConfig !== undefined) return _projectConfig;
  const p = findMcpConfig();
  if (!p) { _projectConfig = null; return null; }
  try { _projectConfig = JSON.parse(readFileSync(p, 'utf-8')); } catch { _projectConfig = null; }
  return _projectConfig;
}

export function getHttpUrl(): string {
  const mode = getMcpConfig('mode', 'local') as string;
  if (mode === 'remote') return getMcpConfig('remote.http_url', 'http://127.0.0.1:8921') as string;
  const port = getMcpConfig('local.http_port', 8921) as number;
  return `http://127.0.0.1:${port}`;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: extract config module from common.mjs"
```

---

### Task 4: Project Module (`src/project.ts`)

**Files:**
- Create: `src/project.ts`

Extracts project detection, state management, python/uv discovery, and local HTTP server startup from `lib/common.mjs`.

- [ ] **Step 1: Create src/project.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants, openSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { PROJECT_DIR, getMcpConfig, getConfigPath, getPluginMode, getHttpUrl, PLUGIN_ROOT } from './config.js';

// ── State management ──────────────────────────────────────────────────

const STATE_DIR = join(PROJECT_DIR, '.opencortex', 'memory');
export const STATE_FILE = join(STATE_DIR, 'session_state.json');

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

export function loadState(): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return null; }
}

export function saveState(state: Record<string, unknown>): void {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ── Project ID detection ────────────────────────────────────────────────

let _projectId: string | undefined;

export function detectProjectId(): string {
  if (_projectId !== undefined) return _projectId;
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    _projectId = basename(toplevel) || 'public';
  } catch {
    _projectId = 'public';
  }
  return _projectId;
}

export function getProjectId(): string {
  return detectProjectId();
}

// ── Python / uv discovery ───────────────────────────────────────────────

export function findUv(): string | null {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe'), 'uv']
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), 'uv'];
  for (const c of candidates) {
    try {
      if (c.includes('/') || c.includes('\\')) {
        accessSync(c, constants.X_OK);
        return c;
      }
      execSync(isWin ? `where ${c}` : `which ${c}`, { stdio: 'ignore' });
      return c;
    } catch { /* next */ }
  }
  return null;
}

export function findPython(): string {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [join(PROJECT_DIR, '.venv', 'Scripts', 'python.exe'), 'python3', 'python']
    : [join(PROJECT_DIR, '.venv', 'bin', 'python3'), 'python3', 'python'];
  for (const c of candidates) {
    try {
      if (c.includes('/') || c.includes('\\')) {
        accessSync(c, constants.X_OK);
        return c;
      }
      return c;
    } catch { /* next */ }
  }
  return 'python3';
}

// ── Build context ───────────────────────────────────────────────────────

export function buildContext(input: unknown): Record<string, unknown> {
  return {
    input,
    pluginRoot: PLUGIN_ROOT,
    projectDir: PROJECT_DIR,
    stateDir: STATE_DIR,
    stateFile: STATE_FILE,
    configPath: getConfigPath(),
    mode: getPluginMode(),
    httpUrl: getHttpUrl(),
  };
}

// ── Local HTTP server launcher ──────────────────────────────────────────

export async function startLocalHttpServer(
  httpUrl: string,
  log?: (msg: string) => void,
): Promise<{ pid: number; ready: boolean }> {
  const _log = log || ((msg: string) => process.stderr.write(`[opencortex] ${msg}\n`));

  const { healthCheck } = await import('./http-client.js');
  if (await healthCheck(httpUrl)) {
    return { pid: 0, ready: true };
  }

  const httpPort = getMcpConfig('local.http_port', 8921) as number;
  ensureStateDir();
  const logPath = join(PROJECT_DIR, '.opencortex', 'memory', 'http_server.log');
  const logFd = openSync(logPath, 'a');

  const uv = findUv();
  const spawnCmd: [string, string[]] = uv
    ? [uv, ['run', 'opencortex-server', '--host', '127.0.0.1', '--port', String(httpPort), '--log-level', 'WARNING']]
    : [findPython(), ['-m', 'opencortex.http', '--host', '127.0.0.1', '--port', String(httpPort), '--log-level', 'WARNING']];

  const child = spawn(spawnCmd[0], spawnCmd[1], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const pid = child.pid || 0;
  child.unref();
  try { closeSync(logFd); } catch { /* ignore */ }

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await (await import('./http-client.js')).healthCheck(httpUrl)) {
      _log(`HTTP server ready on port ${httpPort} (pid ${pid})`);
      return { pid, ready: true };
    }
  }

  _log(`HTTP server failed to start on port ${httpPort}`);
  return { pid, ready: false };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/project.ts
git commit -m "feat: extract project module from common.mjs"
```

---

### Task 5: HTTP Client (`src/http-client.ts`)

**Files:**
- Create: `src/http-client.ts`

1:1 migration of `lib/http-client.mjs` with types added. Import paths change from `./common.mjs` to `./config.js` + `./project.js`.

- [ ] **Step 1: Create src/http-client.ts**

```typescript
import { Agent, setGlobalDispatcher } from 'undici';
import { getMcpConfig } from './config.js';
import { getProjectId } from './project.js';

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  connections: 10,
}));

export function buildClientHeaders(): Record<string, string> {
  const hdrs: Record<string, string> = {};
  const token = getMcpConfig('token', '') as string;
  if (token) {
    hdrs['Authorization'] = `Bearer ${token}`;
  }
  hdrs['X-Project-ID'] = getProjectId();
  return hdrs;
}

export async function httpPost(
  url: string,
  data: unknown,
  timeoutMs = 10000,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers = { 'Content-Type': 'application/json', ...buildClientHeaders(), ...extraHeaders };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

export async function httpGet(
  url: string,
  timeoutMs = 5000,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers = { ...buildClientHeaders(), ...extraHeaders };
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

export async function sessionMessagesBatch(
  httpUrl: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs = 5000,
): Promise<unknown> {
  return httpPost(`${httpUrl}/api/v1/session/messages`, {
    session_id: sessionId,
    messages,
  }, timeoutMs);
}

export async function healthCheck(httpUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${httpUrl}/api/v1/memory/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/http-client.ts
git commit -m "feat: migrate http-client to TypeScript"
```

---

### Task 6: Tool Definitions (`src/tools.ts`)

**Files:**
- Create: `src/tools.ts`

Extracts tool metadata definitions + HTTP proxy logic from `mcp-server.mjs`.

- [ ] **Step 1: Create src/tools.ts**

```typescript
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

export const FIRE_AND_FORGET_PROXY = new Set(['store', 'batch_store', 'feedback', 'decay']);

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
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/tools.ts
git commit -m "feat: extract tool definitions and proxy from mcp-server"
```

---

### Task 7: Lifecycle Handlers (`src/lifecycle.ts`)

**Files:**
- Create: `src/lifecycle.ts`

Session lifecycle handlers (recall, add_message, end) + fire-and-forget write queue + graceful degradation.

- [ ] **Step 1: Create src/lifecycle.ts**

```typescript
import { buildClientHeaders } from './http-client.js';
import type { ContextRequest, DegradedResult } from './types.js';

// ── Session state ───────────────────────────────────────────────────────

let _turnCounter = 0;
let _lastRecallTurnId: string | null = null;

export function resetState(): void {
  _turnCounter = 0;
  _lastRecallTurnId = null;
}

// ── Async write queue ───────────────────────────────────────────────────

const _pendingWrites = new Set<Promise<unknown>>();

export function fireAndForget(asyncFn: () => Promise<unknown>, label: string): void {
  const p = asyncFn().catch(err => {
    process.stderr.write(`[opencortex-mcp] async ${label} failed: ${(err as Error).message}\n`);
  });
  _pendingWrites.add(p);
  p.finally(() => _pendingWrites.delete(p));
}

export async function flushPendingWrites(timeoutMs = 5000): Promise<void> {
  if (_pendingWrites.size === 0) return;
  process.stderr.write(`[opencortex-mcp] flushing ${_pendingWrites.size} pending write(s)...\n`);
  await Promise.race([
    Promise.allSettled([..._pendingWrites]),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

// ── Context API call with graceful degradation ──────────────────────────

export async function httpContextCall(
  body: ContextRequest,
  httpUrl: string,
): Promise<unknown> {
  const hdrs = buildClientHeaders();
  hdrs['Content-Type'] = 'application/json';

  let res: Response, text: string;
  try {
    res = await fetch(`${httpUrl}/api/v1/context`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    text = await res.text();
  } catch (err) {
    const reason = `Memory unavailable: ${(err as Error).message}`;
    process.stderr.write(`[opencortex-mcp] ${reason}\n`);
    return _degradedResult(body.phase, reason);
  }

  if (!res.ok) {
    const detail = text?.slice(0, 200) || 'unknown error';
    const reason = res.status === 401 || res.status === 403
      ? `Memory unavailable (HTTP ${res.status}): authentication required`
      : `Memory unavailable (HTTP ${res.status}): ${detail}`;
    process.stderr.write(`[opencortex-mcp] ${reason}\n`);
    return _degradedResult(body.phase, reason);
  }

  try { return JSON.parse(text); } catch { return text; }
}

function _degradedResult(phase: string, reason: string): DegradedResult & Record<string, unknown> {
  switch (phase) {
    case 'prepare':
      return { memory: [], knowledge: [], instructions: reason, _degraded: true, reason };
    case 'commit':
      return { accepted: false, _degraded: true, reason };
    case 'end':
      return { status: 'skipped', _degraded: true, reason };
    default:
      return { _degraded: true, reason };
  }
}

// ── Lifecycle handlers ──────────────────────────────────────────────────

export async function handleRecall(
  args: Record<string, unknown>,
  sessionId: string,
  httpUrl: string,
): Promise<unknown> {
  _turnCounter++;
  const turnId = `t${_turnCounter}`;
  _lastRecallTurnId = turnId;

  const config: Record<string, unknown> = {};
  if (args.max_items !== undefined) config.max_items = args.max_items;
  if (args.detail_level !== undefined) config.detail_level = args.detail_level;
  if (args.category !== undefined) config.category = args.category;
  if (args.context_type !== undefined) config.context_type = args.context_type;
  if (args.include_knowledge !== undefined) config.include_knowledge = args.include_knowledge;

  const body: ContextRequest = {
    session_id: sessionId,
    phase: 'prepare',
    turn_id: turnId,
    messages: [{ role: 'user', content: args.query as string }],
    config,
  };

  return await httpContextCall(body, httpUrl);
}

export async function handleAddMessage(
  args: Record<string, unknown>,
  sessionId: string,
  httpUrl: string,
): Promise<{ accepted: true; turn_id: string }> {
  const turnId = _lastRecallTurnId || `t${++_turnCounter}`;

  const body: ContextRequest = {
    session_id: sessionId,
    phase: 'commit',
    turn_id: turnId,
    messages: [
      { role: 'user', content: args.user_message as string },
      { role: 'assistant', content: args.assistant_response as string },
    ],
  };
  if (args.tool_calls) body.tool_calls = args.tool_calls as ContextRequest['tool_calls'];
  if (args.cited_uris) body.cited_uris = args.cited_uris as string[];

  // Fire-and-forget: recording conversation should never block Claude
  fireAndForget(() => httpContextCall(body, httpUrl), `add_message:${turnId}`);
  return { accepted: true, turn_id: turnId };
}

export async function handleEnd(
  sessionId: string,
  httpUrl: string,
): Promise<unknown> {
  return await httpContextCall({ session_id: sessionId, phase: 'end' }, httpUrl);
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lifecycle.ts
git commit -m "feat: extract lifecycle handlers with fire-and-forget queue"
```

---

### Task 8: MCP Server Entry (`src/server.ts`)

**Files:**
- Create: `src/server.ts`

Main entry point using `@modelcontextprotocol/sdk`. Replaces hand-written JSON-RPC transport.

- [ ] **Step 1: Create src/server.ts**

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { getHttpUrl, getPluginMode, getMcpConfig, ensureDefaultConfig } from './config.js';
import { startLocalHttpServer } from './project.js';
import { healthCheck, httpPost } from './http-client.js';
import { TOOLS, FIRE_AND_FORGET_PROXY, buildToolSchema, callProxyTool } from './tools.js';
import { handleRecall, handleAddMessage, handleEnd, fireAndForget, flushPendingWrites, httpContextCall } from './lifecycle.js';

// ── Load version from package.json ──────────────────────────────────────

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = _require('../package.json').version;

// ── Session state ───────────────────────────────────────────────────────

let _httpUrl: string | null = null;
let _sessionId: string | null = null;
let _httpPid = 0;
let _initialized = false;
let _shuttingDown = false;

// ── Usage guide prompt ──────────────────────────────────────────────────

const USAGE_GUIDE_TEXT = `# OpenCortex Automatic Memory System — Mandatory Usage

## Always-On (No User Opt-In Required)
This system runs **automatically for every turn**. Do NOT wait for the user to say "use memory" or "call a tool". You MUST follow the workflow below for EVERY interaction.

## Mandatory 3-Step Workflow (Every Turn)

\`\`\`
User sends message
  → Step 1: recall(query)           — BEFORE you answer
  → Step 2: Generate your response  — reference relevant memories
  → Step 3: add_message(user, assistant) — AFTER you answer
\`\`\`

### Step 1: recall (BEFORE answering)
- Call \`recall\` with the user's message as query
- This retrieves relevant memories and knowledge from long-term storage
- You MUST do this even for greetings like "hello" or simple questions
- Use the returned \`memory[]\` and \`knowledge[]\` to inform your response

### Step 2: Generate response
- Reference relevant memories naturally in your answer
- Do NOT blindly trust all recalled memories — apply judgment:
  1. Is the memory from the user's own words or an AI summary?
  2. Is it relevant to the current query?
  3. Does it conflict with newer information the user just provided?
- If no relevant memories are found, respond normally

### Step 3: add_message (AFTER answering)
- Call \`add_message\` with:
  - \`user_message\`: the user's original message
  - \`assistant_response\`: your conversational conclusion ONLY — what you found, decided, or recommended
    - Do NOT include: tool output, code blocks, command results, diffs, logs
    - Do include: decisions, findings, next steps, explanations
  - \`tool_calls\`: list of tools you used, each with {name, summary}
- Pass \`cited_uris\` for any opencortex:// URIs you referenced
- This is NOT optional — skipping means the conversation is lost forever

## Session Lifecycle (Automatic)
- \`session_begin\` — triggered automatically when this MCP server starts
- \`end\` — triggered automatically when this MCP server exits
- You do NOT need to call these manually

## Tool Quick Reference
| Tool | When | Purpose |
|------|------|---------|
| recall | BEFORE every response | Retrieve relevant memories |
| add_message | AFTER every response | Record the conversation turn |
| store | User wants to save something | Persist explicit knowledge |
| search | User asks to find memories | Search stored memories |
| feedback | Memory was useful/wrong | Reinforce or penalize via RL |
| end | Only if user says goodbye | Mid-session knowledge extraction |

## Memory Storage Guide

### What to Store
- **User context**: Role, expertise, preferences, working style, communication style
- **Behavioral feedback**: Corrections to your approach, confirmed good patterns, things to avoid
- **Project context**: Active goals, deadlines (use absolute dates), key decisions, blockers
- **Reference pointers**: URLs, doc locations, tool configurations, reusable procedures

### What NOT to Store
- Code structure, file paths, architecture — derivable from reading the codebase
- Git history, recent changes — use git log / git blame
- Debugging steps or fix recipes — the fix is in the code, the context in the commit
- Anything already in CLAUDE.md, AGENTS.md, or project docs
- Ephemeral task state or current conversation context
- Raw code snippets — store a description of the pattern instead

### Storage Tips
- Use descriptive abstracts (>10 chars) that capture the "why" not just the "what"
- Set a meaningful category to improve dedup and retrieval
- Convert relative dates to absolute dates before storing
`;

// ── Tool dispatcher ─────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'recall':
      return handleRecall(args, _sessionId!, _httpUrl!);
    case 'add_message':
      return handleAddMessage(args, _sessionId!, _httpUrl!);
    case 'end':
      return handleEnd(_sessionId!, _httpUrl!);
    default: {
      if (FIRE_AND_FORGET_PROXY.has(name)) {
        fireAndForget(() => callProxyTool(name, args, _httpUrl!), name);
        return { queued: true, tool: name };
      }
      return callProxyTool(name, args, _httpUrl!);
    }
  }
}

// ── Init / Shutdown lifecycle ───────────────────────────────────────────

async function initSession(): Promise<void> {
  _httpUrl = getHttpUrl();
  const mode = getPluginMode();
  const _log = (msg: string) => process.stderr.write(`[opencortex-mcp] ${msg}\n`);

  if (mode === 'local') {
    const result = await startLocalHttpServer(_httpUrl, _log);
    _httpPid = result.pid;
    if (!result.ready) {
      _log('WARNING: HTTP server not ready — tools may fail');
    }
  } else {
    const ok = await healthCheck(_httpUrl);
    if (!ok) {
      _log(`WARNING: remote server unreachable at ${_httpUrl}`);
    }
  }

  _sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await httpPost(`${_httpUrl}/api/v1/session/begin`, { session_id: _sessionId }, 5000);
  } catch { /* best-effort */ }

  _initialized = true;
  _log(`session ${_sessionId} (${mode} mode)`);
}

async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const _log = (msg: string) => process.stderr.write(`[opencortex-mcp] ${msg}\n`);

  await flushPendingWrites();

  if (_initialized && _sessionId && _httpUrl) {
    const result = await httpContextCall(
      { session_id: _sessionId, phase: 'end' },
      _httpUrl,
    ) as Record<string, unknown>;
    _log(result?._degraded ? `session end skipped: ${result.reason}` : 'session ended');
  }

  if (_httpPid > 0 && getPluginMode() === 'local') {
    try { process.kill(_httpPid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDefaultConfig();

  const server = new Server(
    { name: 'opencortex', version: PKG_VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // ── tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, def]) => buildToolSchema(name, def)),
  }));

  // ── tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments || {}) as Record<string, unknown>;
    try {
      const result = await callTool(toolName, toolArgs);
      return {
        content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // ── prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: 'usage-guide',
      description: 'OpenCortex memory system — mandatory usage guide for every conversation turn',
    }],
  }));

  // ── prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'usage-guide') {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    return {
      description: 'OpenCortex memory system — mandatory usage guide for every conversation turn',
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: USAGE_GUIDE_TEXT },
      }],
    };
  });

  // Graceful shutdown
  const onExit = () => { shutdown().finally(() => process.exit(0)); };
  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);

  // Init session after MCP handshake
  server.oninitialized = () => {
    initSession().catch(err => {
      process.stderr.write(`[opencortex-mcp] init error: ${(err as Error).message}\n`);
    });
  };

  server.onclose = () => { shutdown(); };

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors. If `server.oninitialized` is not recognized, check SDK docs and use `server.setNotificationHandler` with `InitializedNotificationSchema` instead.

- [ ] **Step 3: Test basic startup**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | npx tsup --silent && node dist/server.mjs 2>/dev/null | head -1`
Expected: JSON response with `serverInfo.name === "opencortex"`

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP server entry with @modelcontextprotocol/sdk"
```

---

### Task 9: Setup Wizard (`src/setup.ts`)

**Files:**
- Create: `src/setup.ts`

1:1 migration of `lib/setup.mjs` with types. Import path updates.

- [ ] **Step 1: Create src/setup.ts**

```typescript
import { createInterface, type Interface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MCP_CONFIG, writeMcpConfig } from './config.js';
import { healthCheck } from './http-client.js';
import type { McpConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_PATH = join(__dirname, 'server.mjs');

function createRL(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, answer => resolve(answer.trim()));
    rl.once('close', () => resolve(''));
  });
}

async function askChoice(rl: Interface, question: string, choices: string[]): Promise<string> {
  const labels = choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n');
  while (true) {
    const answer = await ask(rl, `${question}\n${labels}\n> `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
    console.log(`Please enter 1-${choices.length}.`);
  }
}

export async function runSetup(): Promise<void> {
  const rl = createRL();

  try {
    console.log('\n=== OpenCortex Setup ===\n');

    const mode = await askChoice(rl, 'Select mode:', ['local', 'remote']) as McpConfig['mode'];
    const config: Partial<McpConfig> = { ...DEFAULT_MCP_CONFIG, mode };

    if (mode === 'remote') {
      const url = await ask(rl, `Server URL [${DEFAULT_MCP_CONFIG.remote.http_url}]: `);
      if (url) config.remote = { http_url: url };
      const token = await ask(rl, 'JWT token: ');
      if (token) config.token = token;
    } else {
      const port = await ask(rl, `HTTP port [${DEFAULT_MCP_CONFIG.local.http_port}]: `);
      if (port) {
        const parsed = parseInt(port, 10);
        config.local = { http_port: Number.isFinite(parsed) ? parsed : DEFAULT_MCP_CONFIG.local.http_port };
        if (!Number.isFinite(parsed)) console.log(`Invalid port "${port}", using default ${DEFAULT_MCP_CONFIG.local.http_port}`);
      }
      const token = await ask(rl, 'JWT token (optional, press Enter to skip): ');
      if (token) config.token = token;
    }

    const configPath = writeMcpConfig(config);
    console.log(`\nConfig saved to ${configPath}`);

    const httpUrl = mode === 'remote'
      ? (config.remote?.http_url || DEFAULT_MCP_CONFIG.remote.http_url)
      : `http://127.0.0.1:${config.local?.http_port || DEFAULT_MCP_CONFIG.local.http_port}`;

    process.stdout.write(`Testing connection to ${httpUrl} ... `);
    const ok = await healthCheck(httpUrl);
    console.log(ok ? 'OK' : 'UNREACHABLE (you can configure the server later)');

    let registerClaude = 'no';
    try {
      registerClaude = await askChoice(rl, '\nRegister as Claude Code user-level MCP server? (all projects will have access)', ['yes', 'no']);
    } catch { /* readline closed */ }

    if (registerClaude === 'yes') {
      try {
        const cmdArgs = ['mcp', 'add', '-s', 'user', 'opencortex', '-e', `OPENCORTEX_MODE=${mode}`];
        if (config.token) cmdArgs.push('-e', `OPENCORTEX_TOKEN=${config.token}`);
        if (mode === 'remote' && config.remote?.http_url) cmdArgs.push('-e', `OPENCORTEX_HTTP_URL=${config.remote.http_url}`);
        if (mode === 'local' && config.local?.http_port) cmdArgs.push('-e', `OPENCORTEX_HTTP_PORT=${config.local.http_port}`);
        cmdArgs.push('--', 'node', MCP_SERVER_PATH);
        console.log(`\nRunning: claude ${cmdArgs.join(' ')}`);
        execFileSync('claude', cmdArgs, { stdio: 'inherit' });
        console.log('Registered successfully.');
      } catch { console.log('Failed to register. You can run the command manually later.'); }
    }

    console.log('\n=== Setup Complete ===');
    console.log(`  Mode:   ${mode}`);
    console.log(`  Server: ${httpUrl}`);
    console.log(`  Config: ${configPath}`);
    if (ok) {
      console.log('\nReady to use. Start a new Claude Code session to activate.\n');
    } else if (mode === 'local') {
      console.log('\nServer not reachable. Start the local server first:');
      console.log(`  uv run opencortex-server --host 127.0.0.1 --port ${config.local?.http_port || DEFAULT_MCP_CONFIG.local.http_port}`);
      console.log('\nOr via Docker:\n  docker compose up -d');
      console.log('\nThen verify with:\n  npx opencortex-cli health\n');
    } else {
      console.log('\nServer not reachable yet. Check your remote server, then verify with:\n  npx opencortex-cli health\n');
    }
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/setup.ts
git commit -m "feat: migrate setup wizard to TypeScript"
```

---

### Task 10: Transcript Utils (`src/transcript.ts`)

**Files:**
- Create: `src/transcript.ts`

1:1 migration of `lib/transcript.mjs` with types from `types.ts`.

- [ ] **Step 1: Create src/transcript.ts**

```typescript
import { readFileSync } from 'node:fs';
import type { TranscriptMessage, ContentBlock, Turn } from './types.js';

export function readJsonl(path: string): unknown[] {
  const lines = readFileSync(path, 'utf-8').split('\n');
  const rows: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return rows;
}

function short(s: string, maxLen: number): string {
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

export function extractTextParts(message: TranscriptMessage | null): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as ContentBlock[])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
}

export function extractToolUses(message: TranscriptMessage | null): string[] {
  if (!message || !Array.isArray(message.content)) return [];
  return (message.content as ContentBlock[])
    .filter(b => b.type === 'tool_use')
    .map(b => {
      const name = b.name || 'unknown';
      const input = b.input ? short(JSON.stringify(b.input), 120) : '';
      return `[tool-use] ${name}(${input})`;
    });
}

export function isToolResult(message: TranscriptMessage | null): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some(b => b.type === 'tool_result');
}

export function extractLastTurn(transcriptPath: string): Turn | null {
  const rows = readJsonl(transcriptPath) as TranscriptMessage[];
  if (!rows.length) return null;

  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = rows[i];
    if (msg.role === 'user' && !isToolResult(msg)) {
      const text = extractTextParts(msg);
      if (text.trim()) { lastUserIdx = i; break; }
    }
  }
  if (lastUserIdx < 0) return null;

  const userMsg = rows[lastUserIdx];
  const userText = extractTextParts(userMsg);
  const turnUuid = userMsg.uuid || userMsg.id || `turn-${lastUserIdx}`;

  const assistantParts: string[] = [];
  const toolUses: string[] = [];
  for (let i = lastUserIdx + 1; i < rows.length; i++) {
    const msg = rows[i];
    if (msg.role === 'user') break;
    if (msg.role === 'assistant') {
      const text = extractTextParts(msg);
      if (text) assistantParts.push(text);
      toolUses.push(...extractToolUses(msg));
    }
  }

  return { turnUuid, userText, assistantText: assistantParts.join('\n'), toolUses };
}

export function summarizeTurn(turn: Turn | null): string {
  if (!turn) return '';
  const lines: string[] = [];
  if (turn.userText) lines.push(`User: ${short(turn.userText, 200)}`);
  if (turn.toolUses?.length) {
    lines.push('Actions:');
    for (const tu of turn.toolUses.slice(0, 8)) lines.push(`  - ${tu}`);
    if (turn.toolUses.length > 8) lines.push(`  - ... and ${turn.toolUses.length - 8} more`);
  }
  if (turn.assistantText) lines.push(`Assistant: ${short(turn.assistantText, 300)}`);
  return lines.join('\n');
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/transcript.ts
git commit -m "feat: migrate transcript utils to TypeScript"
```

---

### Task 11: CLI Entry (`src/cli.ts`)

**Files:**
- Create: `src/cli.ts`

Migration of `bin/oc-cli.mjs` with types. Import paths updated to new modules.

- [ ] **Step 1: Create src/cli.ts**

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { getHttpUrl } from './config.js';
import { httpPost, httpGet, healthCheck } from './http-client.js';

const USAGE = `Usage: opencortex-cli <command> [options]

Commands:
  setup               Interactive setup wizard (configure local/remote mode)
  health              Check server health
  status              Show server status (via HTTP API)
  recall <query>      Search memories
  store <text>        Store a memory
  stats               Show memory statistics
  feedback <uri> <reward>
                     Apply reward feedback to a memory
  decay               Apply reward decay to all memories
  context-recall <query>
                     Test recall via /api/v1/context (prepare phase)
  context-commit <user_msg> <assistant_msg>
                     Test commit via /api/v1/context (commit phase)
  context-end         Test end via /api/v1/context (end phase)
  insights-generate [days]
                     Generate insights report (default: 7 days)
  insights-latest    Get latest insights report
  insights-history [limit]
                     Get insights report history (default: 10)

Options:
  --top-k, -k <n>    Number of results for recall (default: 5)
  --category, -c <s>  Category for store
  --session-id, -s <s> Session ID for context commands (default: auto-generated)
  --help, -h          Show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'top-k':      { type: 'string', short: 'k', default: '5' },
      'category':   { type: 'string', short: 'c', default: '' },
      'session-id': { type: 'string', short: 's', default: '' },
      'help':       { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const cmd = positionals[0];

  if (cmd === 'setup') {
    const { runSetup } = await import('./setup.js');
    await runSetup();
    process.exit(0);
  }

  const httpUrl = getHttpUrl();
  const sessionId = values['session-id'] || `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  switch (cmd) {
    case 'health': {
      const ok = await healthCheck(httpUrl);
      console.log(ok ? 'OK' : 'UNREACHABLE');
      process.exit(ok ? 0 : 1);
      break; // unreachable but satisfies TS
    }
    case 'status': {
      const data = await httpGet(`${httpUrl}/api/v1/system/status?type=health`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'recall': {
      const query = positionals.slice(1).join(' ');
      if (!query) { console.error('Usage: opencortex-cli recall <query>'); process.exit(1); }
      const topK = parseInt(values['top-k']!, 10) || 5;
      const data = await httpPost(`${httpUrl}/api/v1/memory/search`, { query, limit: topK }) as Record<string, unknown>;
      const results = data.results as Array<Record<string, unknown>> | undefined;
      if (results?.length) {
        for (const r of results) {
          console.log(`[${((r.score as number) ?? 0).toFixed(3)}] ${r.abstract || r.uri || '(no title)'}`);
          if (r.content) console.log(`  ${(r.content as string).slice(0, 200)}`);
          console.log();
        }
      } else { console.log('No results.'); }
      break;
    }
    case 'store': {
      const text = positionals.slice(1).join(' ');
      if (!text) { console.error('Usage: opencortex-cli store <text>'); process.exit(1); }
      const payload: Record<string, unknown> = { abstract: text.slice(0, 200), content: text, context_type: 'memory' };
      if (values.category) payload.category = values.category;
      const data = await httpPost(`${httpUrl}/api/v1/memory/store`, payload) as Record<string, unknown>;
      console.log('Stored:', data.uri || 'ok');
      break;
    }
    case 'stats': {
      const data = await httpGet(`${httpUrl}/api/v1/memory/stats`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'feedback': {
      const uri = positionals[1];
      const reward = Number.parseFloat(positionals[2]);
      if (!uri || Number.isNaN(reward)) { console.error('Usage: opencortex-cli feedback <uri> <reward>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/memory/feedback`, { uri, reward });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'decay': {
      const data = await httpPost(`${httpUrl}/api/v1/memory/decay`, {});
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-recall': {
      const query = positionals.slice(1).join(' ');
      if (!query) { console.error('Usage: opencortex-cli context-recall <query>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/context`, {
        session_id: sessionId, phase: 'prepare', turn_id: 't1',
        messages: [{ role: 'user', content: query }],
        config: { max_items: parseInt(values['top-k']!, 10) || 5 },
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-commit': {
      const userMsg = positionals[1], assistantMsg = positionals[2];
      if (!userMsg || !assistantMsg) { console.error('Usage: opencortex-cli context-commit <user_msg> <assistant_msg>'); process.exit(1); }
      const data = await httpPost(`${httpUrl}/api/v1/context`, {
        session_id: sessionId, phase: 'commit', turn_id: 't1',
        messages: [{ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg }],
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'context-end': {
      const data = await httpPost(`${httpUrl}/api/v1/context`, { session_id: sessionId, phase: 'end' });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-generate': {
      const days = parseInt(positionals[1], 10) || 7;
      const data = await httpPost(`${httpUrl}/api/v1/insights/generate?days=${days}`, {}, 300000);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-latest': {
      const data = await httpGet(`${httpUrl}/api/v1/insights/latest`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'insights-history': {
      const limit = parseInt(positionals[1], 10) || 10;
      const data = await httpGet(`${httpUrl}/api/v1/insights/history?limit=${limit}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch(err => { console.error(`Error: ${(err as Error).message}`); process.exit(1); });
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: migrate CLI entry to TypeScript"
```

---

### Task 12: File Scanner (`src/scan.ts`)

**Files:**
- Create: `src/scan.ts`

Migration of `bin/oc-scan.mjs` with types from `types.ts`.

- [ ] **Step 1: Create src/scan.ts**

```typescript
#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import type { ScanItem, ScanOutput } from './types.js';

const MAX_FILE_SIZE = 1024 * 1024;

const SUPPORTED_EXTS = new Set([
  '.md', '.mdx',
  '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.sh', '.yaml', '.yml', '.toml', '.json',
  '.css', '.html', '.txt', '.rst',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '.claude',
]);

function detectGit(dir: string): { hasGit: boolean; projectId: string } {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8',
    }).trim();
    return { hasGit: true, projectId: basename(toplevel) };
  } catch {
    return { hasGit: false, projectId: 'public' };
  }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function discoverFiles(dir: string): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    });
    return output.trim().split(/\r?\n/).filter(Boolean).map(f => join(dir, f));
  } catch {
    return walkDir(dir);
  }
}

function fileType(ext: string): string {
  if (['.md', '.mdx'].includes(ext)) return 'markdown';
  if (['.txt', '.rst'].includes(ext)) return 'text';
  return 'code';
}

// ── Main ──────────────────────────────────────────────────────────────

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scan.mjs <directory>');
  process.exit(1);
}

const { hasGit, projectId } = detectGit(targetDir);
const files = discoverFiles(targetDir).filter(f => {
  const ext = extname(f).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return false;
  try { return statSync(f).size <= MAX_FILE_SIZE; } catch { return false; }
});

const items: ScanItem[] = [];
for (const f of files) {
  const relPath = relative(targetDir, f);
  const ext = extname(f).toLowerCase();
  let content: string;
  try { content = readFileSync(f, 'utf-8'); } catch (err) {
    process.stderr.write(`[oc-scan] skipping ${relPath}: ${(err as Error).message}\n`);
    continue;
  }
  items.push({
    abstract: relPath, content, category: 'documents', context_type: 'resource',
    meta: { source: 'scan', file_path: relPath, file_type: fileType(ext) },
  });
}

const output: ScanOutput = {
  items, source_path: targetDir,
  scan_meta: { total_files: items.length, has_git: hasGit, project_id: projectId },
};

console.log(JSON.stringify(output));
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/scan.ts
git commit -m "feat: migrate file scanner to TypeScript"
```

---

### Task 13: Test Migration (`tests/server.test.ts`)

**Files:**
- Create: `tests/server.test.ts`

Migrates `tests/test_mcp_server.mjs` to TypeScript. Updates the MCP server path to `dist/server.mjs`. Tests must be run after `npm run build`.

- [ ] **Step 1: Build first**

Run: `npm run build`
Expected: dist/server.mjs, dist/cli.mjs, dist/scan.mjs created

- [ ] **Step 2: Create tests/server.test.ts**

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const MCP_SERVER = join(PROJECT_ROOT, 'dist', 'server.mjs');

function loadMcpConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'mcp.json'), 'utf8'));
  } catch { return {}; }
}

const MCP_CONFIG = loadMcpConfig();
const TEST_MODE = (MCP_CONFIG.mode as string) || 'local';
const HTTP_URL = TEST_MODE === 'remote'
  ? ((MCP_CONFIG.remote as Record<string, string>)?.http_url || 'http://127.0.0.1:8921')
  : 'http://127.0.0.1:8921';

const PKG = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${HTTP_URL}/api/v1/memory/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

interface McpClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  init(): Promise<void>;
  close(): void;
}

function createMcpClient(): McpClient {
  const child: ChildProcess = spawn('node', [MCP_SERVER], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  let nextId = 1;

  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id)!;
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* skip */ }
    }
  });

  return {
    async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout waiting for response to ${method}`)); }, 30000);
        pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const res = await this.request('tools/call', { name, arguments: args });
      const result = res.result as Record<string, unknown> | undefined;
      if (res.error) throw new Error((res.error as Record<string, string>).message);
      const content = result?.content as Array<Record<string, unknown>> | undefined;
      const text = content?.[0]?.text as string | undefined;
      if (!text) return result || {};
      if (result?.isError) throw new Error(text);
      try { return JSON.parse(text); } catch { return { _raw: text } as Record<string, unknown>; }
    },
    async init(): Promise<void> {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      await new Promise(r => setTimeout(r, 2000));
    },
    close(): void {
      child.stdin!.end();
      child.kill();
    },
  };
}

describe('MCP Server (TypeScript + SDK)', async () => {
  before(async () => {
    const ok = await healthCheck();
    if (!ok) throw new Error(`HTTP server unreachable at ${HTTP_URL}. Start it first.`);
  });

  it('01 initialize + list tools', async () => {
    const client = createMcpClient();
    try {
      const initRes = await client.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      });
      const result = initRes.result as Record<string, unknown>;
      const serverInfo = result.serverInfo as Record<string, string>;
      assert.equal(serverInfo.name, 'opencortex');
      assert.equal(serverInfo.version, PKG.version);

      const toolsRes = await client.request('tools/list');
      const toolsResult = toolsRes.result as Record<string, unknown>;
      const tools = toolsResult.tools as Array<Record<string, string>>;
      const names = tools.map(t => t.name);
      const EXPECTED = ['store', 'batch_store', 'search', 'feedback', 'forget', 'decay', 'system_status', 'memory_index', 'recall', 'add_message', 'end'];
      for (const e of EXPECTED) assert.ok(names.includes(e), `Missing tool: ${e}`);
      assert.equal(names.length, EXPECTED.length, `Expected ${EXPECTED.length} tools, got ${names.length}`);
    } finally { client.close(); }
  });

  it('02 store (fire-and-forget)', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('store', { abstract: 'User prefers dark theme', category: 'preferences' });
      assert.ok(data.queued, 'store should return queued: true');
    } finally { client.close(); }
  });

  it('03 search', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('search', { query: 'What tech stack?', limit: 5 });
      assert.ok('results' in data, 'Should have results');
      assert.ok('total' in data, 'Should have total');
    } finally { client.close(); }
  });

  it('04 feedback (fire-and-forget)', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const fb = await client.callTool('feedback', { uri: 'opencortex://test/dummy', reward: 1.0 });
      assert.ok(fb.queued, 'feedback should return queued: true');
    } finally { client.close(); }
  });

  it('05 system_status(stats)', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('system_status', { type: 'stats' });
      assert.ok('tenant_id' in data);
      assert.ok('storage' in data);
    } finally { client.close(); }
  });

  it('06 decay (fire-and-forget)', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('decay');
      assert.ok(data.queued, 'decay should return queued: true');
    } finally { client.close(); }
  });

  it('07 system_status(health)', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('system_status', { type: 'health' });
      assert.ok(data.initialized);
      assert.ok(data.storage);
      assert.ok(data.embedder);
    } finally { client.close(); }
  });

  it('08 search + system_status pipeline', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const searchResult = await client.callTool('search', { query: 'database', limit: 3 });
      assert.ok('results' in searchResult);
      const health = await client.callTool('system_status', { type: 'health' });
      assert.ok(health.initialized);
    } finally { client.close(); }
  });

  it('09 lifecycle: recall -> add_message -> end', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const recallResult = await client.callTool('recall', { query: 'How do we deploy?', max_items: 3 });
      assert.ok('memory' in recallResult);
      assert.ok('knowledge' in recallResult);
      assert.ok('instructions' in recallResult);

      const commitResult = await client.callTool('add_message', {
        user_message: 'How do we deploy?',
        assistant_response: 'We use Docker containers for deployment.',
      });
      assert.ok(commitResult.accepted);
      assert.ok(commitResult.turn_id);

      const endResult = await client.callTool('end', {});
      assert.ok(endResult.status);
    } finally { client.close(); }
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run build && npm test`
Expected: All 9 tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/server.test.ts
git commit -m "feat: migrate tests to TypeScript, update for fire-and-forget"
```

---

### Task 14: Cleanup + Final Verification

**Files:**
- Remove: `lib/common.mjs`, `lib/http-client.mjs`, `lib/mcp-server.mjs`, `lib/setup.mjs`, `lib/transcript.mjs`, `lib/ui-server.mjs`
- Remove: `bin/oc-cli.mjs`, `bin/oc-scan.mjs`
- Remove: `tests/test_mcp_server.mjs`

- [ ] **Step 1: Remove old JavaScript files**

```bash
rm lib/common.mjs lib/http-client.mjs lib/mcp-server.mjs lib/setup.mjs lib/transcript.mjs lib/ui-server.mjs
rm bin/oc-cli.mjs bin/oc-scan.mjs
rm tests/test_mcp_server.mjs
rmdir lib bin 2>/dev/null || true
```

- [ ] **Step 2: Full type check**

Run: `npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 3: Full build**

Run: `npm run build`
Expected: dist/server.mjs, dist/cli.mjs, dist/scan.mjs + shared chunks

- [ ] **Step 4: Verify shebang in dist output**

Run: `head -1 dist/server.mjs dist/cli.mjs dist/scan.mjs`
Expected: `#!/usr/bin/env node` on each

- [ ] **Step 5: Run integration tests**

Run: `npm test`
Expected: All 9 tests pass

- [ ] **Step 6: Verify CLI works**

Run: `node dist/cli.mjs health`
Expected: `OK` (if HTTP server running) or `UNREACHABLE`

- [ ] **Step 7: Verify npx dry-run**

Run: `node dist/server.mjs --help 2>/dev/null || echo "server starts (no --help, expected)"`
Expected: Server starts waiting for stdin (ctrl+C to stop)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove old .mjs files, complete TypeScript migration"
```
