# opencortex-memory

Persistent long-term memory for AI agents. Works with Claude Code, Codex CLI, Gemini CLI, and any MCP-compatible client.

Store, search, and recall memories across sessions — with reinforcement learning, semantic deduplication, and multi-tenant project isolation.

## Quick Install

### Claude Code

```bash
claude mcp add opencortex -- npx -y opencortex-memory
```

Or install via plugin marketplace:

```bash
/plugin install
# Select opencortex-memory
```

### Codex CLI

```bash
codex mcp add opencortex -- npx -y opencortex-memory
```

### Gemini CLI

```bash
gemini mcp add opencortex -- npx -y opencortex-memory
```

### Manual (any MCP client)

Add to your MCP config file (`~/.claude/mcp.json`, `codex-mcp.json`, etc.):

```json
{
  "mcpServers": {
    "opencortex": {
      "command": "npx",
      "args": ["-y", "opencortex-memory"]
    }
  }
}
```

## Setup

After installing, run the interactive setup wizard:

```bash
npx opencortex-cli setup
```

The wizard walks you through:

1. **Mode** — `local` (self-hosted) or `remote` (connect to a server)
2. **Server URL** — where the backend runs (default: `http://127.0.0.1:8921`)
3. **JWT token** — for authentication (optional in local mode)

## Verify

```bash
npx opencortex-cli health
```

Expected output: server status, version, and connectivity check.

## Configuration

Config is stored at `~/.opencortex/mcp.json`. You can edit it manually:

```json
{
  "mode": "local",
  "token": "",
  "local": { "http_port": 8921, "ui_port": 5920 },
  "remote": { "http_url": "http://your-server:8921" }
}
```

**Config search order:** `./mcp.json` (project-level) > `~/.opencortex/mcp.json` (global).

**Environment overrides:**

| Variable | Description | Default |
|---|---|---|
| `OPENCORTEX_MODE` | `local` or `remote` | `local` |
| `OPENCORTEX_HTTP_URL` | Backend server URL | `http://127.0.0.1:8921` |
| `OPENCORTEX_HTTP_PORT` | Local server port | `8921` |
| `OPENCORTEX_TOKEN` | JWT auth token | — |
| `OPENCORTEX_UI_PORT` | Web UI port | `5920` |

## MCP Tools

| Tool | Description |
|---|---|
| `recall` | Search long-term memory (call before every response) |
| `add_message` | Record a conversation turn (call after every response) |
| `end` | End session and trigger knowledge extraction |
| `store` | Persist a new memory with semantic dedup |
| `batch_store` | Bulk import documents |
| `search` | Natural language memory search |
| `feedback` | Reinforce (+1.0) or penalize (-1.0) a memory |
| `forget` | Delete a memory by URI or query |
| `decay` | Apply time-decay to inactive memories |
| `system_status` | Health check and diagnostics |
| `memory_index` | Lightweight index of all stored memories |

## Included Binaries

| Binary | Description |
|---|---|
| `opencortex-mcp` | MCP stdio server (auto-started by your AI client) |
| `opencortex-cli` | CLI tool — `setup`, `health`, `store`, `recall`, `status`, `feedback`, `decay` |

## Requirements

- Node.js >= 18
- For local mode: Python 3.10+ with `uv` or `pip` (to run the backend server)

## License

MIT
