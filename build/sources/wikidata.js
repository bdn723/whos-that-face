// Wikidata SPARQL helpers. Wikidata content is CC0.
//
// Two endpoints:
// - QLever (University of Freiburg), a fast Wikidata mirror, for the big
//   people lists (78k actors take seconds there but run past the official
//   service's 60 s limit).
// - The official query service for the small per-person batches, where it is
//   quick and authoritative.
// Each falls back to the other.
import { postFormJson, chunk } from '../lib/http.js';

const QLEVER = 'https://qlever.dev/api/wikidata';
const WDQS = 'https://query.wikidata.org/sparql';
const ENWIKI = '<https://en.wikipedia.org/>';
const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

const qidOf = (uri) => uri.replace('http://www.wikidata.org/entity/', '');

export async function sparql(query, { tries = 2, prefer = 'wdqs' } = {}) {
  const t0 = Date.now();
  let r;
  let lastErr;
  const endpoints = prefer === 'qlever' ? [QLEVER, WDQS] : [WDQS, QLEVER];
  outer: for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        // A query that hits a time limit can come back as truncated JSON.
        r = await postFormJson(endpoint, { query: PREFIXES + query });
        if (r?.results?.bindings) break outer;
        throw new Error('no results object');
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 3000 * attempt));
      }
    }
    console.warn(`  ${endpoint} failed (${lastErr.message.slice(0, 100)}); trying next endpoint`);
  }
  const secs = (Date.now() - t0) / 1000;
  if (secs > 10) console.log(`  slow SPARQL (${secs.toFixed(0)} s): ${query.replace(/\s+/g, ' ').slice(0, 140)}`);
  if (!r?.results?.bindings) throw new Error(`SPARQL failed (${lastErr?.message.slice(0, 120)}): ${query.replace(/\s+/g, ' ').slice(0, 300)}`);
  return r.results.bindings.map((b) => {
    const o = {};
    for (const [k, v] of Object.entries(b)) o[k] = v.type === 'uri' ? qidOf(v.value) : v.value;
    return o;
  });
}

const values = (ids) => ids.map((q) => `wd:${q}`).join(' ');

// Pool queries return every match with its sitelink count; filtering happens
// here, not in SPARQL, because QLever intermittently returns zero rows for
// queries with a FILTER on wikibase:sitelinks (seen 11 Oct 2026). An empty
// pool is treated as a failure.
async function pool(query, minSitelinks, what) {
  let rows = await sparql(query, { prefer: 'qlever' });
  if (rows.length === 0) {
    console.warn(`  ${what}: empty result, retrying`);
    rows = await sparql(query, { prefer: 'qlever' });
  }
  if (rows.length === 0) throw new Error(`${what}: query returned no people`);
  const best = new Map();
  for (const r of rows) {
    r.sl = Number(r.sl || 0);
    if (r.sl >= minSitelinks && !best.has(r.p)) best.set(r.p, r);
  }
  return [...best.values()];
}

// People with an English Wikipedia article and one of these occupations,
// one query per occupation (big combined queries time out).
export async function byOccupation(occupations, { minSitelinks = 0 } = {}) {
  const seen = new Map();
  for (const occ of occupations) {
    const rows = await pool(`
      SELECT ?p ?title ?sl WHERE {
        ?p wdt:P106 wd:${occ} .
        ?article schema:about ?p ; schema:isPartOf ${ENWIKI} ; schema:name ?title .
        OPTIONAL { ?p wikibase:sitelinks ?sl }
      }`, minSitelinks, `occupation ${occ}`);
    for (const r of rows) seen.set(r.p, r);
  }
  return [...seen.values()];
}

// Players (member of a team in the league) and head coaches of league teams.
export async function byLeague(league, { minSitelinks = 0 } = {}) {
  return pool(`
    SELECT ?p ?title ?sl WHERE {
      ?team wdt:P118 wd:${league} .
      { ?p wdt:P54 ?team } UNION { ?team wdt:P286 ?p }
      ?p wdt:P31 wd:Q5 .
      ?article schema:about ?p ; schema:isPartOf ${ENWIKI} ; schema:name ?title .
      OPTIONAL { ?p wikibase:sitelinks ?sl }
    }`, minSitelinks, `league ${league}`);
}

// Members (and head coaches) of specific teams, e.g. national teams.
export async function byTeams(teams, { minSitelinks = 0 } = {}) {
  return pool(`
    SELECT ?p ?title ?sl WHERE {
      VALUES ?team { ${values(teams)} }
      { ?p wdt:P54 ?team } UNION { ?team wdt:P286 ?p }
      ?p wdt:P31 wd:Q5 .
      ?article schema:about ?p ; schema:isPartOf ${ENWIKI} ; schema:name ?title .
      OPTIONAL { ?p wikibase:sitelinks ?sl }
    }`, minSitelinks, `teams ${teams.join(',')}`);
}

