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
