import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTsv } from '../data/tools/sunny-company-expansion.mjs';

test('real Python CSV-quoted TSV output survives the production Node DOL loader', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-tsv-interop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'employers.tsv');
  const py = `import csv,sys\nwith open(sys.argv[1], 'w', newline='') as f:\n w=csv.writer(f, delimiter='\\t',lineterminator='\\n')\n w.writerow(['EMPLOYER_NAME','DBA','transfer_positions','evidence_tier'])\n w.writerow(['o\\tQuad Industries Inc.','',1,'B'])\n w.writerow(['Steed Hammond Paul, Inc. ("SHP")','Line 1\\nLine 2',3,'A'])\n`;
  execFileSync('uv', ['run', '--python', '3.14', 'python', '-c', py, file]);
  const rows = loadTsv(file);
  assert.equal(rows[0].EMPLOYER_NAME, 'o\tQuad Industries Inc.');
  assert.equal(rows[0].transfer_positions, '1');
  assert.equal(rows[0].evidence_tier, 'B');
  assert.equal(rows[1].EMPLOYER_NAME, 'Steed Hammond Paul, Inc. ("SHP")');
  assert.equal(rows[1].DBA, 'Line 1\nLine 2');
});
