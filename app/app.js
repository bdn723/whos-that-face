// Who's That? — the app. Everything runs on the phone: photos are never
// uploaded. The only network requests are for the app's own files, Wikimedia
// photo thumbnails, and (on a person's page) their Wikipedia summary.
import * as ort from 'onnxruntime-web';
import {
  createFaceEngine, fitWithin, rotate90, rowInverseNorms, similarities, rowVector, DIM,
} from './shared/face.js';
import { buildNameIndex, searchNames } from './shared/names.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./vendor/', location.href).href;

const CAT = { screen: 1, music: 2, pro: 4, college: 8, nebraska: 16 };
const FILTERS = [
  ['all', 'All', 0],
  ['screen', 'Movies & TV', CAT.screen],
  ['music', 'Music', CAT.music],
  ['pro', 'Pro sports', CAT.pro],
  ['college', 'College', CAT.college],
  ['nebraska', 'Nebraska', CAT.nebraska],
];
// Face-match confidence (cosine similarity). 0.363 is OpenCV's published
// same-person threshold for SFace.
const STRONG = 0.5;
const POSSIBLE = 0.363;
const FAME_BONUS = 0.04; // small nudge toward people she has plausibly heard of
const LOOKALIKES = 10;

const S = {
  manifest: null,
  people: [],
  pairsBy: new Map(),
  knownFame: 0.3,
  names: null,
  vectors: null,
  invNorms: null,
  rowPerson: null,
  engine: null,
  filter: loadPref('filter', 'all'),
  showAll: loadPref('showAll', false),
  query: '',
  photo: null, // { img, faces, chosen }
};

const $view = document.getElementById('view');
const $file = document.getElementById('photo-input');

// ---------- small helpers ----------

