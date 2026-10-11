// English Wikipedia Action API helpers. Text is CC BY-SA.
import { getJson, chunk } from '../lib/http.js';

const API = 'https://en.wikipedia.org/w/api.php';

// Run a query, following `continue` until done, merging pages by title.
async function queryAll(params) {
  const pages = new Map();
  const redirects = new Map();
  let cont = {};
  for (;;) {
    const r = await getJson(API, { action: 'query', format: 'json', formatversion: 2, ...params, ...cont });
    for (const x of r.query?.normalized || []) redirects.set(x.from, x.to);
    for (const x of r.query?.redirects || []) redirects.set(x.from, x.to);
    for (const p of r.query?.pages || []) {
      const prev = pages.get(p.title) || {};
      pages.set(p.title, { ...prev, ...p, pageviews: { ...(prev.pageviews || {}), ...(p.pageviews || {}) } });
    }
    if (!r.continue) break;
    cont = r.continue;
  }
  return { pages, redirects };
}

const resolve = (redirects, t) => {
  let x = t;
  for (let i = 0; i < 5 && redirects.has(x); i++) x = redirects.get(x);
  return x;
};

// Title -> { title, qid, desc, views60, pageimage, disambig }.
// Input titles may be redirects; the returned map is keyed by the input title.
export async function pageInfo(titles) {
  const out = new Map();
  for (const batch of chunk([...new Set(titles)], 50)) {
    const { pages, redirects } = await queryAll({
      titles: batch.join('|'),
      redirects: 1,
      prop: 'pageprops|description|pageviews|pageimages',
      ppprop: 'wikibase_item|disambiguation',
      pvipdays: 60,
      piprop: 'name',
      pilicense: 'free',
    });
    for (const t of batch) {
      const p = pages.get(resolve(redirects, t));
      if (!p || p.missing) continue;
      out.set(t, {
        title: p.title,
        qid: p.pageprops?.wikibase_item || null,
        desc: p.description || '',
        views60: Object.values(p.pageviews || {}).reduce((s, v) => s + (v || 0), 0),
        pageimage: p.pageimage ? p.pageimage.replace(/_/g, ' ') : null,
        disambig: p.pageprops?.disambiguation !== undefined,
      });
    }
  }
  return out;
}

// Title -> plain-text lead, first few sentences.
export async function extracts(titles, sentences = 2) {
  const out = new Map();
  for (const batch of chunk([...new Set(titles)], 20)) {
    const { pages } = await queryAll({
      titles: batch.join('|'),
      prop: 'extracts',
      exintro: 1,
      explaintext: 1,
      exsentences: sentences,
      exlimit: 20,
    });
    for (const p of pages.values()) if (p.extract) out.set(p.title, p.extract.replace(/\s+/g, ' ').trim());
  }
  return out;
}

export async function categoryMembers(category) {
  const titles = [];
  let cont = {};
  for (;;) {
    const r = await getJson(API, {
      action: 'query', format: 'json', formatversion: 2,
      list: 'categorymembers', cmtitle: `Category:${category}`, cmtype: 'page', cmnamespace: 0, cmlimit: 500, ...cont,
    });
    for (const m of r.query.categorymembers) titles.push(m.title);
    if (!r.continue) break;
    cont = r.continue;
  }
  return titles;
}
