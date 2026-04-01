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

  // Connect stdio transport
  const transport = new StdioServerTransport();
  transport.onclose = () => { shutdown(); };
  await server.connect(transport);
}

main();
