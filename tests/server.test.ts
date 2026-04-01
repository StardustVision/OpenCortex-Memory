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

  it('02 store', async () => {
    const client = createMcpClient();
    try {
      await client.init();
      const data = await client.callTool('store', { abstract: 'User prefers dark theme', category: 'preferences' });
      assert.ok(data.uri, 'Should return URI');
      assert.equal(data.context_type, 'memory');
      assert.equal(data.category, 'preferences');
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
      assert.ok(commitResult.queued, 'add_message should return queued: true');
      assert.ok(commitResult.turn_id);

      const endResult = await client.callTool('end', {});
      assert.ok(endResult.status);
    } finally { client.close(); }
  });
});