// Per-person facts used for the index and the "known for" line, fetched in
// batches on QLever (fast for big VALUES lists). Each query covers one kind of
// fact so rows don't multiply. Team, band and film lookups only run for the
// people who need them (opts.sport / opts.music / opts.screen: Sets of QIDs).
export async function details(qids, { batch = 500, sport, music, screen, log = () => {} } = {}) {
  const out = new Map(qids.map((q) => [q, { human: false, images: [], aliases: [], teams: [], bands: [], works: [], positions: [], born: null, died: null }]));
  const get = (q) => out.get(q);
  const year = (v) => (v ? Number(v.slice(0, v.indexOf('-', 1))) : null);
  const batches = chunk(qids, batch);
  for (const [bi, ids] of batches.entries()) {
    const V = values(ids);
    // Core facts double as a sanity check: almost everyone here is a person,
    // so a near-empty answer means a glitch; ask the official service instead.
    const coreQ = `SELECT ?p ?born ?died WHERE { VALUES ?p { ${V} } ?p wdt:P31 wd:Q5 .
        OPTIONAL { ?p wdt:P569 ?born } OPTIONAL { ?p wdt:P570 ?died } }`;
    let core = await sparql(coreQ, { prefer: 'qlever' });
    if (new Set(core.map((r) => r.p)).size < ids.length * 0.5) core = await sparql(coreQ, { prefer: 'wdqs' });
    for (const r of core) {
      const d = get(r.p);
      d.human = true;
      if (r.born && !d.born) d.born = year(r.born);
      if (r.died && !d.died) d.died = year(r.died);
    }
    for (const r of await sparql(`SELECT ?p ?img WHERE { VALUES ?p { ${V} } ?p wdt:P18 ?img }`, { prefer: 'qlever' })) {
      const f = decodeURIComponent(r.img.replace(/^.*Special:FilePath\//, '')).replace(/_/g, ' ');
      if (!get(r.p).images.includes(f)) get(r.p).images.push(f);
    }
    for (const r of await sparql(`SELECT ?p ?a WHERE { VALUES ?p { ${V} } ?p skos:altLabel ?a FILTER(LANG(?a) = "en") }`, { prefer: 'qlever' })) {
      if (!get(r.p).aliases.includes(r.a)) get(r.p).aliases.push(r.a);
    }
    const sp = ids.filter((q) => !sport || sport.has(q));
    if (sp.length) {
      const S = values(sp);
      for (const r of await sparql(`SELECT ?p ?team ?label ?league ?start ?end WHERE { VALUES ?p { ${S} }
          ?p p:P54 ?st . ?st ps:P54 ?team . ?team rdfs:label ?label FILTER(LANG(?label) = "en")
          OPTIONAL { ?team wdt:P118 ?league } OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } }`, { prefer: 'qlever' })) {
        const d = get(r.p);
        if (!d.teams.some((t) => t.id === r.team && t.start === (r.start || null))) {
          d.teams.push({ id: r.team, label: r.label, league: r.league || null, start: r.start || null, end: r.end || null });
        }
      }
      for (const r of await sparql(`SELECT ?p ?label WHERE { VALUES ?p { ${S} }
          ?p wdt:P413 ?pos . ?pos rdfs:label ?label FILTER(LANG(?label) = "en") }`, { prefer: 'qlever' })) {
        if (!get(r.p).positions.includes(r.label)) get(r.p).positions.push(r.label);
      }
    }
    const mu = ids.filter((q) => !music || music.has(q));
    if (mu.length) {
      // Bands and groups the person is or was a member of.
      for (const r of await sparql(`SELECT ?p ?label ?sl WHERE { VALUES ?p { ${values(mu)} }
          { ?p wdt:P463 ?g } UNION { ?g wdt:P527 ?p }
          ?g wdt:P31/wdt:P279* wd:Q215380 ; wikibase:sitelinks ?sl ; rdfs:label ?label FILTER(LANG(?label) = "en") }`, { prefer: 'qlever' })) {
        const d = get(r.p);
        if (!d.bands.some((b) => b.label === r.label)) d.bands.push({ label: r.label, sl: Number(r.sl) });
      }
    }
    const sc = ids.filter((q) => !screen || screen.has(q));
    if (sc.length) {
      // Films and TV series they appear in, most widely covered first.
      for (const r of await sparql(`SELECT ?p ?label ?sl WHERE { VALUES ?p { ${values(sc)} }
          ?w wdt:P161 ?p ; wikibase:sitelinks ?sl ; rdfs:label ?label FILTER(LANG(?label) = "en") }`, { prefer: 'qlever' })) {
        const d = get(r.p);
        if (!d.works.some((w) => w.label === r.label)) d.works.push({ label: r.label, sl: Number(r.sl) });
      }
    }
    if ((bi + 1) % 20 === 0) log(`  details ${Math.min((bi + 1) * batch, qids.length)}/${qids.length}`);
  }
  for (const d of out.values()) {
    d.bands.sort((a, b) => b.sl - a.sl);
    d.works.sort((a, b) => b.sl - a.sl);
    d.works = d.works.slice(0, 5);
    d.bands = d.bands.slice(0, 3);
  }
  return out;
}
