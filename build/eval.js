// Accuracy test. For a fixed sample of people (about 1 in 25) whose main photo
// shows only them and who have a second free photo, search the index (built
// from the main photos, int8 as on the phone) with the second photo and record
// whether they come out first (top-1) and in the top 10.
// Also: int8 vs full-precision agreement, and how close curated look-alike
// pairs are in face space.
// Usage: node build/eval.js   -> prints a report, writes build/out/eval.json
import fs from 'node:fs';
import path from 'node:path';
import { quantize, rowInverseNorms, similarities, DIM, cosine } from '../shared/face.js';
import { CAT } from './config.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const people = JSON.parse(fs.readFileSync(path.join(OUT, 'people.json'), 'utf8'));
const faces = JSON.parse(fs.readFileSync(path.join(OUT, 'faces.json'), 'utf8'));
const { pairs } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mistaken-for.json'), 'utf8'));

const ids = people.map((p) => p.id).filter((id) => faces[id]);
const byId = new Map(people.map((p) => [p.id, p]));
const n = ids.length;
const int8 = new Int8Array(n * DIM);
const floats = ids.map((id) => Float32Array.from(faces[id].vec));
ids.forEach((id, r) => int8.set(quantize(floats[r]), r * DIM));
const inv = rowInverseNorms(int8, n);

// Wilson 95% interval for a proportion.
function wilson(k, total) {
  if (!total) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = (p + (z * z) / (2 * total)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return [c - h, c + h];
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// The same picture under two names ("X.jpg" and "X (cropped).jpg") isn't a
// fair test; skip those.
const base = (f) => f.toLowerCase().replace(/\.(jpe?g|png|webp)$/, '').replace(/\s*\((cropped|crop)[^)]*\)\s*/g, '').replace(/[\s_-]*(cropped|crop)\d*$/, '').trim();

const groupOf = (p) => (p.cats & CAT.nebraska ? 'Nebraska' : p.cats & CAT.college ? 'College' : p.cats & CAT.pro ? 'Pro sports' : p.cats & CAT.music ? 'Music' : p.cats & CAT.screen ? 'Movies & TV' : 'Other');
// Accuracy depends strongly on fame (photo quality and how many photos exist).
const fameTier = (v) => (v >= 30000 ? 'Fame 30k+' : v >= 6000 ? 'Fame 6k-30k' : v >= 1500 ? 'Fame 1.5k-6k' : 'Fame <1.5k');
const tally = new Map();
const add = (g, top1, top10) => {
  const t = tally.get(g) || { n: 0, top1: 0, top10: 0 };
  t.n++; t.top1 += top1; t.top10 += top10;
  tally.set(g, t);
};
const misses = [];
for (let r = 0; r < n; r++) {
  const f = faces[ids[r]];
  if (!f.evalVec || base(f.file) === base(f.evalFile)) continue;
  const sims = similarities(Float32Array.from(f.evalVec), int8, inv);
  const target = sims[r];
  let rank = 1;
  for (let j = 0; j < n; j++) if (j !== r && sims[j] > target) rank++;
  const p = byId.get(ids[r]);
  add('All', rank === 1, rank <= 10);
  add(groupOf(p), rank === 1, rank <= 10);
  add(fameTier(p.views60), rank === 1, rank <= 10);
  if (rank > 10) misses.push({ name: p.name, rank, sameCos: Number(cosine(f.vec, f.evalVec).toFixed(3)), file: f.file, file2: f.evalFile });
}

// int8 vs float: do the top-10 lists agree?
let overlap = 0;
let checked = 0;
for (let r = 0; r < n; r += Math.max(1, Math.floor(n / 300))) {
  const q = floats[r];
  const s8 = similarities(q, int8, inv);
  const top = (score) => [...Array(n).keys()].filter((j) => j !== r).sort((a, b) => score(b) - score(a)).slice(0, 10);
  const a = new Set(top((j) => s8[j]));
  const b = top((j) => cosine(q, floats[j]));
  overlap += b.filter((j) => a.has(j)).length / 10;
  checked++;
}

// Curated face pairs: similarity and rank of each in the other's list.
const rowOf = new Map(ids.map((id, r) => [byId.get(id).title, r]));
const pairReport = [];
for (const p of pairs.filter((x) => x.kind === 'face')) {
  const a = rowOf.get(p.a);
  const b = rowOf.get(p.b);
  if (a === undefined || b === undefined) { pairReport.push({ pair: `${p.a} / ${p.b}`, note: 'not both in face index' }); continue; }
  const sims = similarities(floats[a], int8, inv);
  let rank = 1;
  for (let j = 0; j < n; j++) if (j !== a && j !== b && sims[j] > sims[b]) rank++;
  pairReport.push({ pair: `${p.a} / ${p.b}`, cosine: Number(cosine(floats[a], floats[b]).toFixed(3)), rankOfBforA: rank });
}

const report = {
  built: new Date().toISOString(),
  indexSize: n,
  identification: Object.fromEntries([...tally].map(([g, t]) => [g, {
    n: t.n,
    top1: Number((t.top1 / t.n).toFixed(3)), top1CI: wilson(t.top1, t.n).map((x) => Number(x.toFixed(3))),
    top10: Number((t.top10 / t.n).toFixed(3)), top10CI: wilson(t.top10, t.n).map((x) => Number(x.toFixed(3))),
  }])),
  int8Top10Overlap: Number((overlap / checked).toFixed(3)),
  curatedPairs: pairReport,
  misses: misses.sort((a, b) => b.rank - a.rank).slice(0, 25),
};
fs.writeFileSync(path.join(OUT, 'eval.json'), JSON.stringify(report, null, 1));

console.log(`Face index: ${n} people`);
console.log('Identification from a second photo (right person ranked 1st / in top 10, 95% CI):');
for (const [g, t] of Object.entries(report.identification)) {
  console.log(`  ${g.padEnd(12)} n=${String(t.n).padStart(4)}  top-1 ${pct(t.top1)} [${pct(t.top1CI[0])}–${pct(t.top1CI[1])}]  top-10 ${pct(t.top10)} [${pct(t.top10CI[0])}–${pct(t.top10CI[1])}]`);
}
console.log(`int8 vs full precision, top-10 overlap: ${pct(report.int8Top10Overlap)} (${checked} queries)`);
console.log('Curated look-alike pairs in face space:');
for (const p of pairReport) console.log(`  ${p.pair.padEnd(40)} ${p.note || `cosine ${p.cosine}, rank ${p.rankOfBforA} of ${n - 1}`}`);
