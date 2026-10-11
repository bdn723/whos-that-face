// Node-side image decoding and Commons URL helpers.
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { createFaceEngine } from '../../shared/face.js';
import { USER_AGENT, mediaLimit, mediaThrottled, mediaSucceeded } from './http.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const CACHE_DIR = path.join(ROOT, 'build/cache');

// Decode to RGBA, applying the photo's EXIF rotation (as browsers do).
export async function decodeRGBA(buf) {
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

// Commons stores files under md5-based folders.
// https://www.mediawiki.org/wiki/Manual:$wgHashedUploadDirectory
export function commonsPaths(fileName) {
  const name = fileName.replace(/ /g, '_');
  const md5 = crypto.createHash('md5').update(name).digest('hex');
  const dir = `${md5[0]}/${md5.slice(0, 2)}`;
  const enc = encodeURIComponent(name);
  // Thumbnails of files with names over 160 bytes are named "thumbnail.<ext>"
  // (MediaWiki FileRepo::nameForThumb, Commons abbrvThreshold = 160).
  const thumbName = Buffer.byteLength(name) > 160 ? `thumbnail${name.slice(name.lastIndexOf('.'))}` : enc;
  return {
    name,
    original: `https://upload.wikimedia.org/wikipedia/commons/${dir}/${enc}`,
    // Commons only serves standard thumbnail widths (… 250, 330, 500, 960 …).
    thumb: (w) => `https://upload.wikimedia.org/wikipedia/commons/thumb/${dir}/${enc}/${w}px-${thumbName}`,
  };
}

const OK_EXT = /\.(jpe?g|png|webp)$/i;

// One media GET through the shared pacer. Returns { status, buf? } and
// never throws for HTTP errors; a 429 slows the pacer and is retried.
async function getMedia(url, what) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await mediaLimit(async () => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429) {
          mediaThrottled(Number(res.headers.get('retry-after')));
          await res.arrayBuffer().catch(() => {});
          return { retry: true };
        }
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          return { status: res.status, retry: res.status >= 500 };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        mediaSucceeded();
        return { status: 200, buf };
      } catch (e) {
        return { status: 0, retry: true, error: e.message };
      }
    });
    if (!r.retry) return r;
    if (r.status >= 500 || r.status === 0) await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  console.warn(`  giving up on ${what} for now`);
  return { status: -1 }; // transient: try again next run
}

// Download a Commons file at 500px wide (or the original if it is smaller).
// Returns a Buffer, null (file unusable), or undefined (temporary failure).
// Set KEEP_IMAGES=1 to keep downloads on disk (handy for local development).
const KEEP = process.env.KEEP_IMAGES === '1';
export async function fetchCommonsImage(fileName) {
  if (!OK_EXT.test(fileName)) return null;
  const p = commonsPaths(fileName);
  const key = crypto.createHash('sha1').update(p.name).digest('hex');
  const file = path.join(CACHE_DIR, 'img', `${key}.bin`);
  if (fs.existsSync(file)) {
    const b = fs.readFileSync(file);
    return b.length ? b : null;
  }
  // A 500px thumbnail doesn't exist when the original is narrower; then
  // Commons answers 4xx and the (small) original is used.
  let r = await getMedia(p.thumb(500), p.name);
  if (r.status !== 200 && r.status !== -1) r = await getMedia(p.original, p.name);
  if (r.status === -1) return undefined;
  const buf = r.status === 200 ? r.buf : null;
  if (KEEP) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf || Buffer.alloc(0));
  }
  return buf;
}

let enginePromise;
export function nodeFaceEngine() {
  if (!enginePromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    enginePromise = createFaceEngine(
      ort,
      fs.readFileSync(path.join(ROOT, 'models/face_detection_yunet_2023mar.onnx')),
      fs.readFileSync(path.join(ROOT, 'models/face_recognition_sface_2021dec_int8.onnx')),
    );
  }
  return enginePromise;
}