function loadPref(k, d) {
  try { const v = localStorage.getItem('wt.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
}
function savePref(k, v) {
  try { localStorage.setItem('wt.' + k, JSON.stringify(v)); } catch { /* private mode */ }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function thumbUrl(seg, w = 330) {
  const name = seg.split('/').pop();
  // Long file names get "thumbnail.<ext>" thumbnails on Commons.
  const long = new TextEncoder().encode(decodeURIComponent(name)).length > 160;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${seg}/${w}px-${long ? 'thumbnail' + name.slice(name.lastIndexOf('.')) : name}`;
}
const originalUrl = (seg) => `https://upload.wikimedia.org/wikipedia/commons/${seg}`;

// A round photo zoomed onto the face. fc = [x, y, w, h, aspect] (fractions).
function avatar(p, size, cls = '') {
  if (!p.img) return `<div class="avatar ${cls}" aria-hidden="true">${esc(initials(p.n))}</div>`;
  const url = thumbUrl(p.img, size > 120 ? 500 : 330);
  let style = `background-image:url('${url}');`;
  if (p.fc) {
    const [x, y, w, h, aspect] = p.fc;
    // Scale so the face fills ~62% of the circle, but always cover it.
    let Wd = (0.62 * size) / Math.max(w, h / aspect);
    Wd = Math.max(Wd, size, size * aspect);
    const Hd = Wd / aspect;
    const cx = (x + w / 2) * Wd;
    const cy = (y + h / 2.2) * Hd;
    const px = Math.min(0, Math.max(size - Wd, size / 2 - cx));
    const py = Math.min(0, Math.max(size - Hd, size / 2 - cy));
    style += `background-size:${Wd.toFixed(1)}px ${Hd.toFixed(1)}px;background-position:${px.toFixed(1)}px ${py.toFixed(1)}px;`;
  } else {
    style += 'background-size:cover;background-position:center 20%;';
  }
  return `<div class="avatar ${cls}" role="img" aria-label="${esc(p.n)}" data-img="${esc(p.img)}" style="${style}"></div>`;
}

// If a thumbnail size doesn't exist (photo smaller than 330px), use the original.
function fixThumbs(root) {
  for (const el of root.querySelectorAll('.avatar[data-img]')) {
    const seg = el.dataset.img;
    const probe = new Image();
    probe.onerror = () => { el.style.backgroundImage = `url('${originalUrl(seg)}')`; };
    probe.src = el.style.backgroundImage.slice(5, -2);
  }
}

function chips(p) {
  const k = p.k || [];
  if (!k.length) return '';
  return `<div class="chips">${k.map((c) => `<span class="chip${/nebraska/i.test(c) ? ' nebraska' : ''}">${esc(c)}</span>`).join('')}</div>`;
}

function personRow(pi, extra = '') {
  const p = S.people[pi];
  return `<a class="person" href="#/p/${p.i}">
    ${avatar(p, 56)}
    <div class="who"><div class="name">${esc(p.n)}</div><div class="line">${esc(p.d)}</div>${extra}</div>
    <span aria-hidden="true">›</span>
  </a>`;
}

const passesCat = (p) => S.filter === 'all' || (p.c & FILTERS.find((f) => f[0] === S.filter)[2]);
const passesFame = (p) => S.showAll || p.f >= S.knownFame || (p.c & CAT.nebraska);

function filterBar() {
  return `<div class="filters" role="toolbar" aria-label="Show">
    ${FILTERS.map(([k, label]) => `<button class="filter" data-filter="${k}" aria-pressed="${S.filter === k}">${label}</button>`).join('')}
  </div>
  <label class="toggle"><input type="checkbox" id="show-all" ${S.showAll ? 'checked' : ''}> Include lesser-known people</label>`;
}

function wireFilters(rerender) {
  for (const b of $view.querySelectorAll('[data-filter]')) {
    b.onclick = () => { S.filter = b.dataset.filter; savePref('filter', S.filter); rerender(); };
  }
  const t = $view.querySelector('#show-all');
  if (t) t.onchange = () => { S.showAll = t.checked; savePref('showAll', S.showAll); rerender(); };
}

// ---------- data loading ----------

const timings = {};
async function loadManifest() {
  S.manifest = await (await fetch('data/manifest.json', { cache: 'no-cache' })).json();
}
async function loadPeople() {
  const t0 = performance.now();
  const m = S.manifest;
  const d = await (await fetch(m.people)).json();
  timings.peopleLoad = performance.now() - t0;
  S.people = d.people;
  S.knownFame = d.knownFame;
  for (const [a, b, kind, note, source] of d.pairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!S.pairsBy.has(x)) S.pairsBy.set(x, []);
      S.pairsBy.get(x).push({ other: y, kind, note, source });
    }
  }
  const t1 = performance.now();
  S.names = buildNameIndex(S.people);
  timings.nameIndex = performance.now() - t1;
  S.byId = new Map(S.people.map((p, i) => [p.i, i]));
  S.rowPerson = new Int32Array(m.faces);
  S.people.forEach((p, i) => { if (p.v !== undefined) S.rowPerson[p.v] = i; });
}

let faceReady;
function loadFaces() {
  if (!faceReady) {
    faceReady = (async () => {
      const m = S.manifest;
      const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
      const [vec, det, rec] = await Promise.all([
        get(m.vectors),
        get('models/face_detection_yunet_2023mar.onnx'),
        get('models/face_recognition_sface_2021dec_int8.onnx'),
      ]);
      S.vectors = new Int8Array(vec.buffer, vec.byteOffset, vec.byteLength);
      S.invNorms = rowInverseNorms(S.vectors, S.vectors.length / DIM);
      S.engine = await createFaceEngine(ort, det, rec);
    })();
    faceReady.catch(() => { faceReady = null; });
  }
  return faceReady;
}

// ---------- face search ----------

// People ranked by face similarity to a fingerprint.
function faceRank(query, { exclude = -1, k = LOOKALIKES, filtered = true } = {}) {
  const sims = similarities(query, S.vectors, S.invNorms);
  const out = [];
  for (let r = 0; r < sims.length; r++) {
    const pi = S.rowPerson[r];
    if (pi === exclude) continue;
    const p = S.people[pi];
    if (filtered && !(passesCat(p) && passesFame(p))) continue;
    out.push({ pi, sim: sims[r], score: sims[r] + FAME_BONUS * p.f });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

async function fileToImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    // Wait for the load event rather than img.decode(), which some browsers
    // hold back while the page is in the background. The browser applies the
    // photo's rotation when drawing it.
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a readable image'));
      img.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    // Draw at most 2560px (iOS limits canvas size); face.js shrinks further.
    const s = Math.min(1, 2560 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    return fitWithin({ data: data.data, width: c.width, height: c.height }, 1280);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handlePhoto(blob) {
  location.hash = '#/face';
  S.photo = { status: 'Reading photo…' };
  renderFace();
  try {
    let img = await fileToImage(blob);
    S.photo.status = S.engine ? 'Looking for faces…' : 'Getting the face matcher ready (first time only)…';
    renderFace();
    await Promise.all([loadFaces(), peopleReady]);
    let faces = await S.engine.detect(img);
    // Sideways photo? Try the other orientations.
    for (let turn = 0; !faces.length && turn < 3; turn++) {
      img = rotate90(img);
      faces = await S.engine.detect(img);
    }
    faces = faces.filter((f) => f.score >= 0.6).slice(0, 12);
    S.photo = { img, faces, chosen: faces.length === 1 ? 0 : -1, results: null };
    if (faces.length === 1) await chooseFace(0);
    else renderFace();
  } catch (e) {
    console.error(e);
    S.photo = { error: `Sorry, that photo couldn't be read (${e.message}).` };
    renderFace();
  }
}

async function chooseFace(i) {
  const ph = S.photo;
  ph.chosen = i;
  ph.vec = await S.engine.embed(ph.img, ph.faces[i]);
  renderFace();
}

// ---------- views ----------

function renderHome() {
  $view.innerHTML = `
    <div class="ways">
      <section class="way">
        <h2>Who's that face?</h2>
        <p>Snap the TV or pick a photo or screenshot. It never leaves your phone.</p>
        <div class="btn-row">
          <button class="btn" id="pick">Take or choose a photo</button>
          <button class="btn secondary" id="paste">Paste</button>
        </div>
      </section>
      <section class="way">
        <h2>Who's that name?</h2>
        <p>Type a name, even half-remembered or misspelled.</p>
        <input id="q" class="search" type="search" placeholder="e.g. Will Farrel" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" value="${esc(S.query)}">
      </section>
    </div>
    <div id="name-results"></div>
    <p class="privacy">Photos are checked on this phone and never uploaded.</p>`;
  $view.querySelector('#pick').onclick = () => $file.click();
  $view.querySelector('#paste').onclick = pasteImage;
  const q = $view.querySelector('#q');
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.query = q.value; renderNameResults(); }, 120); };
  if (S.query) renderNameResults();
  // Start loading the face matcher quietly so a photo is fast later.
  if (S.manifest) setTimeout(() => loadFaces().catch(() => {}), 1500);
}

function renderNameResults() {
  const box = $view.querySelector('#name-results');
  if (!box) return;
  const q = S.query.trim();
  if (!q) { box.innerHTML = ''; return; }
  if (!S.names) {
    box.innerHTML = '<p class="loading">Getting the list of names ready…</p>';
    peopleReady.then(renderNameResults);
    return;
  }
  const { same, similar } = searchNames(S.names, q, { limit: 40 });
  const keep = (r) => passesCat(S.people[r.pi]) && passesFame(S.people[r.pi]);
  // Exact-name matches always show (she typed that name); filters apply to the rest.
  const sameList = same.filter((r) => passesCat(S.people[r.pi]));
  const sameSet = new Set(sameList.map((r) => r.pi));
  // Hand-checked name mix-ups of the people found come first.
  const curated = [];
  for (const r of [...sameList, ...similar.slice(0, 1)]) {
    for (const x of S.pairsBy.get(r.pi) || []) {
      if (x.kind === 'name' && !sameSet.has(x.other) && !curated.some((c) => c.pi === x.other)) curated.push({ pi: x.other });
    }
  }
  const curatedSet = new Set(curated.map((c) => c.pi));
  const rest = similar.filter((r) => !sameSet.has(r.pi) && !curatedSet.has(r.pi) && keep(r));
  // With no exact match, the closest name stays on top, then the curated pairs.
  const simList = (sameList.length ? [...curated, ...rest] : [...rest.slice(0, 1), ...curated, ...rest.slice(1)]).slice(0, 15);
  box.innerHTML = `${filterBar()}
    ${sameList.length ? `<h3 class="section">${sameList.length > 1 ? `${sameList.length} people named “${esc(q)}”` : 'Same name'}</h3>
      <div class="list">${sameList.map((r) => personRow(r.pi)).join('')}</div>` : ''}
    ${simList.length ? `<h3 class="section">${sameList.length ? 'Similar names' : 'Did you mean…'}</h3>
      <div class="list">${simList.map((r) => personRow(r.pi)).join('')}</div>` : ''}
    ${!sameList.length && !simList.length ? `<p class="empty">No one by that name${S.filter !== 'all' || !S.showAll ? ' with these filters' : ''}.</p>` : ''}`;
  wireFilters(renderNameResults);
  fixThumbs(box);
}

function renderFace() {
  const ph = S.photo;
  if (!ph) { location.hash = '#/'; return; }
  if (ph.error) { $view.innerHTML = `<button class="back" onclick="history.back()">‹ Back</button><p class="empty err">${esc(ph.error)}</p>`; return; }
  if (!ph.img) { $view.innerHTML = `<p class="loading">${esc(ph.status)}</p>`; return; }
  const { img, faces } = ph;
  const boxes = faces.map((f, i) => {
    const [x, y, w, h] = f.box;
    return `<button class="facebox" data-face="${i}" aria-pressed="${ph.chosen === i}" aria-label="Face ${i + 1}"
      style="left:${(x / img.width) * 100}%;top:${(y / img.height) * 100}%;width:${(w / img.width) * 100}%;height:${(h / img.height) * 100}%"></button>`;
  }).join('');
  let body = '';
  if (!faces.length) {
    body = `<p class="empty">No face found. Try a closer photo, or crop to the face.</p>`;
  } else if (ph.chosen < 0) {
    body = `<p class="hint">${faces.length} faces — tap the one you mean.</p>`;
  } else if (ph.vec) {
    const best = faceRank(ph.vec, { k: 1, filtered: false })[0];
    const label = best.sim >= STRONG ? ['strong', 'Strong match'] : best.sim >= POSSIBLE ? ['possible', 'Possible match'] : ['none', 'Probably not in our list'];
    const p = S.people[best.pi];
    const looks = faceRank(ph.vec, { exclude: best.pi, k: LOOKALIKES });
    const pairs = (S.pairsBy.get(best.pi) || []).filter((x) => x.kind === 'face');
    body = `
      <h3 class="section">${label[0] === 'none' ? 'Closest face' : 'Best match'}</h3>
      <a class="best" href="#/p/${p.i}">
        ${avatar(p, 112, 'big')}
        <div><span class="badge ${label[0]}">${label[1]}</span><div class="name">${esc(p.n)}</div><div class="line">${esc(p.d)}</div>${chips(p)}</div>
      </a>
      ${label[0] === 'none' ? '<p class="hint">This face may not be in our list. These are the closest lookalikes.</p>' : ''}
      ${pairs.length ? `<h3 class="section">Often mistaken for</h3><div class="list">${pairs.map((x) => personRow(x.other, `<div class="note">${esc(x.note)}</div>`)).join('')}</div>` : ''}
      <h3 class="section">Similar faces</h3>
      ${filterBar()}
      <div class="list">${looks.length ? looks.map((r) => personRow(r.pi)).join('') : '<p class="empty">No one with these filters.</p>'}</div>`;
  } else {
    body = '<p class="loading">Matching…</p>';
  }
  $view.innerHTML = `
    <div class="photo-wrap"><canvas id="photo"></canvas>${boxes}</div>
    ${body}
    <div class="btn-row" style="margin-top:18px"><button class="btn secondary" id="again">Try another photo</button></div>`;
  const c = $view.querySelector('#photo');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  for (const b of $view.querySelectorAll('[data-face]')) {
    b.onclick = async () => {
      await chooseFace(Number(b.dataset.face));
      $view.querySelector('.best')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  $view.querySelector('#again').onclick = () => $file.click();
  wireFilters(renderFace);
  fixThumbs($view);
}

async function renderPerson(id) {
  const pi = S.byId.get(id);
  if (pi === undefined) { $view.innerHTML = '<p class="empty">Not found.</p>'; return; }
  const p = S.people[pi];
  const pairs = S.pairsBy.get(pi) || [];
  const { same, similar } = searchNames(S.names, p.n, { limit: 30 });
  const nameAlikes = [...same, ...similar].filter((r) => r.pi !== pi && passesCat(S.people[r.pi]) && passesFame(S.people[r.pi])).slice(0, 8);
  const title = p.t || p.n;
  $view.innerHTML = `
    <button class="back" id="back">‹ Back</button>
    <div class="hero">
      ${avatar(p, 156, 'hero')}
      <h1>${esc(p.n)}</h1>
      <p class="line">${esc(p.d)}</p>
      ${chips(p)}
    </div>
    <div class="extract" id="extract"><span class="muted">Loading summary…</span></div>
    ${pairs.length ? `<h3 class="section">Often mistaken for</h3><div class="list">${pairs.map((x) => personRow(x.other, `<div class="note">${esc(x.note)}</div>`)).join('')}</div>` : ''}
    <div id="face-alikes">${p.v !== undefined ? '<h3 class="section">Similar faces</h3><p class="loading">Loading…</p>' : ''}</div>
    ${nameAlikes.length ? `<h3 class="section">Similar names</h3><div class="list">${nameAlikes.map((r) => personRow(r.pi)).join('')}</div>` : ''}`;
  $view.querySelector('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
  fixThumbs($view);
  window.scrollTo(0, 0);

  // Wikipedia summary (text only; works offline from the one-line description).
  fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((s) => {
      const el = document.getElementById('extract');
      if (el && location.hash === `#/p/${id}`) el.innerHTML = `${esc(s.extract)} <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipedia ›</a>`;
    })
    .catch(() => {
      const el = document.getElementById('extract');
      if (el) el.innerHTML = `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}" target="_blank" rel="noopener">Read about ${esc(p.n)} on Wikipedia ›</a>`;
    });

  if (p.v !== undefined) {
    const draw = async () => {
      await loadFaces();
      const box = document.getElementById('face-alikes');
      if (!box || location.hash !== `#/p/${id}`) return;
      const looks = faceRank(rowVector(S.vectors, S.invNorms, p.v), { exclude: pi, k: LOOKALIKES });
      box.innerHTML = `<h3 class="section">Similar faces</h3>${filterBar()}
        <div class="list">${looks.length ? looks.map((r) => personRow(r.pi)).join('') : '<p class="empty">No one with these filters.</p>'}</div>`;
      wireFilters(draw);
      fixThumbs(box);
    };
    draw().catch((e) => console.error(e));
  }
}

function renderAbout() {
  const m = S.manifest;
  $view.innerHTML = `<div class="about">
    <button class="back" onclick="history.back()">‹ Back</button>
    <h1>About Who's That?</h1>
    <p>For when a face or a name looks familiar and you can't place it — or you're mixing two people up.</p>
    <ul>
      <li><b>Private:</b> photos are checked on this phone and never uploaded.</li>
      <li><b>Who's included:</b> ${m ? m.count.toLocaleString() : ''} public figures with a Wikipedia article; ${m ? m.faces.toLocaleString() : ''} of them have a free-licence photo, so they can be matched by face.</li>
      <li><b>Not perfect:</b> face matching is a best guess, especially from a photo of a TV screen. The lookalike list is there for that.</li>
    </ul>
    <h3 class="section">Credits</h3>
    <p class="muted">People, descriptions and photos: Wikipedia and Wikimedia Commons (CC BY-SA and other free licences; each photo's licence is on its Commons page) and Wikidata (CC0). Face detection: YuNet (MIT). Face matching: SFace (Apache 2.0), both from the OpenCV model zoo. Runtime: ONNX Runtime Web (MIT). Name matching: double-metaphone (MIT).</p>
    <p class="muted">Index built ${m ? new Date(m.built).toLocaleDateString() : ''}.</p>
  </div>`;
}

// Self-check: how fast is face matching on this phone, and does it produce
// the same fingerprint as the build for a known photo?
async function renderCheck() {
  $view.innerHTML = '<h1>Phone check</h1><p class="loading" id="chk">Running…</p>';
  const out = [];
  const show = (html) => { document.getElementById('chk').outerHTML = `<div id="chk">${html}</div>`; };
  try {
    const t0 = performance.now();
    await loadFaces();
    const tLoad = performance.now() - t0;
    const ref = await (await fetch('data/check.json', { cache: 'no-cache' })).json();
    const blob = await (await fetch(thumbUrl(ref.file, 500))).blob();
    const img = await fileToImage(blob);
    const t1 = performance.now();
    const faces = await S.engine.detect(img);
    const best = faces.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
    const vec = await S.engine.embed(img, best);
    const tFace = performance.now() - t1;
    let cos = 0;
    for (let i = 0; i < vec.length; i++) cos += vec[i] * ref.vec[i];
    const ok = cos >= 0.99;
    out.push(`<p style="font-size:22px;font-weight:700;color:var(${ok ? '--good' : '--accent'})">${ok ? '✓ Same result as the build' : '✗ Different from the build'} (${cos.toFixed(4)})</p>`);
    out.push(`<ul><li>Face matcher ready in ${(tLoad / 1000).toFixed(1)} s${S.engine && tLoad < 50 ? ' (already loaded)' : ''}</li>`);
    out.push(`<li>One photo checked in ${(tFace / 1000).toFixed(2)} s</li>`);
    out.push(`<li>${S.people.length.toLocaleString()} people, ${S.manifest.faces.toLocaleString()} faces</li>`);
    out.push(`<li>People list loaded in ${(timings.peopleLoad / 1000).toFixed(1)} s; name search ready in ${(timings.nameIndex / 1000).toFixed(1)} s more</li>`);
    const tq = performance.now();
    for (const q of ['will farrel', 'josh allen', 'matt rule', 'taylor']) searchNames(S.names, q);
    out.push(`<li>Name search: ${((performance.now() - tq) / 4).toFixed(0)} ms per search</li>`);
    out.push(`<li>Offline cache: ${navigator.serviceWorker?.controller ? 'on' : 'not yet (reopen the app once)'}</li>`);
    out.push(`<li class="muted">${esc(navigator.userAgent)}</li></ul>`);
    show(out.join(''));
  } catch (e) {
    show(`<p class="err">Check failed: ${esc(e.message)}</p>`);
  }
}

async function pasteImage() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) return handlePhoto(await it.getType(type));
    }
    alert('No picture on the clipboard. Copy a screenshot or photo first.');
  } catch {
    alert('Pasting isn’t available here. Use “Take or choose a photo” instead.');
  }
}

// ---------- routing ----------

async function route() {
  const h = location.hash || '#/';
  if (!S.names && h !== '#/' && h !== '#/face') {
    $view.innerHTML = '<p class="loading">Loading…</p>';
    await peopleReady;
  }
  if (h.startsWith('#/p/')) return renderPerson(decodeURIComponent(h.slice(4)));
  if (h === '#/face') return renderFace();
  if (h === '#/about') return renderAbout();
  if (h === '#/check') return renderCheck();
  return renderHome();
}

$file.onchange = () => {
  const f = $file.files?.[0];
  $file.value = '';
  if (f) handlePhoto(f);
};
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f && document.activeElement?.id !== 'q') handlePhoto(f);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) handlePhoto(f);
});
window.addEventListener('hashchange', route);

// The home screen shows at once; the 100k-name list loads and is indexed in
// the background (a few seconds on a phone), and views that need it wait.
let peopleReady;
(async () => {
  try {
    await loadManifest();
  } catch (e) {
    $view.innerHTML = `<p class="empty err">Couldn't load the app's data. Check your connection and reload.</p>`;
    return;
  }
  peopleReady = new Promise((resolve) => setTimeout(resolve, 50)).then(loadPeople);
  peopleReady.catch(() => {
    $view.innerHTML = `<p class="empty err">Couldn't load the list of people. Check your connection and reload.</p>`;
  });
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// For testing in the browser console.
window.__wt = { S, faceRank, handlePhoto };
