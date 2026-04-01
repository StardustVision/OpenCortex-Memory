# TypeScript Migration + Module Restructure

## Context

OpenCortex-Memory MCP plugin is currently ~1750 lines of pure JavaScript (.mjs). As the project grows, the lack of type safety makes refactoring risky and the hand-written JSON-RPC transport layer adds unnecessary maintenance burden. This migration converts everything to TypeScript with proper types, replaces the hand-written MCP transport with the official `@modelcontextprotocol/sdk`, and restructures oversized modules for clarity.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Build tool | tsup | Zero-config, esbuild-fast, handles shebang + ESM output |
| Migration scope | All files (lib/ + bin/ + tests/) | One-shot, no mixed JS/TS |
| MCP transport | `@modelcontextprotocol/sdk` | Type-safe, eliminates ~100 lines of hand-written JSON-RPC |
| Directory layout | `src/` + `dist/` | Clean separation of source and build output |
| Migration style | Restructure (not 1:1) | Split oversized modules, remove ui-server |

## Directory Structure

```
src/
  types.ts              # Shared type definitions
  config.ts             # Config discovery, defaults, env overrides (from common.mjs)
  project.ts            # Project detection, python/uv, local HTTP startup (from common.mjs)
  http-client.ts        # HTTP client with undici connection pooling
  server.ts             # MCP server entry point (uses SDK)
  tools.ts              # Tool definitions, schemas, HTTP proxy
  lifecycle.ts          # recall/add_message/end + fire-and-forget write queue
  setup.ts              # Interactive setup wizard
  transcript.ts         # JSONL transcript utilities
  cli.ts                # CLI entry point (bin/oc-cli.mjs)
  scan.ts               # File scanner (bin/oc-scan.mjs)
tests/
  server.test.ts        # Integration tests
dist/                   # tsup build output (.mjs)
```

## Module Breakdown

### `types.ts` — Shared Interfaces

```typescript
export interface McpConfig {
  mode: 'local' | 'remote';
  token: string;
  local: { http_port: number };
  remote: { http_url: string };
}

export interface ToolParam {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolDef {
  method: 'GET' | 'POST' | null;
  path: string | null;
  description: string;
  params: Record<string, ToolParam>;
}

export interface SessionState {
  httpUrl: string | null;
  sessionId: string | null;
  turnCounter: number;
  lastRecallTurnId: string | null;
  httpPid: number;
  initialized: boolean;
  shuttingDown: boolean;
}

export interface ContextRequest {
  session_id: string;
  phase: 'prepare' | 'commit' | 'end';
  turn_id?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tool_calls?: Array<{ name: string; summary: string }>;
  cited_uris?: string[];
  config?: Record<string, unknown>;
}

export interface Turn {
  turnUuid: string;
  userText: string;
  assistantText: string;
  toolUses: string[];
}
```

### `config.ts` — Configuration (from common.mjs, ~200 lines)

**Exports:**
- `readStdin()`, `output()`
- `findMcpConfig()` — 5-level fallback chain
- `ensureDefaultConfig()`, `writeMcpConfig()`, `getMcpConfig()`
- `getPluginConfig()`, `getPluginMode()`, `getConfigPath()`
- `getProjectConfig()`, `getHttpUrl()`, `getUiPort()`
- Constants: `PLUGIN_ROOT`, `PROJECT_DIR`, `DEFAULT_MCP_CONFIG`

### `project.ts` — Project & Server (from common.mjs, ~160 lines)

**Exports:**
- `detectProjectId()`, `getProjectId()` — git-based project ID
- `findUv()`, `findPython()` — Python environment discovery
- `startLocalHttpServer()` — spawn + poll (10s)
- `ensureStateDir()`, `loadState()`, `saveState()` — state persistence
- `buildContext()` — context object builder
- Constants: `STATE_DIR`, `STATE_FILE`

### `tools.ts` — Tool Definitions & Proxy (from mcp-server.mjs, ~150 lines)

**Exports:**
- `TOOLS: Record<string, ToolDef>` — 11 tool definitions
- `FIRE_AND_FORGET_PROXY: Set<string>` — `{'store', 'batch_store', 'feedback', 'decay'}`
- `callProxyTool(name, args, httpUrl)` — HTTP proxy with defaults + timeout

