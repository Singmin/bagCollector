// Offline reproducible retrieval evaluation. No cloud matting calls or database writes.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SCAN_SETTINGS, DINO_SCAN_MODEL, COLOR_SCAN_MODEL, extractScanFeature, cropScanImage, rankScanCandidates, scanCandidates } from '../packages/bag-vision/dist/index.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: pnpm scan:benchmark <dataset.json> [report.json]; set VISION_SERVICE_URL for DINO');
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const root = dirname(resolve(inputPath));
const settings = { ...DEFAULT_SCAN_SETTINGS, engine: 'dino', ...input.settings, candidateLimit: 5 };
const model = settings.engine === 'dino' ? DINO_SCAN_MODEL : COLOR_SCAN_MODEL;
const hashes = new Map(); const batches = new Map(); const referenceIds = new Set();
async function load(path, identity) {
  const body = await readFile(resolve(root, path));
  const hash = createHash('sha256').update(body).digest('hex');
  if (hashes.has(hash)) throw new Error(`Duplicate image/leakage: ${identity} and ${hashes.get(hash)}`);
  hashes.set(hash, identity); return { body, hash };
}
const entries = [];
for (const reference of input.references) {
  referenceIds.add(reference.bagId);
  const { body } = await load(reference.path, `reference:${reference.path}`);
  entries.push({ officialBagId: reference.bagId, ...await extractScanFeature(body, settings.engine, process.env.VISION_SERVICE_URL) });
}
const rows = [];
for (const sample of input.samples) {
  if (!['calibration', 'acceptance'].includes(sample.split) || !sample.batch) throw new Error('Each sample needs split and independent capture batch');
  const priorSplit = batches.get(sample.batch);
  if (priorSplit && priorSplit !== sample.split) throw new Error('A capture batch cannot cross calibration/acceptance splits');
  batches.set(sample.batch, sample.split);
  if (sample.bagId && !referenceIds.has(sample.bagId)) throw new Error(`Missing reference for ${sample.bagId}; use null for out-of-library`);
  const { body, hash } = await load(sample.path, `sample:${sample.path}`);
  const started = performance.now();
  const query = await extractScanFeature(await cropScanImage(body, sample.crop), settings.engine, process.env.VISION_SERVICE_URL);
  const scores = rankScanCandidates([query], entries, settings);
  const candidates = scanCandidates(scores, settings);
  rows.push({ ...sample, sha256: hash, candidates, coreMs: performance.now() - started,
    hit: !!sample.bagId && candidates.some(c => c.bagId === sample.bagId), independentCapture: sample.independentCapture === true });
}
const percentile = (values, p) => values.length ? values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
function summarize(split) {
  const subset = rows.filter(r => r.split === split); const known = subset.filter(r => r.bagId); const outside = subset.filter(r => !r.bagId);
  return { knownSamples: known.length, outsideSamples: outside.length,
    recallAt5: known.length ? known.filter(r => r.hit).length / known.length : null,
    outsideCandidateRate: outside.length ? outside.filter(r => r.candidates.length).length / outside.length : null,
    coreP95Ms: percentile(subset.map(r => r.coreMs), .95) };
}
const adequatelySampled = [...referenceIds].filter(id => ['calibration', 'acceptance'].every(split => {
  const samples = rows.filter(r => r.bagId === id && r.split === split && r.independentCapture);
  return [...new Set(samples.map(r => r.batch))].some(batch => samples.filter(r => r.batch === batch).length >= 3);
})).length;
const acceptance = summarize('acceptance');
const sampleGate = adequatelySampled >= 30 && acceptance.outsideSamples >= 40 && rows.every(r => r.independentCapture);
const report = { createdAt: new Date().toISOString(), model, settings,
  calibration: summarize('calibration'), acceptance, sufficientlySampledStyles: adequatelySampled,
  sampleGate, targetReached: sampleGate && acceptance.recallAt5 >= .9,
  limitation: 'Core latency excludes upload, queue, cloud enhancement and API polling. Capture independence is declared by dataset owner; variants cannot be proven independent by hashes. Confirm camera consistency and server P95 separately.', rows };
const destination = process.argv[3] ?? `${inputPath}.report.json`;
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: undefined, reportPath: destination }, null, 2));
