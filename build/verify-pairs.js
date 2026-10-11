// Check that each "often mistaken for" pair's source page names both people.
// Usage: node build/verify-pairs.js   (run locally when pairs are added;
// news sites often block automated fetches from CI)
// Records the date of the last successful check on each pair.
import fs from 'node:fs';
import path from 'node:path';
import { fetchWithRetry, getJson } from './lib/http.js';
import { displayName } from '../shared/names.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'data/mistaken-for.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

async function pageText(url) {
  const wiki = url.match(/^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/);
  if (wiki) {
    const r = await getJson('https://en.wikipedia.org/w/api.php', {
      action: 'query', format: 'json', formatversion: 2, prop: 'extracts', explaintext: 1,
      titles: decodeURIComponent(wiki[1]).replace(/_/g, ' '), redirects: 1,
    });
    return r.query.pages[0].extract || '';
  }
  const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' } }, { tries: 2 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).replace(/<[^>]+>/g, ' ');
}

const surname = (t) => displayName(t).split(' ').slice(-1)[0];
let failures = 0;
for (const p of data.pairs) {
  if (!p.source) {
    // Name pairs: the names themselves are the evidence.
    if (p.kind !== 'name') { console.log(`MISSING SOURCE  ${p.a} / ${p.b}`); failures++; }
    continue;
  }
  try {
    const text = (await pageText(p.source)).toLowerCase();
    const missing = [p.a, p.b].filter((n) => !text.includes(surname(n).toLowerCase()));
    if (missing.length) {
      console.log(`NOT FOUND       ${p.a} / ${p.b}: ${missing.join(', ')} not on ${p.source}`);
      failures++;
    } else {
      p.checked = today;
      console.log(`ok              ${p.a} / ${p.b}`);
    }
  } catch (e) {
    console.log(`FETCH FAILED    ${p.a} / ${p.b}: ${e.message.slice(0, 100)}`);
    failures++;
  }
}
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(failures ? `${failures} pair(s) need attention` : 'all pairs verified');
process.exitCode = failures ? 1 : 0;
