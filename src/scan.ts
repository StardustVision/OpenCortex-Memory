import { execSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScanItem, ScanOutput } from './types.js';

const MAX_FILE_SIZE = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const SUPPORTED_EXTS = new Set([
  '.md', '.mdx',
  '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.sh', '.yaml', '.yml', '.toml', '.json',
  '.css', '.html', '.txt', '.rst',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '.claude',
]);

function detectGit(dir: string): { hasGit: boolean; projectId: string } {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8',
    }).trim();
    return { hasGit: true, projectId: basename(toplevel) };
  } catch {
    return { hasGit: false, projectId: 'public' };
  }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function discoverFiles(dir: string): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    });
    return output.trim().split(/\r?\n/).filter(Boolean).map(f => join(dir, f));
  } catch {
    return walkDir(dir);
  }
}

function fileType(ext: string): string {
  if (['.md', '.mdx'].includes(ext)) return 'markdown';
  if (['.txt', '.rst'].includes(ext)) return 'text';
  return 'code';
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ScanLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
}

export function scanDirectory(targetDir: string, limits: ScanLimits = {}): ScanOutput {
  const maxFiles = limits.maxFiles ?? envInt('OPENCORTEX_SCAN_MAX_FILES', DEFAULT_MAX_FILES);
  const maxTotalBytes = limits.maxTotalBytes
    ?? envInt('OPENCORTEX_SCAN_MAX_TOTAL_BYTES', DEFAULT_MAX_TOTAL_BYTES);
  const { hasGit, projectId } = detectGit(targetDir);
  const discovered = discoverFiles(targetDir);

  const items: ScanItem[] = [];
  let totalBytes = 0;
  let skippedFiles = 0;
  let skippedBytes = 0;
  let skippedTooLarge = 0;
  let skippedUnsupported = 0;
  let skippedReadErrors = 0;

  for (const f of discovered) {
    const ext = extname(f).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      skippedUnsupported += 1;
      continue;
    }

    let size: number;
    try { size = statSync(f).size; } catch {
      skippedReadErrors += 1;
      continue;
    }
    if (size > MAX_FILE_SIZE) {
      skippedTooLarge += 1;
      continue;
    }
    if (items.length >= maxFiles || totalBytes + size > maxTotalBytes) {
      skippedFiles += 1;
      skippedBytes += size;
      continue;
    }

    const relPath = relative(targetDir, f);
    let content: string;
    try { content = readFileSync(f, 'utf-8'); } catch (err) {
      skippedReadErrors += 1;
      process.stderr.write(`[oc-scan] skipping ${relPath}: ${(err as Error).message}\n`);
      continue;
    }
    totalBytes += size;
    items.push({
      abstract: relPath, content, category: 'documents', context_type: 'resource',
      meta: { source: 'scan', file_path: relPath, file_type: fileType(ext) },
    });
  }

  return {
    items, source_path: targetDir,
    scan_meta: {
      total_files: items.length,
      discovered_files: discovered.length,
      total_bytes: totalBytes,
      skipped_files: skippedFiles,
      skipped_bytes: skippedBytes,
      skipped_too_large: skippedTooLarge,
      skipped_unsupported: skippedUnsupported,
      skipped_read_errors: skippedReadErrors,
      truncated: skippedFiles > 0,
      max_files: maxFiles,
      max_total_bytes: maxTotalBytes,
      has_git: hasGit,
      project_id: projectId,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const targetDir = process.argv[2];
  if (!targetDir) {
    console.error('Usage: node scan.mjs <directory>');
    process.exit(1);
  }
  console.log(JSON.stringify(scanDirectory(targetDir)));
}
