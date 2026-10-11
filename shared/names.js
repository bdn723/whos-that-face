// Name matching for "Why do I recognize that name?", in plain JS.
// Runs in the browser and in Node (tests). Finds:
//   - people with the same name (or a nickname/alias equal to it), and
//   - people whose names sound or look similar (Will Ferrell ~ Colin Farrell).
import { doubleMetaphone } from 'double-metaphone';

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

const NON_ASCII = /[^\x00-\x7f]/;
export function normalize(s) {
  // Accent-stripping is slow, so only do it when there's something to strip.
  const x = NON_ASCII.test(s) ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  return x.toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Words that carry the name, without Jr./III etc.
export function tokens(s) {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !SUFFIXES.has(t));
}

// Wikipedia titles like "Chris Evans (actor)" -> "Chris Evans".
export function displayName(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, '');
}

const phoneCache = new Map();
export function phonetic(token) {
  let p = phoneCache.get(token);
  if (!p) {
    const [a, b] = doubleMetaphone(token);
    p = a === b ? [a] : [a, b];
    phoneCache.set(token, p);
  }
  return p;
}

// Restricted Damerau-Levenshtein (optimal string alignment) distance.
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

// How alike two name words are, 0..1.
export function tokenSimilarity(q, c) {
  if (q === c) return 1;
  const pq = phonetic(q);
  const pc = phonetic(c);
  const soundAlike = pq.some((x) => x && pc.includes(x));
  const d = editDistance(q, c);
  const spell = 1 - d / Math.max(q.length, c.length);
  // Nickname-style prefixes: "Will" ~ "William", "Chris" ~ "Christopher".
  const prefix = q.length >= 3 && c.length > q.length && c.startsWith(q) ? 0.85 : 0;
  return Math.max(soundAlike ? 0.9 : 0, spell, prefix);
}

// Score how alike a typed name is to a candidate name, 0..1.
// The last word (surname) counts double; missing words are penalised.
export function nameSimilarity(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const n = qTokens.length;
  let total = 0;
  let weightSum = 0;
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1 && n > 1;
    const w = isLast ? 2 : 1;
    // Align by position first (first->first, last->last), else best match.
    const pos = isLast ? cTokens.length - 1 : Math.min(i, cTokens.length - 1);
    let best = used.has(pos) ? 0 : tokenSimilarity(qTokens[i], cTokens[pos]);
    let bestJ = pos;
    for (let j = 0; j < cTokens.length; j++) {
      if (used.has(j)) continue;
      const s = tokenSimilarity(qTokens[i], cTokens[j]) - (j === pos || n === 1 ? 0 : 0.2);
      if (s > best) { best = s; bestJ = j; }
    }
    used.add(bestJ);
    total += w * best;
    weightSum += w;
  }
  const extra = Math.max(0, cTokens.length - n);
  return (total / weightSum) * Math.pow(0.92, extra);
}

// Build the in-memory search structures from the people list.
// Each person: { n: display name, a: [aliases], f: fame 0..1 }.
// Entries are one per (person, name variant), stored in parallel arrays.
export function buildNameIndex(people) {
  const ePerson = [];
  const eNorm = [];
  const eToks = [];
  const byPhone = new Map(); // phonetic code -> entry ids
  const byFirst = new Map(); // first letter -> flat [token, entry id, ...]
  for (let pi = 0; pi < people.length; pi++) {
    const p = people[pi];
    const seen = [];
    const variants = p.a ? [p.n, ...p.a] : [p.n];
    for (const v of variants) {
      const toks = normalize(v).split(' ').filter((t) => t && !SUFFIXES.has(t));
      if (!toks.length) continue;
      const norm = toks.join(' ');
      if (seen.includes(norm)) continue;
      seen.push(norm);
      const id = ePerson.length;
      ePerson.push(pi);
      eNorm.push(norm);
      eToks.push(toks);
      for (const t of toks) {
        for (const code of phonetic(t)) {
          if (!code) continue;
          const arr = byPhone.get(code);
          if (arr) arr.push(id);
          else byPhone.set(code, [id]);
        }
        const f = byFirst.get(t[0]);
        if (f) f.push(t, id);
        else byFirst.set(t[0], [t, id]);
      }
    }
  }
  // Entry ids sorted by normalized name, for prefix lookups while typing.
  const sorted = Int32Array.from(eNorm.keys()).sort((a, b) => (eNorm[a] < eNorm[b] ? -1 : eNorm[a] > eNorm[b] ? 1 : 0));
  return { people, ePerson, eNorm, eToks, byPhone, byFirst, sorted };
}

// Entry ids whose normalized name starts with `prefix` (binary search).
function prefixIds(index, prefix, max = 200) {
  const { sorted, eNorm } = index;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eNorm[sorted[mid]] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < sorted.length && out.length < max && eNorm[sorted[i]].startsWith(prefix); i++) out.push(sorted[i]);
  return out;
}

// Search. Returns { same: [...], similar: [...] } of { pi: person index, score }.
export function searchNames(index, query, { limit = 15, minScore = 0.65, fameWeight = 0.15 } = {}) {
  const qTokens = tokens(query);
  if (!qTokens.length) return { same: [], similar: [] };
  const qNorm = qTokens.join(' ');
  const cand = new Set();
  // Sound-alike words (the surname matters most, so use every word).
  for (const t of qTokens) for (const code of phonetic(t)) for (const id of index.byPhone.get(code) || []) cand.add(id);
  // Typing in progress ("patrick mah").
  for (const id of prefixIds(index, qNorm)) cand.add(id);
  // Small spelling slips in the surname: same first letter, similar length.
  const last = qTokens[qTokens.length - 1];
  if (last.length >= 4) {
    const list = index.byFirst.get(last[0]) || [];
    for (let i = 0; i < list.length; i += 2) {
      const t = list[i];
      if (t !== last && Math.abs(t.length - last.length) <= 2 && editDistance(t, last) <= 2) cand.add(list[i + 1]);
    }
  }

  const best = new Map(); // person -> { s, exact }
  for (const id of cand) {
    const norm = index.eNorm[id];
    const exact = norm === qNorm;
    const prefix = !exact && qNorm.length >= 3 && norm.startsWith(qNorm);
    let s = exact ? 1 : nameSimilarity(qTokens, index.eToks[id]);
    if (prefix) s = Math.max(s, 0.8);
    const pi = index.ePerson[id];
    const prev = best.get(pi);
    if (!prev || s > prev.s || (exact && !prev.exact)) best.set(pi, { s, exact: exact || prev?.exact || false });
  }
  const fame = (pi) => index.people[pi].f || 0;
  const same = [];
  const similar = [];
  for (const [pi, { s, exact }] of best) {
    if (exact) same.push({ pi, score: 1 + fame(pi) });
    else if (s >= minScore) similar.push({ pi, score: s + fameWeight * fame(pi) });
  }
  same.sort((a, b) => b.score - a.score);
  similar.sort((a, b) => b.score - a.score);
  return { same, similar: similar.slice(0, limit) };
}
