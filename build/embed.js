// Step 2 of the build: download each person's free-license photos from
// Wikimedia Commons and compute face fingerprints.
// Usage: node build/embed.js
// Reads build/out/people.json, writes build/out/faces.json.
// Results are cached per photo in build/cache/emb/, so re-runs only process
// new photos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchCommonsImage, decodeRGBA, nodeFaceEngine, CACHE_DIR } from './lib/image.js';
import { largestFace, cosine } from '../shared/face.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const MODEL_TAG = 'yunet2023mar+sface2021dec_int8+v1';
const MAX_PHOTOS = 2;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const people = JSON.parse(fs.readFileSync(path.join(OUT, 'people.json'), 'utf8'));
const engine = await nodeFaceEngine();
const embDir = path.join(CACHE_DIR, 'emb');
fs.mkdirSync(embDir, { recursive: true });

const cachePath = (file) =>
  path.join(embDir, crypto.createHash('sha1').update(`${MODEL_TAG}|${file}`).digest('hex') + '.json');

async function processPhoto(file, bufPromise) {
  const cp = cachePath(file);
  if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, 'utf8'));
  const buf = await bufPromise;
  if (!buf) return null; // download failed; try again next run
  let rec;
  try {
    const img = await decodeRGBA(buf);
    const faces = await engine.detect(img);
    const face = largestFace(faces);
    if (!face) {
      rec = { file, face: false, nFaces: faces.length };
    } else {
      const v = await engine.embed(img, face);
      const [x, y, w, h] = face.box;
      rec = {
        file,
        face: true,
        nFaces: faces.filter((f) => f.score >= 0.7).length,
        score: Number(face.score.toFixed(3)),
        // Face box as fractions of the photo (x, y, w, h), for thumbnails.
        bf: [x / img.width, y / img.height, w / img.width, h / img.height].map((n) => Number(n.toFixed(4))),
        aspect: Number((img.width / img.height).toFixed(4)),
        vec: Array.from(v, (n) => Number(n.toFixed(6))),
      };
    }
  } catch (e) {
    rec = { file, face: false, error: e.message.slice(0, 200) };
  }
  fs.writeFileSync(cp, JSON.stringify(rec));
  return rec;
}

// Download a few photos ahead (the media limiter keeps it to 2 at a time)
// while fingerprinting in order.
const jobs = [];
for (const p of people) {
  for (const file of p.images.slice(0, MAX_PHOTOS + 1)) jobs.push({ p, file, buf: null });
}
log(`${people.length} people, ${jobs.length} photos to check`);
const AHEAD = 16;
const prefetch = (i) => {
  const j = jobs[i];
  if (j && !j.buf && !fs.existsSync(cachePath(j.file))) j.buf = fetchCommonsImage(j.file);
};
for (let i = 0; i < AHEAD; i++) prefetch(i);

const byPerson = new Map();
let done = 0;
for (let i = 0; i < jobs.length; i++) {
  prefetch(i + AHEAD);
  const j = jobs[i];
  const rec = await processPhoto(j.file, j.buf);
  j.buf = null;
  if (rec?.face) {
    if (!byPerson.has(j.p.id)) byPerson.set(j.p.id, []);
    byPerson.get(j.p.id).push(rec);
  }
  if (++done % 100 === 0) log(`  ${done}/${jobs.length}`);
}

// Primary fingerprint = first usable photo (Wikidata's main image comes
// first). A second photo is kept for the accuracy test; if the two disagree
// strongly the person is flagged for a look.
const faces = {};
let flagged = 0;
for (const p of people) {
  const recs = (byPerson.get(p.id) || []).slice(0, MAX_PHOTOS);
  if (!recs.length) continue;
  const [a, b] = recs;
  const entry = { file: a.file, bf: a.bf, aspect: a.aspect, vec: a.vec, score: a.score };
  if (b) {
    entry.file2 = b.file;
    entry.vec2 = b.vec;
    entry.agree = Number(cosine(a.vec, b.vec).toFixed(3));
    if (entry.agree < 0.3) flagged++;
  }
  faces[p.id] = entry;
}
fs.writeFileSync(path.join(OUT, 'faces.json'), JSON.stringify(faces));
const n = Object.keys(faces).length;
log(`wrote faces for ${n} of ${people.length} people (${people.filter((p) => p.images.length).length} had a photo); ${Object.values(faces).filter((f) => f.vec2).length} with a second photo; ${flagged} where the two photos disagree`);
