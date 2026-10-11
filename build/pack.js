// Step 3 of the build: pack people, face fingerprints and the curated pairs
// into the files the phone downloads, and assemble the website in dist/.
// Usage: node build/pack.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { quantize, DIM } from '../shared/face.js';
import { commonsPaths } from './lib/image.js';
import { KNOWN_FAME } from './config.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const DIST = path.join(ROOT, 'dist');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const people = read(path.join(OUT, 'people.json'));
const faces = fs.existsSync(path.join(OUT, 'faces.json')) ? read(path.join(OUT, 'faces.json')) : {};
const { pairs } = read(path.join(ROOT, 'data/mistaken-for.json'));

// Commons path segment "a/ab/File_name.jpg"; the app builds thumbnail URLs from it.
const commonsSeg = (file) => {
  const u = commonsPaths(file).original;
  return u.slice(u.indexOf('/commons/') + 9);
};

// People with the highest pageviews first (search ties break toward them).
people.sort((a, b) => b.views60 - a.views60);
const rows = [];
const compact = people.map((p) => {
  const f = faces[p.id];
  const o = { i: p.id, n: p.name };
  if (p.title !== p.name) o.t = p.title;
  if (p.aliases.length) o.a = p.aliases;
  o.d = p.line || p.desc || '';
  if (p.chips.length) o.k = p.chips;
  o.c = p.cats;
  o.f = Number(p.fame.toFixed(2));
  if (p.born) o.y = p.born;
  if (p.died) o.z = p.died;
  const photo = f?.file || p.images[0];
  if (photo) o.img = commonsSeg(photo);
  if (f) {
    o.fc = [...f.bf, f.aspect];
    o.v = rows.length;
    rows.push(quantize(Float32Array.from(f.vec)));
  }
  return o;
});

const byTitle = new Map(people.map((p, i) => [p.title, i]));
const packedPairs = [];
for (const p of pairs) {
  const a = byTitle.get(p.a);
  const b = byTitle.get(p.b);
  if (a === undefined || b === undefined) {
    console.warn(`  pair skipped (not in index): ${p.a} / ${p.b}`);
    continue;
  }
  packedPairs.push([a, b, p.kind, p.note, p.source || null]);
}

const vectors = new Int8Array(rows.length * DIM);
rows.forEach((r, i) => vectors.set(r, i * DIM));

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const peopleBuf = Buffer.from(JSON.stringify({ people: compact, pairs: packedPairs, knownFame: KNOWN_FAME }));
const vecBuf = Buffer.from(vectors.buffer);

// Fresh dist/.
fs.rmSync(DIST, { recursive: true, force: true });
const put = (rel, data) => {
  const f = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const copy = (from, to) => put(to, fs.readFileSync(path.join(ROOT, from)));

const peopleFile = `data/people.${hash(peopleBuf)}.json`;
const vecFile = `data/vectors.${hash(vecBuf)}.bin`;
put(peopleFile, peopleBuf);
put(vecFile, vecBuf);
const built = new Date().toISOString();
put('data/manifest.json', JSON.stringify({ built, people: peopleFile, vectors: vecFile, count: compact.length, faces: rows.length, dim: DIM }, null, 1));

// App, shared code, runtime and models.
for (const f of fs.readdirSync(path.join(ROOT, 'app'))) copy(`app/${f}`, f);
copy('shared/face.js', 'shared/face.js');
copy('shared/names.js', 'shared/names.js');
const ORT = 'node_modules/onnxruntime-web/dist';
copy(`${ORT}/ort.wasm.min.mjs`, 'vendor/ort.wasm.min.mjs');
copy(`${ORT}/ort-wasm-simd-threaded.mjs`, 'vendor/ort-wasm-simd-threaded.mjs');
copy(`${ORT}/ort-wasm-simd-threaded.wasm`, 'vendor/ort-wasm-simd-threaded.wasm');
copy('licenses/onnxruntime-web.txt', 'vendor/LICENSE-onnxruntime.txt');
copy('node_modules/double-metaphone/index.js', 'vendor/double-metaphone.js');
copy('node_modules/double-metaphone/license', 'vendor/LICENSE-double-metaphone.txt');
for (const m of ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec_int8.onnx', 'LICENSE-yunet.txt', 'LICENSE-sface.txt']) {
  copy(`models/${m}`, `models/${m}`);
}

// The service worker caches by build, so a new build replaces old files.
const swPath = path.join(DIST, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace('__BUILD__', hash(Buffer.from(built + peopleFile + vecFile))));
put('.nojekyll', '');

const mb = (n) => (n / 1e6).toFixed(1);
console.log(`packed ${compact.length} people, ${rows.length} faces, ${packedPairs.length} pairs; people ${mb(peopleBuf.length)} MB, vectors ${mb(vecBuf.length)} MB`);