### `lifecycle.ts` — Session Lifecycle (from mcp-server.mjs, ~120 lines)

**Exports:**
- `handleRecall(args, state)` — prepare phase
- `handleAddMessage(args, state)` — commit phase (fire-and-forget)
- `handleEnd(state)` — end phase
- `httpContextCall(body, httpUrl)` — context API + graceful degradation
- `fireAndForget(asyncFn, label)` — async write queue
- `flushPendingWrites(timeoutMs?)` — drain queue (for shutdown)

### `server.ts` — MCP Entry Point (~80 lines)

Replaces hand-written JSON-RPC with `@modelcontextprotocol/sdk`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Create server
const server = new McpServer({ name: 'opencortex', version: PKG_VERSION });

// Register tools via SDK API
server.tool('recall', RECALL_SCHEMA, handleRecall);
server.tool('add_message', ADD_MSG_SCHEMA, handleAddMessage);
server.tool('store', STORE_SCHEMA, (args) => proxyOrFireForget('store', args));
// ... other tools

// Register prompts
server.prompt('usage-guide', getUsageGuidePrompt);

// Connect
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Eliminated code:** `send()`, `jsonrpcResult()`, `jsonrpcError()`, `handleMessage()`, stdin buffer parsing loop (~100 lines).

**Lifecycle:** `initSession()` and `shutdown()` remain, called on server connect/disconnect events.

### Unchanged Modules (1:1 migration, add types only)

- `http-client.ts` (69 lines) — add types to `buildClientHeaders`, `httpPost`, `httpGet`, `healthCheck`
- `setup.ts` (148 lines) — add types to readline helpers
- `transcript.ts` (114 lines) — add `Turn` type, type helper functions
- `cli.ts` (206 lines) — add types to arg parsing and command dispatch
- `scan.ts` (122 lines) — add types to file discovery and output

## Removed

- **`ui-server.ts`** — entire module removed, web console management moves to server-side
- **`startUiServer()`/`stopUiServer()` calls** in server.ts init/shutdown

## Build Pipeline

### tsup.config.ts

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/cli.ts', 'src/scan.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node18',
  splitting: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
```

### tsconfig.json

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
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### package.json Changes

```jsonc
{
  "bin": {
    "opencortex-memory": "dist/server.mjs",
    "opencortex-mcp": "dist/server.mjs",
    "opencortex-cli": "dist/cli.mjs"
  },
  "files": ["dist", "skills", "gemini-extension.json", "README.md"],
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
    "typescript": "^5.8",
    "tsup": "^8",
    "tsx": "^4",
    "@types/node": "^22"
  }
}
```

## File Mapping

| Old File | New File(s) | Notes |
|----------|-------------|-------|
| lib/common.mjs | src/config.ts + src/project.ts | Split by responsibility |
| lib/http-client.mjs | src/http-client.ts | 1:1, add types |
| lib/mcp-server.mjs | src/server.ts + src/tools.ts + src/lifecycle.ts | Split + SDK replaces JSON-RPC |
| lib/setup.mjs | src/setup.ts | 1:1, add types |
| lib/transcript.mjs | src/transcript.ts | 1:1, add types |
| lib/ui-server.mjs | (removed) | Web console removed |
| bin/oc-cli.mjs | src/cli.ts | Move to src/, add types |
| bin/oc-scan.mjs | src/scan.ts | Move to src/, add types |
| tests/test_mcp_server.mjs | tests/server.test.ts | Add types |

## Verification

1. **Type check:** `npm run check` (tsc --noEmit) passes with zero errors
2. **Build:** `npm run build` produces dist/server.mjs, dist/cli.mjs, dist/scan.mjs
3. **MCP server:** `node dist/server.mjs` starts, responds to `initialize` JSON-RPC
4. **Integration tests:** `npm test` (tsx --test tests/server.test.ts) — all 9 existing test cases pass
5. **CLI:** `node dist/cli.mjs health` returns server status
6. **npx:** `npx opencortex-memory` works (shebang present in dist output)
7. **Fire-and-forget:** `add_message`, `store`, `feedback`, `decay` return immediately without blocking
