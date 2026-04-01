# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all HIGH-priority and selected MEDIUM-priority issues found in the code review.

**Architecture:** Targeted surgical fixes across 5 source files and the test suite. No refactoring or structural changes — each fix is self-contained and does not affect adjacent code.

**Tech Stack:** Node.js ESM, `node:child_process`, `undici`

---

## File Map

| File | Changes |
|------|---------|
| `package.json` | Add `undici` to `dependencies` |
| `lib/http-client.mjs` | Fix `healthCheck` to check `res.ok` |
| `lib/setup.mjs` | Fix shell injection — switch to `execFileSync` with arg array |
| `lib/mcp-server.mjs` | Fix: version hardcoding, `_httpUrl` race, double shutdown |
| `lib/common.mjs` | Fix: `parseInt` NaN for port env var, `logFd` leak after `spawn` |
| `bin/oc-scan.mjs` | Fix: add `abstract` field, wrap `readFileSync` in try/catch, fix `\r\n` on Windows |
| `tests/test_mcp_server.mjs` | Fix: version assertion, tool count assertion |

---

### Task 1: Declare `undici` in package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dependency**

Open `package.json`. Add a `dependencies` section:

```json
  "dependencies": {
    "undici": ">=5"
  },
```

The full updated `package.json` (relevant diff — insert after `"engines"` block):

```json
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "undici": ">=5"
  },
  "scripts": {
```

- [ ] **Step 2: Verify install**

```bash
npm install
node -e "import('undici').then(() => console.log('OK'))"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "fix: declare undici as explicit dependency in package.json"
```

---

### Task 2: Fix `healthCheck` — check `res.ok`

**Files:**
- Modify: `lib/http-client.mjs:60-69`

**Problem:** `fetch` only throws on network error; a `500` response returns `true`, giving false "server is healthy" signal.

- [ ] **Step 1: Update `healthCheck`**

Replace lines 60–69 in `lib/http-client.mjs`:

```js
export async function healthCheck(httpUrl, timeoutMs = 3000) {
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

- [ ] **Step 2: Verify change compiles**

```bash
node --check lib/http-client.mjs
```

Expected: no output (no errors)

- [ ] **Step 3: Commit**

```bash
git add lib/http-client.mjs
git commit -m "fix: healthCheck now checks res.ok to avoid false positives on 5xx"
```

---

### Task 3: Fix shell injection in `lib/setup.mjs`

**Files:**
- Modify: `lib/setup.mjs:12` (add `execFileSync` import)
- Modify: `lib/setup.mjs:97-116` (replace `execSync` with `execFileSync`)

**Problem:** Token and other values are interpolated directly into a shell command string passed to `execSync`. A token containing `$()`, backticks, `;`, or spaces would break or inject commands.

- [ ] **Step 1: Update import**

In `lib/setup.mjs`, change line 12:

```js
import { execSync } from 'node:child_process';
```

to:

```js
import { execFileSync } from 'node:child_process';
```

- [ ] **Step 2: Replace the shell command with an argument array**

Replace lines 97–117 (the `if (registerClaude === 'yes')` block) with:

```js
    if (registerClaude === 'yes') {
      try {
        // Build argument list — no shell interpolation, safe for tokens with special chars
        const cmdArgs = [
          'mcp', 'add', '-s', 'user', 'opencortex',
          '-e', `OPENCORTEX_MODE=${mode}`,
        ];
        if (config.token) {
          cmdArgs.push('-e', `OPENCORTEX_TOKEN=${config.token}`);
        }
        if (mode === 'remote' && config.remote?.http_url) {
          cmdArgs.push('-e', `OPENCORTEX_HTTP_URL=${config.remote.http_url}`);
        }
        if (mode === 'local' && config.local?.http_port) {
          cmdArgs.push('-e', `OPENCORTEX_HTTP_PORT=${config.local.http_port}`);
        }
        cmdArgs.push('--', 'node', MCP_SERVER_PATH);

        console.log(`\nRunning: claude ${cmdArgs.join(' ')}`);
        execFileSync('claude', cmdArgs, { stdio: 'inherit' });
        console.log('Registered successfully.');
      } catch {
        console.log('Failed to register. You can run the command manually later.');
      }
    }
