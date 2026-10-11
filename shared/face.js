// Face detection (YuNet) and face fingerprints (SFace), in plain JS.
//
// This one file runs both in the browser (on Abby's phone) and in Node (the
// index build), so a photo gets the same fingerprint in both places. The
// caller passes in the onnxruntime module and the two model files; images are
// plain RGBA pixel buffers: { data: Uint8Array|Uint8ClampedArray, width, height }.
//
// The pre- and post-processing follows OpenCV's FaceDetectorYN and
// FaceRecognizerSF (opencv/modules/objdetect/src/face_detect.cpp and
// face_recognize.cpp) so the models see inputs in the form they were built for.

export const DET_SIZE = 640; // YuNet 2023mar has a fixed 640x640 input
export const REC_SIZE = 112;
export const DIM = 128;

// OpenCV's reference positions of the 5 landmarks in a 112x112 aligned face:
// right eye, left eye, nose tip, right mouth corner, left mouth corner
// ("right" is the person's right, i.e. image left).
const REF = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// ---------- pixel helpers ----------

// 2x2 box-filter halving. Used instead of a single big bilinear step so that
// shrinking large photos doesn't alias.
export function halve(img) {
  const w = img.width >> 1;
  const h = img.height >> 1;
  const src = img.data;
  const sw = img.width;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i0 = ((2 * y) * sw + 2 * x) * 4;
      const i1 = i0 + 4;
      const i2 = i0 + sw * 4;
      const i3 = i2 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (src[i0 + c] + src[i1 + c] + src[i2 + c] + src[i3 + c] + 2) >> 2;
    }
  }
  return { data: out, width: w, height: h };
}

// Bilinear resize with OpenCV's pixel-centre convention.
export function resizeBilinear(img, w, h) {
  const src = img.data;
  const sw = img.width;
  const sh = img.height;
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    let sy = (y + 0.5) * fy - 0.5;
    if (sy < 0) sy = 0;
    let y0 = Math.floor(sy);
    if (y0 > sh - 1) y0 = sh - 1;
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = sy - y0;
    for (let x = 0; x < w; x++) {
      let sx = (x + 0.5) * fx - 0.5;
      if (sx < 0) sx = 0;
      let x0 = Math.floor(sx);
      if (x0 > sw - 1) x0 = sw - 1;
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = sx - x0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * wx;
        const bot = src[c + k] + (src[d + k] - src[c + k]) * wx;
        out[o + k] = top + (bot - top) * wy + 0.5;
      }
    }
  }
  return { data: out, width: w, height: h };
}

// Scale so the longer side is exactly `target` (halving first while the image
// is at least twice too big). Returns the image and the overall scale factor.
export function scaleLongSide(img, target) {
  let im = img;
  while (Math.max(im.width, im.height) >= 2 * target) im = halve(im);
  const s = target / Math.max(im.width, im.height);
  const w = Math.max(1, Math.round(im.width * s));
  const h = Math.max(1, Math.round(im.height * s));
  if (w !== im.width || h !== im.height) im = resizeBilinear(im, w, h);
  return { img: im, scale: im.width / img.width };
}

// Shrink (never enlarge) so the longer side is at most maxDim.
export function fitWithin(img, maxDim) {
  if (Math.max(img.width, img.height) <= maxDim) return img;
  return scaleLongSide(img, maxDim).img;
}

// Rotate 90 degrees clockwise (used to retry detection on sideways photos).
export function rotate90(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = h - 1 - y;
      const ny = x;
      const o = (ny * h + nx) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  }
  return { data: out, width: h, height: w };
}

// ---------- detection ----------

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

function detInput(img) {
  const { img: im, scale } = scaleLongSide(img, DET_SIZE);
  const plane = DET_SIZE * DET_SIZE;
  const t = new Float32Array(3 * plane); // zero padding at right/bottom
  const d = im.data;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const i = (y * im.width + x) * 4;
      const o = y * DET_SIZE + x;
      // YuNet expects BGR, 0-255, no mean subtraction.
      t[o] = d[i + 2];
      t[plane + o] = d[i + 1];
      t[2 * plane + o] = d[i];
    }
  }
  return { tensorData: t, scale };
}

function decode(out, scoreThreshold) {
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cols = DET_SIZE / stride;
    const rows = DET_SIZE / stride;
    const cls = out[`cls_${stride}`].data;
    const obj = out[`obj_${stride}`].data;
    const bbox = out[`bbox_${stride}`].data;
    const kps = out[`kps_${stride}`].data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const cs = Math.min(1, Math.max(0, cls[idx]));
        const os = Math.min(1, Math.max(0, obj[idx]));
        const score = Math.sqrt(cs * os);
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;
        const lm = [];
        for (let n = 0; n < 5; n++) {
          lm.push([(kps[idx * 10 + 2 * n] + c) * stride, (kps[idx * 10 + 2 * n + 1] + r) * stride]);
        }
        faces.push({ box: [cx - w / 2, cy - h / 2, w, h], lm, score });
      }
    }
  }
  return faces;
}

function nms(faces, thr) {
  faces.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of faces) {
    if (keep.every((k) => iou(k.box, f.box) <= thr)) keep.push(f);
  }
  return keep;
}

// ---------- alignment + fingerprint ----------

