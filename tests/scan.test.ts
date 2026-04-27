import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanDirectory } from '../src/scan.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'oc-scan-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scanDirectory limits', () => {
  it('stops after maxFiles and reports truncation metadata', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.md'), 'a');
      writeFileSync(join(dir, 'b.md'), 'b');
      writeFileSync(join(dir, 'c.md'), 'c');

      const output = scanDirectory(dir, { maxFiles: 2, maxTotalBytes: 100 });

      assert.equal(output.items.length, 2);
      assert.equal(output.scan_meta.total_files, 2);
      assert.equal(output.scan_meta.discovered_files, 3);
      assert.equal(output.scan_meta.skipped_files, 1);
      assert.equal(output.scan_meta.truncated, true);
      assert.equal(output.scan_meta.max_files, 2);
    });
  });

  it('stops before maxTotalBytes and does not read more file content', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.md'), '12345');
      writeFileSync(join(dir, 'b.md'), '67890');

      const output = scanDirectory(dir, { maxFiles: 10, maxTotalBytes: 5 });

      assert.equal(output.items.length, 1);
      assert.equal(output.scan_meta.total_bytes, 5);
      assert.equal(output.scan_meta.skipped_files, 1);
      assert.equal(output.scan_meta.skipped_bytes, 5);
      assert.equal(output.scan_meta.truncated, true);
    });
  });
});