```

- [ ] **Step 3: Verify no syntax errors**

```bash
node --check lib/setup.mjs
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
git add lib/setup.mjs
git commit -m "fix: replace shell string interpolation in setup with execFileSync arg array (prevents shell injection)"
```

---

### Task 4: Fix `_httpUrl` race condition in `lib/mcp-server.mjs`

**Files:**
- Modify: `lib/mcp-server.mjs:139-171` (`callProxyTool`)
- Modify: `lib/mcp-server.mjs:223-254` (`httpContextCall`)

**Problem:** `initSession()` is async and can take up to ~10s. Any `tools/call` that arrives before it resolves will use `_httpUrl = null`, producing `fetch('null/api/v1/...')` which throws an opaque network error.

- [ ] **Step 1: Add guard in `callProxyTool`**

At the top of `callProxyTool` (after the `const def = TOOLS[name]` line, around line 141), add:

```js
async function callProxyTool(name, args) {
  const def = TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  if (!_httpUrl) throw new Error('Memory server not ready yet — please retry in a moment');
  const [method, path] = def;
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check lib/mcp-server.mjs
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add lib/mcp-server.mjs
git commit -m "fix: guard callProxyTool against null _httpUrl during async initSession race"
```

---

### Task 5: Fix double shutdown in `lib/mcp-server.mjs`

**Files:**
- Modify: `lib/mcp-server.mjs` (add `_shuttingDown` flag)

**Problem:** When the MCP host closes stdin, both `main()` falls through to `await shutdown()` AND a SIGTERM/SIGINT handler may fire, calling `shutdown()` a second time and sending a duplicate `phase: 'end'` to the server.

- [ ] **Step 1: Add `_shuttingDown` guard**

After the existing module-level state declarations (around line 21), add:

```js
let _shuttingDown = false;
```

Then wrap the `shutdown` function body:

```js
async function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const _log = (msg) => process.stderr.write(`[opencortex-mcp] ${msg}\n`);
  // ... rest of existing shutdown body unchanged ...
}
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check lib/mcp-server.mjs
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add lib/mcp-server.mjs
git commit -m "fix: prevent double shutdown() call on SIGTERM + stdin close"
```

---

### Task 6: Fix hardcoded version in `lib/mcp-server.mjs`

**Files:**
- Modify: `lib/mcp-server.mjs:1-14` (imports)
- Modify: `lib/mcp-server.mjs:472` (serverInfo)

**Problem:** `serverInfo.version` is hardcoded `'0.6.2'` but `package.json` is `0.6.4`. Will silently diverge on every release.

- [ ] **Step 1: Import `createRequire` and read version**

At the top of `lib/mcp-server.mjs`, add after the existing import line:

```js
import { join } from 'node:path';
import { createRequire } from 'node:module';
```

Note: `join` is already imported. Only add `createRequire`. Then below the imports, add:

```js
const _require = createRequire(import.meta.url);
const _PKG_VERSION = _require('../package.json').version;
```

- [ ] **Step 2: Use `_PKG_VERSION` in `initialize` response**

Find line 472:
```js
        serverInfo: { name: 'opencortex', version: '0.6.2' },
```

Replace with:
```js
        serverInfo: { name: 'opencortex', version: _PKG_VERSION },
```

- [ ] **Step 3: Verify**

```bash
node --check lib/mcp-server.mjs
node -e "
import('./lib/mcp-server.mjs').catch(() => {}); // just check module parse
" 2>/dev/null; echo "parse ok"
```

Expected: `parse ok` (the server will try to start, which is fine — we just need it to not crash on import)

- [ ] **Step 4: Commit**

```bash
git add lib/mcp-server.mjs
git commit -m "fix: read server version from package.json instead of hardcoding it"
```

---

### Task 7: Fix `parseInt` NaN for `OPENCORTEX_HTTP_PORT` in `lib/common.mjs`

**Files:**
- Modify: `lib/common.mjs:148-154` (`_applyEnvOverrides`)
- Modify: `lib/common.mjs:196-198` (`getUiPort`)
- Modify: `lib/setup.mjs:68` (port input parsing)

**Problem:** `parseInt('abc', 10)` returns `NaN`, producing `http://127.0.0.1:NaN` URLs with opaque network errors. Also `parseInt(port, 10) || 8921` treats port `0` as invalid and silently swallows non-numeric input.

- [ ] **Step 1: Fix `_applyEnvOverrides` in `lib/common.mjs`**

Replace line 152:
```js
  if (env.OPENCORTEX_HTTP_PORT) cfg.local.http_port = parseInt(env.OPENCORTEX_HTTP_PORT, 10);
```

