// Step 2 of the build: download each person's free-licence photos from
// Wikimedia Commons and compute face fingerprints.
// Usage: node build/embed.js [--budget-min=N | --deadline=<epoch ms>] [--limit=N]
// Reads build/out/people.json, writes build/out/faces.json and
// build/out/embed-status.json.
//
// - Most-viewed people first, so a run cut short by the time budget still
//   covers the people Abby is likeliest to see. Results are cached per photo in
//   build/cache/emb/, so the next run continues where this one stopped.
// - Group photos: up to 3 faces are kept per photo. If someone's main photo
//   has several faces, their second photo decides which face is theirs.
// - A small, fixed sample of people also gets a second photo processed, for
//   the accuracy test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchCommonsImage, decodeRGBA, nodeFaceEngine, CACHE_DIR } from './lib/image.js';
import { limiter, mediaPace } from './lib/http.js';
import { cosine } from '../shared/face.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const MODEL_TAG = 'yunet2023mar+sface2021dec_int8+v2';
const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d);
const t0 = Date.now();
const DEADLINE = arg('deadline', 0) || t0 + arg('budget-min', 100000) * 60 * 1000;
const BUDGET_MS = DEADLINE - t0;
const LIMIT = arg('limit', Infinity);
const MIN_SCORE = 0.7;
const SAME_PERSON = 0.35; // cosine; OpenCV's same-person threshold is 0.363
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const people = JSON.parse(fs.readFileSync(path.join(OUT, 'people.json'), 'utf8')).slice(0, LIMIT);
const engine = await nodeFaceEngine();
const embDir = path.join(CACHE_DIR, 'emb');
fs.mkdirSync(embDir, { recursive: true });
const cachePath = (file) => path.join(embDir, crypto.createHash('sha1').update(`${MODEL_TAG}|${file}`).digest('hex') + '.json');
const readCache = (file) => {
  try { return JSON.parse(fs.readFileSync(cachePath(file), 'utf8')); } catch { return null; }
};

// About 1 in 25 people with 2+ photos, chosen by ID so it's stable across runs.
const inEvalSample = (id) => crypto.createHash('md5').update(id).digest()[0] % 25 === 0;

const cpu = limiter(1, 0); // the face models run one photo at a time
let downloaded = 0;
let analysed = 0;
let outOfTime = false;

async function analyse(file) {
  const cached = readCache(file);
  if (cached) return cached;
  if (Date.now() - t0 > BUDGET_MS) { outOfTime = true; return null; }
  const buf = await fetchCommonsImage(file);
  if (buf === undefined) return null; // temporary failure: retry next run
  downloaded++;
  const rec = await cpu(async () => {
    if (!buf) return { file, faces: [], error: 'unusable file' };
    try {
      const img = await decodeRGBA(buf);
      const found = (await engine.detect(img)).filter((f) => f.score >= MIN_SCORE);
      found.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
      const faces = [];
      for (const f of found.slice(0, 3)) {
        const v = await engine.embed(img, f);
        const [x, y, w, h] = f.box;
        faces.push({
          // Face box as fractions of the photo (x, y, w, h), for thumbnails.
          bf: [x / img.width, y / img.height, w / img.width, h / img.height].map((n) => Number(n.toFixed(4))),
          score: Number(f.score.toFixed(3)),
          vec: Array.from(v, (n) => Number(n.toFixed(5))),
        });
      }
      analysed++;
      return { file, faces, nFaces: found.length, aspect: Number((img.width / img.height).toFixed(4)) };
    } catch (e) {
      return { file, faces: [], error: e.message.slice(0, 200) };
    }
  });
  fs.writeFileSync(cachePath(file), JSON.stringify(rec));
  return rec;
}

// Which face in `rec` is this person, using their other photos as reference.
function pickFace(rec, others) {
  if (rec.faces.length === 1) return { face: rec.faces[0], sure: true };
  let best = null;
  for (const f of rec.faces) {
    for (const o of others) for (const g of o.faces) {
      const c = cosine(f.vec, g.vec);
      if (!best || c > best.c) best = { c, face: f };
    }
  }
  if (best && best.c >= SAME_PERSON) return { face: best.face, sure: true };
  return { face: rec.faces[0], sure: false }; // largest face, unconfirmed
}

const faces = {};
let pending = 0;
let multi = 0;
let unsure = 0;
async function person(p) {
  const files = p.images.slice(0, 3);
  if (!files.length) return;
  const recs = [];
  const first = await analyse(files[0]);
  if (!first) { pending++; return; }
  recs.push(first);
  const needSecond = first.faces.length !== 1 || inEvalSample(p.id);
  for (const file of files.slice(1)) {
    if (!needSecond && recs.some((r) => r.faces.length === 1)) break;
    const r = await analyse(file);
    if (!r) { if (outOfTime) break; continue; }
    recs.push(r);
    if (recs.filter((x) => x.faces.length).length >= 2) break;
  }
  const withFaces = recs.filter((r) => r.faces.length);
  if (!withFaces.length) return;
  const main = withFaces[0];
  const { face, sure } = pickFace(main, withFaces.slice(1));
  if (main.faces.length > 1) multi++;
  if (!sure) unsure++;
  const entry = { file: main.file, bf: face.bf, aspect: main.aspect, vec: face.vec, score: face.score, sure };
  // Accuracy-test photo: only when the main photo is unambiguous (so the
  // test photo wasn't used to choose the face).
  const second = withFaces[1];
  if (inEvalSample(p.id) && main.faces.length === 1 && second) {
    entry.evalFile = second.file;
    entry.evalVec = second.faces[0].vec;
  }
  faces[p.id] = entry;
}

// Several people in flight so downloads overlap with face analysis.
const queue = people.filter((p) => p.images.length);
log(`${people.length.toLocaleString()} people, ${queue.length.toLocaleString()} with photos; budget ${Math.round(BUDGET_MS / 60000)} min`);
let next = 0;
let done = 0;
async function worker() {
  while (next < queue.length) {
    const p = queue[next++];
    await person(p);
    if (++done % 500 === 0) {
      const mins = (Date.now() - t0) / 60000;
      log(`  ${done.toLocaleString()}/${queue.length.toLocaleString()} people · ${downloaded.toLocaleString()} downloads (${(downloaded / mins).toFixed(0)}/min) · pace ${mediaPace.gapMs} ms · 429s ${mediaPace.throttled}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

fs.writeFileSync(path.join(OUT, 'faces.json'), JSON.stringify(faces));
const status = {
  people: people.length,
  withPhotos: queue.length,
  faces: Object.keys(faces).length,
  pending, // people whose first photo isn't processed yet (time budget or download trouble)
  downloadedThisRun: downloaded,
  analysedThisRun: analysed,
  multiFaceMain: multi,
  unconfirmedFace: unsure,
  evalPairs: Object.values(faces).filter((f) => f.evalVec).length,
  throttled: mediaPace.throttled,
  minutes: Math.round((Date.now() - t0) / 60000),
};
fs.writeFileSync(path.join(OUT, 'embed-status.json'), JSON.stringify(status, null, 1));
log(`faces for ${status.faces.toLocaleString()} people; ${pending.toLocaleString()} still to do; ${downloaded.toLocaleString()} photos downloaded this run (${status.throttled} rate-limit replies); ${multi} group photos, ${unsure} unconfirmed`);
