// Name matching for "Why do I recognize that name?", in plain JS.
// Runs in the browser and in Node (tests). Finds:
//   - people with the same name (or a nickname/alias equal to it), and
//   - people whose names sound or look similar (Will Ferrell ~ Colin Farrell).
import { doubleMetaphone } from 'double-metaphone';

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

export function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
      const s = tokenSimilarity(qTokens[i], cTokens[j]) - (j === pos ? 0 : 0.1);
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
export function buildNameIndex(people) {
  const entries = []; // one per (person, name variant)
  const byPhone = new Map(); // phonetic code -> entry ids
  people.forEach((p, pi) => {
    const variants = new Set([p.n, ...(p.a || [])].map((v) => tokens(v).join(' ')).filter(Boolean));
    for (const v of variants) {
      const toks = v.split(' ');
      const id = entries.length;
      entries.push({ pi, norm: v, toks });
      for (const t of toks) {
        for (const code of phonetic(t)) {
          if (!code) continue;
          let arr = byPhone.get(code);
          if (!arr) byPhone.set(code, (arr = []));
          arr.push(id);
        }
      }
    }
  });
  return { people, entries, byPhone };
}

// Search. Returns { same: [...], similar: [...] } of { person index, score }.
export function searchNames(index, query, { limit = 15, minScore = 0.65, fameWeight = 0.08 } = {}) {
  const qTokens = tokens(query);
  if (!qTokens.length) return { same: [], similar: [] };
  const qNorm = qTokens.join(' ');
  const cand = new Set();
  // Sound-alike words (the surname matters most, so use every word).
  for (const t of qTokens) for (const code of phonetic(t)) for (const id of index.byPhone.get(code) || []) cand.add(id);
  // Prefix typing ("patrick mah") and small spelling slips in the surname.
  const last = qTokens[qTokens.length - 1];
  index.entries.forEach((e, id) => {
    if (cand.has(id)) return;
    if (e.norm.startsWith(qNorm)) cand.add(id);
    else if (last.length >= 4 && e.toks.some((t) => Math.abs(t.length - last.length) <= 2 && t[0] === last[0] && editDistance(t, last) <= 2)) cand.add(id);
  });

  const best = new Map(); // person -> { score, exact }
  for (const id of cand) {
    const e = index.entries[id];
    const exact = e.norm === qNorm;
    const prefix = !exact && e.norm.startsWith(qNorm) && qNorm.length >= 3;
    let s = exact ? 1 : nameSimilarity(qTokens, e.toks);
    if (prefix) s = Math.max(s, 0.8);
    const prev = best.get(e.pi);
    if (!prev || s > prev.s || (exact && !prev.exact)) best.set(e.pi, { s, exact: exact || prev?.exact || false });
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
