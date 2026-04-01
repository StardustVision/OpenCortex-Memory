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
