import { readFileSync, writeFileSync, mkdirSync, accessSync, constants, openSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { PROJECT_DIR, getMcpConfig, getConfigPath, getPluginMode, getHttpUrl, PLUGIN_ROOT } from './config.js';

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