With:
```js
  if (env.OPENCORTEX_HTTP_PORT) {
    const p = parseInt(env.OPENCORTEX_HTTP_PORT, 10);
    if (Number.isFinite(p)) cfg.local.http_port = p;
    else process.stderr.write(`[opencortex] OPENCORTEX_HTTP_PORT is not a valid integer: "${env.OPENCORTEX_HTTP_PORT}"\n`);
  }
```

- [ ] **Step 2: Fix `getUiPort` in `lib/common.mjs`**

Replace line 197:
```js
  return parseInt(process.env.OPENCORTEX_UI_PORT || getMcpConfig('local.ui_port', 5920), 10);
```

With:
```js
  const raw = process.env.OPENCORTEX_UI_PORT;
  if (raw) {
    const p = parseInt(raw, 10);
    if (Number.isFinite(p)) return p;
    process.stderr.write(`[opencortex] OPENCORTEX_UI_PORT is not a valid integer: "${raw}"\n`);
  }
  return getMcpConfig('local.ui_port', 5920);
```

- [ ] **Step 3: Fix port input in `lib/setup.mjs`**

Replace line 68:
```js
      if (port) config.local = { http_port: parseInt(port, 10) || 8921 };
```

With:
```js
      if (port) {
        const parsed = parseInt(port, 10);
        config.local = { http_port: Number.isFinite(parsed) ? parsed : DEFAULT_MCP_CONFIG.local.http_port };
        if (!Number.isFinite(parsed)) console.log(`Invalid port "${port}", using default ${DEFAULT_MCP_CONFIG.local.http_port}`);
      }
```

- [ ] **Step 4: Verify no syntax errors**

```bash
node --check lib/common.mjs && node --check lib/setup.mjs
```

Expected: no output

- [ ] **Step 5: Commit**

```bash
git add lib/common.mjs lib/setup.mjs
git commit -m "fix: validate parseInt results for port env vars to avoid NaN URLs"
```

---

### Task 8: Fix `logFd` leak in `lib/common.mjs`

**Files:**
- Modify: `lib/common.mjs:322-335` (`startLocalHttpServer`)

**Problem:** `openSync(logPath, 'a')` gives the parent process an open file descriptor that is never closed. The child inherits a copy, so the parent can close its FD immediately after `spawn`.

- [ ] **Step 1: Close `logFd` after `spawn`**

Find the `spawn` call in `startLocalHttpServer` (~line 330) and add `closeSync` after it.

First, add `closeSync` to the existing import at the top of `lib/common.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants, openSync, closeSync } from 'node:fs';
```

Then, after the `child.unref()` line (~line 336), add:

```js
  child.unref();
  // Parent can close its copy of the fd — child already inherited it
  try { closeSync(logFd); } catch { /* ignore if already closed */ }
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check lib/common.mjs
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add lib/common.mjs
git commit -m "fix: close logFd in parent process after spawn to prevent fd leak"
```

---

### Task 9: Fix `bin/oc-scan.mjs` — three issues

**Files:**
- Modify: `bin/oc-scan.mjs:45` (Windows `\r\n`)
- Modify: `bin/oc-scan.mjs:88-102` (add `abstract` field)
- Modify: `bin/oc-scan.mjs:88-102` (wrap `readFileSync` in try/catch)

- [ ] **Step 1: Fix Windows `\r\n` in `discoverFiles`**

Replace line 46:
```js
    return output.trim().split('\n').filter(Boolean).map(f => join(dir, f));
```

With:
```js
    return output.trim().split(/\r?\n/).filter(Boolean).map(f => join(dir, f));
```

- [ ] **Step 2: Add `abstract` and wrap `readFileSync` in `items` map**

Replace lines 88–102:
```js
const items = files.map(f => {
  const relPath = relative(targetDir, f);
  const ext = extname(f).toLowerCase();
  const content = readFileSync(f, 'utf-8');
  return {
    content,
    category: 'documents',
    context_type: 'resource',
    meta: {
      source: 'scan',
      file_path: relPath,
      file_type: fileType(ext),
    },
  };
});
```

With:
```js
const items = [];
for (const f of files) {
  const relPath = relative(targetDir, f);
  const ext = extname(f).toLowerCase();
  let content;
  try {
    content = readFileSync(f, 'utf-8');
  } catch (err) {
    process.stderr.write(`[oc-scan] skipping ${relPath}: ${err.message}\n`);
    continue;
  }
  items.push({
    abstract: relPath,
    content,
    category: 'documents',
    context_type: 'resource',
    meta: {
      source: 'scan',
      file_path: relPath,
      file_type: fileType(ext),
    },
  });
}
```

