import { readFileSync } from 'node:fs';
import type { TranscriptMessage, ContentBlock, Turn } from './types.js';

export function readJsonl(path: string): unknown[] {
  const lines = readFileSync(path, 'utf-8').split('\n');
  const rows: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return rows;
}

function short(s: string, maxLen: number): string {
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

export function extractTextParts(message: TranscriptMessage | null): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as ContentBlock[])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
}

export function extractToolUses(message: TranscriptMessage | null): string[] {
  if (!message || !Array.isArray(message.content)) return [];
  return (message.content as ContentBlock[])
    .filter(b => b.type === 'tool_use')
    .map(b => {
      const name = b.name || 'unknown';
      const input = b.input ? short(JSON.stringify(b.input), 120) : '';
      return `[tool-use] ${name}(${input})`;
    });
}

export function isToolResult(message: TranscriptMessage | null): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some(b => b.type === 'tool_result');
}

export function extractLastTurn(transcriptPath: string): Turn | null {
  const rows = readJsonl(transcriptPath) as TranscriptMessage[];
  if (!rows.length) return null;

  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = rows[i];
    if (msg.role === 'user' && !isToolResult(msg)) {
      const text = extractTextParts(msg);
      if (text.trim()) { lastUserIdx = i; break; }
    }
  }
  if (lastUserIdx < 0) return null;

  const userMsg = rows[lastUserIdx];
  const userText = extractTextParts(userMsg);
  const turnUuid = userMsg.uuid || userMsg.id || `turn-${lastUserIdx}`;

  const assistantParts: string[] = [];
  const toolUses: string[] = [];
  for (let i = lastUserIdx + 1; i < rows.length; i++) {
    const msg = rows[i];
    if (msg.role === 'user') break;
    if (msg.role === 'assistant') {
      const text = extractTextParts(msg);
      if (text) assistantParts.push(text);
      toolUses.push(...extractToolUses(msg));
    }
  }

  return { turnUuid, userText, assistantText: assistantParts.join('\n'), toolUses };
}

export function summarizeTurn(turn: Turn | null): string {
  if (!turn) return '';
  const lines: string[] = [];
  if (turn.userText) lines.push(`User: ${short(turn.userText, 200)}`);
  if (turn.toolUses?.length) {
    lines.push('Actions:');
    for (const tu of turn.toolUses.slice(0, 8)) lines.push(`  - ${tu}`);
    if (turn.toolUses.length > 8) lines.push(`  - ... and ${turn.toolUses.length - 8} more`);
  }
  if (turn.assistantText) lines.push(`Assistant: ${short(turn.assistantText, 300)}`);
  return lines.join('\n');
}