// Least-squares similarity transform (rotation + uniform scale + shift)
// mapping the 5 detected landmarks onto REF.
function similarity(src) {
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (let i = 0; i < 5; i++) {
    mx += src[i][0]; my += src[i][1]; mu += REF[i][0]; mv += REF[i][1];
  }
  mx /= 5; my /= 5; mu /= 5; mv /= 5;
  let na = 0, nb = 0, den = 0;
  for (let i = 0; i < 5; i++) {
    const xc = src[i][0] - mx, yc = src[i][1] - my;
    const uc = REF[i][0] - mu, vc = REF[i][1] - mv;
    na += xc * uc + yc * vc;
    nb += xc * vc - yc * uc;
    den += xc * xc + yc * yc;
  }
  const a = na / den;
  const b = nb / den;
  return { a, b, tx: mu - (a * mx - b * my), ty: mv - (b * mx + a * my) };
}

// Warp the face to a 112x112 RGB crop (bilinear, black outside the image).
export function alignFace(img, landmarks) {
  let im = img;
  let lm = landmarks;
  let T = similarity(lm);
  // If the face is much bigger than 112px, halve the image first so the
  // bilinear sampling doesn't skip pixels.
  while (Math.hypot(T.a, T.b) < 0.5 && im.width > 2 && im.height > 2) {
    im = halve(im);
    lm = lm.map(([x, y]) => [(x - 0.5) / 2, (y - 0.5) / 2]);
    T = similarity(lm);
  }
  const { a, b, tx, ty } = T;
  const det = a * a + b * b;
  const ia = a / det;
  const ib = b / det;
  const W = im.width, H = im.height, d = im.data;
  const out = new Uint8ClampedArray(REC_SIZE * REC_SIZE * 4);
  const px = (x, y, k) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[(y * W + x) * 4 + k]);
  for (let v = 0; v < REC_SIZE; v++) {
    for (let u = 0; u < REC_SIZE; u++) {
      const du = u - tx, dv = v - ty;
      const sx = ia * du + ib * dv;
      const sy = -ib * du + ia * dv;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const wx = sx - x0, wy = sy - y0;
      const o = (v * REC_SIZE + u) * 4;
      for (let k = 0; k < 3; k++) {
        const top = px(x0, y0, k) + (px(x0 + 1, y0, k) - px(x0, y0, k)) * wx;
        const bot = px(x0, y0 + 1, k) + (px(x0 + 1, y0 + 1, k) - px(x0, y0 + 1, k)) * wx;
        out[o + k] = top + (bot - top) * wy + 0.5;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: REC_SIZE, height: REC_SIZE };
}

export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------- engine ----------

export async function createFaceEngine(ort, detModel, recModel) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const det = await ort.InferenceSession.create(detModel, opts);
  const rec = await ort.InferenceSession.create(recModel, opts);

  async function detectOnce(img, scoreThreshold, nmsThreshold) {
    const { tensorData, scale } = detInput(img);
    const out = await det.run({ input: new ort.Tensor('float32', tensorData, [1, 3, DET_SIZE, DET_SIZE]) });
    return nms(decode(out, scoreThreshold), nmsThreshold).map((f) => ({
      score: f.score,
      box: f.box.map((v) => v / scale),
      lm: f.lm.map(([x, y]) => [x / scale, y / scale]),
    }));
  }

  return {
    // All faces in the image, best first, in the image's own pixel coordinates.
    detect: (img, { scoreThreshold = 0.6, nmsThreshold = 0.3 } = {}) =>
      detectOnce(img, scoreThreshold, nmsThreshold),

    // 128-number fingerprint for one detected face, unit length.
    async embed(img, face) {
      const crop = alignFace(img, face.lm);
      const plane = REC_SIZE * REC_SIZE;
      const t = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) {
        // SFace expects RGB, 0-255, no mean subtraction.
        t[i] = crop.data[i * 4];
        t[plane + i] = crop.data[i * 4 + 1];
        t[2 * plane + i] = crop.data[i * 4 + 2];
      }
      const out = await rec.run({ data: new ort.Tensor('float32', t, [1, 3, REC_SIZE, REC_SIZE]) });
      return l2normalize(out.fc1.data);
    },

    release() {
      det.release?.();
      rec.release?.();
    },
  };
}

// Pick the face to index from a portrait: the largest confident one.
export function largestFace(faces, minScore = 0.7) {
  let best = null;
  for (const f of faces) {
    if (f.score < minScore) continue;
    if (!best || f.box[2] * f.box[3] > best.box[2] * best.box[3]) best = f;
  }
  return best;
}

// ---------- compact index ----------

// Store each unit vector as int8 with its own scale. Cosine similarity is
// scale-free, so search only needs each stored row's length.
export function quantize(vec) {
  let m = 0;
  for (let i = 0; i < vec.length; i++) m = Math.max(m, Math.abs(vec[i]));
  const s = m > 0 ? 127 / m : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.round(vec[i] * s);
  return q;
}

export function rowInverseNorms(int8, n) {
  const inv = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    const o = r * DIM;
    for (let i = 0; i < DIM; i++) s += int8[o + i] * int8[o + i];
    inv[r] = s > 0 ? 1 / Math.sqrt(s) : 0;
  }
  return inv;
}

// Cosine similarity of a float query against every stored row.
export function similarities(query, int8, invNorms) {
  const n = invNorms.length;
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    const o = r * DIM;
    for (let i = 0; i < DIM; i++) s += query[i] * int8[o + i];
    out[r] = s * invNorms[r];
  }
  return out;
}

export function rowVector(int8, invNorms, r) {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = int8[r * DIM + i] * invNorms[r];
  return v;
}