- [ ] **Step 3: Verify no syntax errors**

```bash
node --check bin/oc-scan.mjs
```

Expected: no output

- [ ] **Step 4: Quick smoke test**

```bash
node bin/oc-scan.mjs . 2>/dev/null | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('items:', d.items.length);
console.log('has abstract:', d.items.every(i => typeof i.abstract === 'string' && i.abstract.length > 0));
"
```

Expected output:
```
items: <N>
has abstract: true
```

- [ ] **Step 5: Commit**

```bash
git add bin/oc-scan.mjs
git commit -m "fix: oc-scan — add required abstract field, guard readFileSync, fix Windows CRLF split"
```

---

### Task 10: Fix test assertions in `tests/test_mcp_server.mjs`

**Files:**
- Modify: `tests/test_mcp_server.mjs:136` (version assertion)
- Modify: `tests/test_mcp_server.mjs:147` (tool count assertion)

**Problem:** Version asserts `'0.5.0'` (server returns value from `package.json` which is `0.6.4`). Tool count asserts `9` but there are currently 11 tools: `store`, `batch_store`, `search`, `feedback`, `forget`, `decay`, `system_status`, `memory_index`, `recall`, `add_message`, `end`.

- [ ] **Step 1: Fix version assertion — read from package.json**

At the top of `tests/test_mcp_server.mjs` (after the existing imports), add:

```js
const PKG = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
```

Note: `readFileSync` and `join` are already imported. Then replace line 136:

```js
      assert.equal(initRes.result.serverInfo.version, '0.5.0');
```

With:

```js
      assert.equal(initRes.result.serverInfo.version, PKG.version);
```

- [ ] **Step 2: Fix tool count and missing tools in the assertion**

Replace lines 139–147:

```js
      const toolsRes = await client.request('tools/list');
      const names = toolsRes.result.tools.map(t => t.name);
      for (const expected of [
        'store', 'batch_store', 'search', 'feedback', 'decay',
        'system_status',
        'recall', 'add_message', 'end',
      ]) {
        assert.ok(names.includes(expected), `Missing tool: ${expected}`);
      }
      assert.equal(names.length, 9, `Expected 9 tools, got ${names.length}: ${names.join(', ')}`);
```

With:

```js
      const toolsRes = await client.request('tools/list');
      const names = toolsRes.result.tools.map(t => t.name);
      const EXPECTED_TOOLS = [
        'store', 'batch_store', 'search', 'feedback', 'forget', 'decay',
        'system_status', 'memory_index',
        'recall', 'add_message', 'end',
      ];
      for (const expected of EXPECTED_TOOLS) {
        assert.ok(names.includes(expected), `Missing tool: ${expected}`);
      }
      assert.equal(names.length, EXPECTED_TOOLS.length, `Expected ${EXPECTED_TOOLS.length} tools, got ${names.length}: ${names.join(', ')}`);
```

- [ ] **Step 3: Verify no syntax errors**

```bash
node --check tests/test_mcp_server.mjs
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
git add tests/test_mcp_server.mjs
git commit -m "fix: update test assertions to match current server version and tool count (was 0.5.0/9, now reads from package.json/11)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Task 1 — `undici` declared in `package.json`
- ✅ Task 2 — `healthCheck` checks `res.ok`
- ✅ Task 3 — shell injection in `setup.mjs` → `execFileSync`
- ✅ Task 4 — `_httpUrl` null guard in `callProxyTool`
- ✅ Task 5 — double shutdown guard
- ✅ Task 6 — version from `package.json`
- ✅ Task 7 — `parseInt` NaN for port env vars
- ✅ Task 8 — `logFd` closed after spawn
- ✅ Task 9 — `oc-scan` three fixes
- ✅ Task 10 — test assertions updated

**Deferred (MEDIUM/LOW, lower risk):**
- Token in UI URL query string (cosmetic logging concern)
- `setGlobalDispatcher` side effect (works correctly, cosmetic)
- `_projectConfig` stale cache (legacy function, low usage)
- `unhandledRejection` handler (hardening, not a bug)

**Placeholder scan:** No TBD, TODO, or incomplete steps found.

**Type consistency:** No cross-task type references. All edits are independent.
