// Step 1 of the build: decide who is in the index and gather their text.
// Usage: node build/collect.js [profile]   (profile: full | step0)
// Writes build/out/people.json.
//
// 1. Candidates: Wikidata lists (occupations, leagues, teams) and Wikipedia
//    categories (college programs, Nebraska).
// 2. Fame: average daily views from Wikimedia's pageview dumps.
// 3. Keep each group's people above its fame bar.
// 4. Page info (Wikidata ID, short description, free lead image) for those kept.
// 5. Wikidata facts: photos, nicknames, teams, bands, films.
// 6. Lead sentences for the most-viewed people (the "known for" line).
import fs from 'node:fs';
import path from 'node:path';
import { GROUPS, STEP0_FORCED, MIN_BIRTH_YEAR, EXTRACT_TOP, fameScore } from './config.js';
import { byOccupation, byLeague, byTeams, details } from './sources/wikidata.js';
import { pageInfo, extracts, categoryMembers } from './sources/wikipedia.js';
import { dailyViews } from './sources/pageviews.js';
import { knownFor, primaryKind } from './knownfor.js';
import { displayName } from '../shared/names.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build/out');
const CACHE = path.join(ROOT, 'build/cache');
fs.mkdirSync(CACHE, { recursive: true });
const profile = process.argv[2] || 'full';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY = 24 * 3600 * 1000;

// Lookup caches (kept between runs; CI restores them from a release asset).
function cached(name, maxAgeDays) {
  const file = path.join(CACHE, `${name}.json`);
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const fresh = (k) => store[k] && Date.now() - store[k].at < maxAgeDays * DAY;
  return {
    missing: (keys) => keys.filter((k) => !fresh(k)),
    get: (k) => store[k]?.v,
    set: (k, v) => { store[k] = { at: Date.now(), v }; },
    save: () => fs.writeFileSync(file, JSON.stringify(store)),
  };
}

// ---------- 1. candidates ----------
const cands = new Map(); // title -> { groups, labels, leagues }
const touch = (title) => {
  let c = cands.get(title);
  if (!c) cands.set(title, (c = { groups: new Set(), labels: new Set(), leagues: new Set() }));
  return c;
};
const catCache = cached('categories', 25);
for (const g of GROUPS) {
  const lim = g[profile];
  if (!lim) continue;
  let rows = [];
  if (g.occupations) rows = await byOccupation(g.occupations, { minSitelinks: lim.minSitelinks || 0 });
  else if (g.league) rows = await byLeague(g.league, { minSitelinks: lim.minSitelinks || 0 });
  else if (g.teams) rows = await byTeams(g.teams);
  for (const r of rows) {
    const c = touch(r.title);
    c.groups.add(g.key);
    if (g.league) c.leagues.add(g.league);
  }
  for (const [team, label] of g.labelledTeams || []) {
    for (const r of await byTeams([team])) {
      const c = touch(r.title);
      c.groups.add(g.key);
      c.labels.add(label);
    }
  }
  let catPages = 0;
  for (const [cat, label] of g.categories || []) {
    if (catCache.missing([cat]).length) catCache.set(cat, await categoryMembers(cat));
    const titles = catCache.get(cat);
    catPages += titles.length;
    for (const t of titles) {
      const c = touch(t);
      c.groups.add(g.key);
      c.labels.add(label);
    }
  }
  catCache.save();
  log(`${g.key}: ${(rows.length + catPages).toLocaleString()} candidates (total ${cands.size.toLocaleString()})`);
}
// Everyone named in an "often mistaken for" pair is always included.
const pairNames = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mistaken-for.json'), 'utf8')).pairs.flatMap((p) => [p.a, p.b]);
const forced = [...(profile === 'step0' ? STEP0_FORCED : []), ...pairNames];
for (const t of forced) touch(t).groups.add('forced');

// ---------- 2. fame from pageview dumps ----------
log(`pageviews for ${cands.size.toLocaleString()} titles from the daily dumps…`);
const { avg, days } = await dailyViews([...cands.keys()], { cacheDir: CACHE, log });
const views60 = (t) => Math.round((avg.get(t) || 0) * 60);

// ---------- 3. keep each group's people above its bar ----------
const keepTitles = new Set(forced);
for (const g of GROUPS) {
  const lim = g[profile];
  if (!lim) continue;
  const members = [...cands].filter(([, c]) => c.groups.has(g.key)).map(([t]) => t).sort((a, b) => views60(b) - views60(a));
  const kept = lim.minViews60 !== undefined ? members.filter((t) => views60(t) >= lim.minViews60) : members.slice(0, lim.keep * 3);
  kept.forEach((t) => keepTitles.add(t));
  log(`  ${g.key}: ${kept.length.toLocaleString()} of ${members.length.toLocaleString()} kept`);
}

// ---------- 4. page info; merge redirects by Wikidata ID ----------
const piCache = cached('pageinfo', 30);
const needInfo = piCache.missing([...keepTitles]);
log(`page info for ${keepTitles.size.toLocaleString()} titles (${needInfo.length.toLocaleString()} to fetch)…`);
const fetched = await pageInfo(needInfo);
for (const t of needInfo) piCache.set(t, fetched.get(t) || null);
piCache.save();

