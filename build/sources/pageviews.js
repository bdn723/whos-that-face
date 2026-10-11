// Fame from Wikimedia's daily pageview dumps, which cover every English
// Wikipedia article in one file per day (~650 MB). Wikimedia asks bulk users
// to prefer dumps over live API calls.
// https://dumps.wikimedia.org/other/pageview_complete/readme.html
//
// Line format: "en.wikipedia Title_With_Underscores page_id access daily_total hourly"
// (one line per access type: desktop, mobile-web, mobile-app).
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { USER_AGENT, fetchWithRetry } from '../lib/http.js';

const BASE = 'https://dumps.wikimedia.org/other/pageview_complete';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const urlFor = (d) => `${BASE}/${d.getUTCFullYear()}/${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}/pageviews-${ymd(d)}-user.bz2`;

// The most recent published days, spaced `spacing` days apart.
export async function pickDays(count = 3, spacing = 9) {
  const days = [];
  let d = new Date(Date.now() - 24 * 3600 * 1000);
  for (let tries = 0; tries < 6 && !days.length; tries++) {
    const res = await fetchWithRetry(urlFor(d), { method: 'HEAD' }, { tries: 2 }).catch(() => null);
    if (res?.ok) days.push(d);
    else d = new Date(d.getTime() - 24 * 3600 * 1000);
  }
  if (!days.length) throw new Error('no recent pageview dump found');
  for (let i = 1; i < count; i++) days.push(new Date(days[0].getTime() - i * spacing * 24 * 3600 * 1000));
  return days;
}

const decompressor = () => {
  for (const cmd of ['lbzip2', 'pbzip2', 'bzip2']) {
    try {
      execSync(`command -v ${cmd}`, { stdio: 'ignore' });
      return cmd;
    } catch { /* try next */ }
  }
  throw new Error('need bzip2');
};

// Views per title for one day, for the given titles only.
async function oneDay(day, wanted) {
  const counts = new Map();
  const bz = decompressor();
  // curl | bzip2 -dc | grep: the heavy lifting stays in C tools.
  const sh = spawn('sh', ['-c', `curl -sSf -A "$UA" "$URL" | ${bz} -dc | LC_ALL=C grep -a '^en\\.wikipedia '`], {
    env: { ...process.env, UA: USER_AGENT, URL: urlFor(day) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rl = readline.createInterface({ input: sh.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const a = line.indexOf(' ');
    const b = line.indexOf(' ', a + 1);
    const title = line.slice(a + 1, b).replace(/_/g, ' ');
    if (!wanted.has(title)) continue;
    const fields = line.slice(b + 1).split(' ');
    counts.set(title, (counts.get(title) || 0) + Number(fields[2] || 0));
  }
  const code = await new Promise((res) => sh.on('close', res));
  if (code !== 0 && counts.size === 0) throw new Error(`pageview dump ${ymd(day)} failed (exit ${code})`);
  return counts;
}

// Average daily views for each title over the sampled days, with a per-day
// cache (each day's file is only read once per set of titles).
export async function dailyViews(titles, { cacheDir, count = 3, log = console.log } = {}) {
  const wanted = new Set(titles);
  const days = await pickDays(count);
  const totals = new Map();
  for (const day of days) {
    const cacheFile = cacheDir && path.join(cacheDir, `pv-${ymd(day)}.json`);
    let counts;
    if (cacheFile && fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // Reuse unless the list of titles has changed noticeably.
      const known = new Set(c.titles);
      const missing = titles.reduce((n, t) => n + (known.has(t) ? 0 : 1), 0);
      if (missing <= titles.length * 0.01) counts = new Map(Object.entries(c.counts));
    }
    if (!counts) {
      const t0 = Date.now();
      counts = await oneDay(day, wanted);
      log(`  pageviews ${ymd(day)}: ${counts.size.toLocaleString()} of ${wanted.size.toLocaleString()} titles viewed (${Math.round((Date.now() - t0) / 1000)} s)`);
      if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify({ titles, counts: Object.fromEntries(counts) }));
    }
    for (const [t, n] of counts) totals.set(t, (totals.get(t) || 0) + n);
  }
  const avg = new Map();
  for (const t of titles) avg.set(t, (totals.get(t) || 0) / days.length);
  return { avg, days: days.map(ymd) };
}
