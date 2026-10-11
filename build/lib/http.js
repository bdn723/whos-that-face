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

// Media downloads: at most 2 at a time, paced. Commons also rate-limits bots
// with HTTP 429 + Retry-After without publishing a number, so the gap between
// downloads adapts: it doubles after a 429 and shrinks slowly while requests
// succeed.
export const mediaPace = { gapMs: 400, minGapMs: 200, maxGapMs: 8000, ok: 0, throttled: 0, pausedUntil: 0 };
export function mediaThrottled(retryAfterSec) {
  mediaPace.throttled++;
  mediaPace.ok = 0;
  mediaPace.gapMs = Math.min(mediaPace.maxGapMs, mediaPace.gapMs * 2);
  mediaPace.pausedUntil = Math.max(mediaPace.pausedUntil, Date.now() + (retryAfterSec || 10) * 1000);
}
export function mediaSucceeded() {
  if (++mediaPace.ok >= 40) {
    mediaPace.ok = 0;
    mediaPace.gapMs = Math.max(mediaPace.minGapMs, Math.round(mediaPace.gapMs * 0.85));
  }
}
let mediaActive = 0;
let mediaLast = 0;
const mediaQueue = [];
async function mediaPump() {
  if (mediaActive >= 2 || !mediaQueue.length) return;
  mediaActive++;
  const { fn, resolve, reject } = mediaQueue.shift();
  try {
    for (;;) {
      const wait = Math.max(mediaPace.pausedUntil, mediaLast + mediaPace.gapMs) - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    mediaLast = Date.now();
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    mediaActive--;
    mediaPump();
  }
}
export const mediaLimit = (fn) =>
  new Promise((resolve, reject) => {
    mediaQueue.push({ fn, resolve, reject });
    mediaPump();
  });

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

// Action API rule: if a request took over 1 s to serve, wait 5 s before the
// next one.
let apiNotBefore = 0;
export async function getJson(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  return apiLimit(async () => {
    const wait = apiNotBefore - Date.now();
    if (wait > 0) await sleep(wait);
    const t0 = Date.now();
    const res = await fetchWithRetry(u.toString());
    const json = await res.json();
    if (Date.now() - t0 > 1000) apiNotBefore = Date.now() + 5000;
    return json;
  });
}

// SPARQL endpoints have their own queue so they don't hold up API calls.
const sparqlLimit = limiter(1, 100);
export async function postFormJson(url, params) {
  const body = new URLSearchParams(params);
  return sparqlLimit(async () =>
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
