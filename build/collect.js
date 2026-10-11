// Step 1 of the build: decide who is in the index and gather their text.
// Usage: node build/collect.js [profile]   (profile: step0 | full)
// Writes build/out/people.json.
import fs from 'node:fs';
import path from 'node:path';
import { GROUPS, STEP0_FORCED, MIN_BIRTH_YEAR, fameScore } from './config.js';
import { byOccupation, byLeague, byTeams, details } from './sources/wikidata.js';
import { pageInfo, extracts, categoryMembers } from './sources/wikipedia.js';
import { knownFor, primaryKind } from './knownfor.js';
import { displayName } from '../shared/names.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const CACHE = path.join(ROOT, 'build/cache');

// Local re-runs reuse lookups younger than a week (CI starts empty).
const MAX_AGE = 7 * 24 * 3600 * 1000;
function cached(name) {
  const file = path.join(CACHE, `${name}.json`);
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const fresh = (k) => store[k] && Date.now() - store[k].at < MAX_AGE;
  return {
    missing: (keys) => keys.filter((k) => !fresh(k)),
    get: (k) => store[k]?.v,
    set: (k, v) => { store[k] = { at: Date.now(), v }; },
    save: () => { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify(store)); },
  };
}
const profile = process.argv[2] || 'step0';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 1. Candidates, keyed by Wikipedia title.
const cands = new Map();
const touch = (title) => {
  let c = cands.get(title);
  if (!c) cands.set(title, (c = { groups: new Set(), nebraska: new Set(), leagues: new Set() }));
  return c;
};

for (const g of GROUPS) {
  const lim = g[profile];
  if (!lim) continue;
  let rows = [];
  if (g.occupations) rows = await byOccupation(g.occupations, lim);
  else if (g.league) rows = await byLeague(g.league, lim);
  else if (g.teams) rows = await byTeams(g.teams, lim);
  for (const r of rows) {
    const c = touch(r.title);
    c.groups.add(g.key);
    if (g.league) c.leagues.add(g.league);
  }
  for (const [team, label] of g.labelledTeams || []) {
    const members = await byTeams([team]);
    for (const r of members) {
      const c = touch(r.title);
      c.groups.add(g.key);
      c.nebraska.add(label);
    }
    log(`  ${label} (Wikidata): ${members.length}`);
  }
  if (g.categories) {
    for (const [cat, label] of g.categories) {
      const titles = await categoryMembers(cat);
      for (const t of titles) {
        const c = touch(t);
        c.groups.add(g.key);
        c.nebraska.add(label);
      }
      log(`  ${cat}: ${titles.length}`);
    }
  }
  log(`${g.key}: ${rows.length || ''} candidates (total ${cands.size})`);
}
// Everyone named in an "often mistaken for" pair is always included.
const pairNames = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mistaken-for.json'), 'utf8')).pairs.flatMap((p) => [p.a, p.b]);
const forced = [...(profile === 'step0' ? STEP0_FORCED : []), ...pairNames];
for (const t of forced) touch(t).groups.add('forced');

// 2. Pageviews, descriptions and Wikidata IDs; merge redirects by Wikidata ID.
const piCache = cached('pageinfo');
const needInfo = piCache.missing([...cands.keys()]);
log(`page info for ${cands.size} titles (${needInfo.length} to fetch)…`);
const fetched = await pageInfo(needInfo);
for (const t of needInfo) piCache.set(t, fetched.get(t) || null);
piCache.save();
const info = new Map([...cands.keys()].map((t) => [t, piCache.get(t)]).filter(([, v]) => v));
const people = new Map();
for (const [t, c] of cands) {
  const i = info.get(t);
  if (!i || !i.qid || i.disambig) continue;
  let p = people.get(i.qid);
  if (!p) people.set(i.qid, (p = { ...i, groups: new Set(), nebraska: new Set(), leagues: new Set() }));
  c.groups.forEach((x) => p.groups.add(x));
  c.nebraska.forEach((x) => p.nebraska.add(x));
  c.leagues.forEach((x) => p.leagues.add(x));
}
log(`${people.size} distinct people`);

// 3. Keep the most-viewed of each group (plus everyone forced or Nebraska).
const selected = new Set();
for (const g of GROUPS) {
  const lim = g[profile];
  if (!lim) continue;
  const members = [...people.values()].filter((p) => p.groups.has(g.key)).sort((a, b) => b.views60 - a.views60);
  // Ignore people whose description isn't about entertainment or sport
  // (e.g. politicians who once appeared in a film).
  const relevant = members.filter((p) => g.key === 'nebraska' || /actor|actress|comedian|presenter|host|anchor|broadcaster|commentator|personality|singer|rapper|musician|drummer|guitarist|bassist|songwriter|band|player|coach|athlete|football|basketball|baseball|hockey|soccer|quarterback/i.test(p.desc));
  relevant.slice(0, lim.keep).forEach((p) => selected.add(p.qid));
}
for (const p of people.values()) if (p.groups.has('forced')) selected.add(p.qid);
log(`${selected.size} selected`);

// 4. Wikidata facts (photos, nicknames, teams, bands, films) and lead text.
const dCache = cached('details');
const needDet = dCache.missing([...selected]);
const detFetched = needDet.length ? await details(needDet) : new Map();
for (const q of needDet) dCache.set(q, detFetched.get(q));
dCache.save();
const det = new Map([...selected].map((q) => [q, dCache.get(q)]));
const sel = [...selected].map((q) => people.get(q));
const xCache = cached('extracts');
const needX = xCache.missing(sel.map((p) => p.title));
const xFetched = await extracts(needX, 2);
for (const t of needX) xCache.set(t, xFetched.get(t) || '');
xCache.save();
const ext = new Map(sel.map((p) => [p.title, xCache.get(p.title)]));
log('details and extracts fetched');

const out = [];
let dropped = 0;
for (const p of sel) {
  const d = det.get(p.qid);
  if (!d?.human || (d.born && d.born < MIN_BIRTH_YEAR)) {
    dropped++;
    continue;
  }
  const extract = ext.get(p.title) || '';
  const kf = knownFor({ desc: p.desc, extract, details: d, tags: p.groups, leagues: p.leagues, nebraskaLabels: [...p.nebraska] });
  let cats = 0;
  for (const g of GROUPS) if (p.groups.has(g.key)) cats |= g.cat;
  // Forced people get their filter bits from what they're known for.
  if (!cats) cats = { screen: 1, music: 2, sport: 4 }[primaryKind(p.desc, p.groups)] || 0;
  const images = [...new Set([...d.images, p.pageimage].filter(Boolean))];
  const name = displayName(p.title);
  out.push({
    id: p.qid,
    title: p.title,
    name,
    aliases: [...new Set(d.aliases.filter((a) => a !== name && a.length <= 40))].slice(0, 8),
    desc: p.desc,
    line: kf.line,
    chips: kf.chips,
    kind: kf.kind,
    extract,
    cats,
    groups: [...p.groups],
    views60: p.views60,
    fame: Number(fameScore(p.views60).toFixed(3)),
    born: d.born,
    died: d.died,
    images,
  });
}
out.sort((a, b) => b.views60 - a.views60);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(out, null, 1));
log(`wrote ${out.length} people (${dropped} dropped: not a person or born before ${MIN_BIRTH_YEAR}); ${out.filter((p) => p.images.length).length} have a free photo`);
