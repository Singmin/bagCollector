import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const [beforePath, afterPath, output = 'learning-comparison.json'] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node scripts/compare-learning-retrieval.mjs before.report.json after.report.json [output.json]');
const before = JSON.parse(await readFile(beforePath, 'utf8')); const after = JSON.parse(await readFile(afterPath, 'utf8'));
assert.equal(before.model, after.model, 'model must be identical');
assert.deepEqual(before.settings, after.settings, 'keep thresholds and weights fixed');
const original = new Map(before.rows.filter(r => r.split === 'acceptance').map(r => [r.sha256, r]));
const updated = after.rows.filter(r => r.split === 'acceptance');
assert.equal(updated.length, original.size, 'use the same acceptance photos');
for (const row of updated) {
  const prior = original.get(row.sha256);
  assert.ok(prior && prior.bagId === row.bagId && prior.batch === row.batch, 'labels/capture batches must match');
  assert.ok(prior.independentCapture && row.independentCapture, 'contributed references cannot substitute for independent captures');
}
const known = updated.filter(r => r.bagId); const outside = updated.filter(r => !r.bagId);
const gained = known.filter(r => !original.get(r.sha256).hit && r.hit).length;
const lost = known.filter(r => original.get(r.sha256).hit && !r.hit).length;
const ratio = (rows, predicate) => rows.length ? rows.filter(predicate).length / rows.length : null;
const report = { createdAt: new Date().toISOString(), model: before.model, settings: before.settings, known: known.length, outside: outside.length,
  recallAt5Before: ratio(known, r => original.get(r.sha256).hit), recallAt5After: ratio(known, r => r.hit), gained, lost,
  outsideCandidateRateBefore: ratio(outside, r => original.get(r.sha256).candidates.length > 0), outsideCandidateRateAfter: ratio(outside, r => r.candidates.length > 0),
  sampleGate: before.sampleGate && after.sampleGate, targetReached: before.sampleGate && after.sampleGate && ratio(known, r => r.hit) >= .9,
  limitation: 'Independent capture is declared by dataset owner. Hash leakage checks run in scan:benchmark. Resource and full scan latency must be measured on the production server.' };
await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