const people = new Map();
for (const t of keepTitles) {
  const i = piCache.get(t);
  const c = cands.get(t);
  if (!i || !i.qid || i.disambig || !c) continue;
  let p = people.get(i.qid);
  if (!p) people.set(i.qid, (p = { ...i, views60: 0, groups: new Set(), labels: new Set(), leagues: new Set() }));
  p.views60 = Math.max(p.views60, views60(t), views60(i.title));
  c.groups.forEach((x) => p.groups.add(x));
  c.labels.forEach((x) => p.labels.add(x));
  c.leagues.forEach((x) => p.leagues.add(x));
}

// Occupation lists include people famous for something else (e.g. politicians
// who once appeared in a film); keep those whose description fits.
const FITS = /actor|actress|comedian|presenter|host|anchor|broadcaster|commentator|personality|journalist|singer|rapper|musician|drummer|guitarist|bassist|songwriter|band|DJ|producer|player|coach|athlete|football|basketball|baseball|hockey|soccer|quarterback|pitcher|volleyball/i;
const OCCUPATION_GROUPS = new Set(GROUPS.filter((g) => g.occupations).map((g) => g.key));
const selected = [];
for (const p of people.values()) {
  const onlyOccupation = [...p.groups].every((g) => OCCUPATION_GROUPS.has(g));
  if (onlyOccupation && !FITS.test(p.desc)) continue;
  if (profile === 'step0' && !p.groups.has('forced')) {
    // Step 0: the top N of each group.
    const ok = GROUPS.some((g) => g.step0 && p.groups.has(g.key));
    if (!ok) continue;
  }
  selected.push(p);
}
if (profile === 'step0') {
  const keep = new Set();
  for (const g of GROUPS) {
    if (!g.step0) continue;
    selected.filter((p) => p.groups.has(g.key)).sort((a, b) => b.views60 - a.views60).slice(0, g.step0.keep).forEach((p) => keep.add(p.qid));
  }
  for (const p of selected) if (p.groups.has('forced')) keep.add(p.qid);
  selected.splice(0, selected.length, ...selected.filter((p) => keep.has(p.qid)));
}
selected.sort((a, b) => b.views60 - a.views60);
log(`${selected.length.toLocaleString()} people selected`);

// ---------- 5. Wikidata facts ----------
const inGroups = (keys) => new Set(selected.filter((p) => keys.some((k) => p.groups.has(k))).map((p) => p.qid));
const sportKeys = GROUPS.filter((g) => g.cat & 12 || g.league || g.teams).map((g) => g.key);
const dCache = cached('details', 30);
const needDet = dCache.missing(selected.map((p) => p.qid));
log(`Wikidata facts for ${selected.length.toLocaleString()} people (${needDet.length.toLocaleString()} to fetch)…`);
if (needDet.length) {
  const fetchedDet = await details(needDet, {
    sport: inGroups([...sportKeys, 'forced']),
    music: inGroups(['music', 'forced']),
    screen: inGroups(['screen', 'hosts', 'forced']),
    log,
  });
  for (const q of needDet) dCache.set(q, fetchedDet.get(q));
  dCache.save();
}

// ---------- 6. lead sentences for the most-viewed ----------
const extractFor = selected.filter((p, i) => i < EXTRACT_TOP[profile] || p.groups.has('nebraska') || p.groups.has('forced'));
const xCache = cached('extracts', 120);
const needX = xCache.missing(extractFor.map((p) => p.title));
log(`lead sentences for ${extractFor.length.toLocaleString()} people (${needX.length.toLocaleString()} to fetch)…`);
const xFetched = await extracts(needX, 2);
for (const t of needX) xCache.set(t, xFetched.get(t) || '');
xCache.save();

// ---------- output ----------
const out = [];
let dropped = 0;
for (const p of selected) {
  const d = dCache.get(p.qid);
  if (!d?.human || (d.born && d.born < MIN_BIRTH_YEAR)) {
    dropped++;
    continue;
  }
  const extract = xCache.get(p.title) || '';
  const kf = knownFor({ desc: p.desc, extract, details: d, tags: p.groups, leagues: p.leagues, labels: [...p.labels] });
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
    aliases: [...new Set(d.aliases.filter((a) => a !== name && a.length <= 32))].slice(0, 5),
    desc: p.desc,
    line: kf.line,
    chips: kf.chips,
    kind: kf.kind,
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
fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(out));
fs.writeFileSync(path.join(OUT, 'collect.json'), JSON.stringify({ profile, pageviewDays: days, candidates: cands.size, people: out.length }));
log(`wrote ${out.length.toLocaleString()} people (${dropped.toLocaleString()} dropped: not a person or born before ${MIN_BIRTH_YEAR}); ${out.filter((p) => p.images.length).length.toLocaleString()} have a free photo`);
