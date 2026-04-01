import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { McpConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PLUGIN_ROOT = join(__dirname, '..');
export const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

export const DEFAULT_MCP_CONFIG: McpConfig = {
  mode: 'local',
  token: '',
  local: { http_port: 8921 },
  remote: { http_url: 'http://127.0.0.1:8921' },
};

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
  const fallback: McpConfig = { ...DEFAULT_MCP_CONFIG, local: { ...DEFAULT_MCP_CONFIG.local }, remote: { ...DEFAULT_MCP_CONFIG.remote } };
  if (!p) { _mcpConfig = fallback; return _mcpConfig; }
  let cfg: McpConfig;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    cfg = { ...DEFAULT_MCP_CONFIG, ...raw };
    if (raw.local) cfg.local = { ...DEFAULT_MCP_CONFIG.local, ...raw.local };
    if (raw.remote) cfg.remote = { ...DEFAULT_MCP_CONFIG.remote, ...raw.remote };
  } catch {
    cfg = fallback;
  }
  _applyEnvOverrides(cfg);
  _mcpConfig = cfg;
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
  let result: Record<string, unknown> | null;
  try { result = JSON.parse(readFileSync(p, 'utf-8')); } catch { result = null; }
  _projectConfig = result;
  return result;
}

export function getHttpUrl(): string {
  const mode = getMcpConfig('mode', 'local') as string;
  if (mode === 'remote') return getMcpConfig('remote.http_url', 'http://127.0.0.1:8921') as string;
  const port = getMcpConfig('local.http_port', 8921) as number;
  return `http://127.0.0.1:${port}`;
}
