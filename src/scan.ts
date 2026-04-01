import { execSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import type { ScanItem, ScanOutput } from './types.js';

const MAX_FILE_SIZE = 1024 * 1024;

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

// ── Main ──────────────────────────────────────────────────────────────

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scan.mjs <directory>');
  process.exit(1);
}

const { hasGit, projectId } = detectGit(targetDir);
const files = discoverFiles(targetDir).filter(f => {
  const ext = extname(f).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return false;
  try { return statSync(f).size <= MAX_FILE_SIZE; } catch { return false; }
});

const items: ScanItem[] = [];
for (const f of files) {
  const relPath = relative(targetDir, f);
  const ext = extname(f).toLowerCase();
  let content: string;
  try { content = readFileSync(f, 'utf-8'); } catch (err) {
    process.stderr.write(`[oc-scan] skipping ${relPath}: ${(err as Error).message}\n`);
    continue;
  }
  items.push({
    abstract: relPath, content, category: 'documents', context_type: 'resource',
    meta: { source: 'scan', file_path: relPath, file_type: fileType(ext) },
  });
}

const output: ScanOutput = {
  items, source_path: targetDir,
  scan_meta: { total_files: items.length, has_git: hasGit, project_id: projectId },
};

console.log(JSON.stringify(output));
