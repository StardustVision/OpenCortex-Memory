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
  scan_meta: {
    total_files: number;
    discovered_files?: number;
    total_bytes?: number;
    skipped_files?: number;
    skipped_bytes?: number;
    skipped_too_large?: number;
    skipped_unsupported?: number;
    skipped_read_errors?: number;
    truncated?: boolean;
    max_files?: number;
    max_total_bytes?: number;
    has_git: boolean;
    project_id: string;
  };
}
