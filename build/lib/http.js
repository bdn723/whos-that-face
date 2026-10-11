// Polite HTTP helpers for Wikimedia APIs.
// Wikimedia asks for a descriptive User-Agent with contact info, serial API
// requests, and at most 2 concurrent media downloads.
// https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
// https://wikitech.wikimedia.org/wiki/Robot_policy

export const USER_AGENT =
  'WhosThatFace/0.1 (https://github.com/bdn723/whos-that-face; personal non-commercial project)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A limiter allows `concurrency` jobs at once with at least `minGapMs`
// between job starts.
export function limiter(concurrency, minGapMs) {
  let active = 0;
  let lastStart = 0;
  const queue = [];
  const pump = async () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    const wait = Math.max(0, lastStart + minGapMs - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
    try {
      resolve(await fn());
    } catch (e) {
      reject(e);
    } finally {
      active--;
      pump();
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

// API calls: one at a time, under 5 per second.
export const apiLimit = limiter(1, 220);
// Media downloads: 2 at a time.
export const mediaLimit = limiter(2, 50);

export async function fetchWithRetry(url, opts = {}, { tries = 5, what = url } = {}) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, ...(opts.headers || {}) },
      });
    } catch (e) {
      if (attempt >= tries) throw new Error(`${what}: ${e.message}`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.ok) return res;
    if (res.status === 404) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries) {
      throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
    delay *= 2;
  }
}

export async function getJson(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  return apiLimit(async () => (await fetchWithRetry(u.toString())).json());
}

export async function postFormJson(url, params) {
  const body = new URLSearchParams(params);
  return apiLimit(async () =>
    (
      await fetchWithRetry(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      })
    ).json(),
  );
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
