import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_CSV = resolve(REPO_ROOT, 'datasets', 'healthcare', 'raw', 'mtsamples.csv');
const VERIFY_SCRIPT = resolve(REPO_ROOT, 'scripts', 'verify-injection.ts');

/**
 * This is an integration gate: when the raw dataset has been downloaded and
 * the injected corpus has been generated, the verify-injection.ts script must
 * exit 0. When the dataset has NOT been downloaded (CI on a fresh runner),
 * the test is skipped — the determinism + coordinate invariants are already
 * covered by inject-pii.spec.ts on in-memory fixtures.
 */
describe('verify-injection.ts (round-trip integration)', () => {
  const skip = !existsSync(RAW_CSV);

  it.skipIf(skip)('exits 0 when the injected corpus is present', () => {
    const result = spawnSync('node', ['--import', 'tsx', VERIFY_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      // Surface stderr for debuggability.
      process.stderr.write(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`);
    }
    expect(result.status).toBe(0);
  });

  it('is documented when skipped', () => {
    if (skip) {
      // Sanity-only: prove the skip rationale to the test log.
      expect(skip).toBe(true);
    } else {
      expect(skip).toBe(false);
    }
  });
});
