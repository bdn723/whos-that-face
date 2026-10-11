// Node-side image decoding and Commons URL helpers.
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { createFaceEngine } from '../../shared/face.js';
import { fetchWithRetry, mediaLimit } from './http.js';

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

// Download a Commons file at 500px wide (or the original if it is smaller),
// with an on-disk cache. Returns a Buffer or null.
export async function fetchCommonsImage(fileName) {
  if (!OK_EXT.test(fileName)) return null;
  const p = commonsPaths(fileName);
  const key = crypto.createHash('sha1').update(p.name).digest('hex');
  const file = path.join(CACHE_DIR, 'img', `${key}.bin`);
  if (fs.existsSync(file)) {
    const b = fs.readFileSync(file);
    return b.length ? b : null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = await mediaLimit(async () => {
    // A 500px thumbnail doesn't exist when the original is narrower; then
    // Commons answers 4xx and the original is used.
    let lastErr;
    for (const url of [p.thumb(500), p.original]) {
      try {
        const res = await fetchWithRetry(url, {}, { tries: 4, what: p.name });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr && /HTTP (429|5\d\d)|fetch failed|ECONN|ETIMEDOUT/.test(lastErr.message)) throw lastErr;
    return null;
  }).catch((e) => {
    console.warn(`  image failed: ${e.message}`);
    return undefined;
  });
  if (buf === undefined) return null; // transient failure: don't cache
  fs.writeFileSync(file, buf || Buffer.alloc(0));
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
