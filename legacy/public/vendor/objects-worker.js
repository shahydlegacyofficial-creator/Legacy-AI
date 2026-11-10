/**
 * COCO-SSD in its OWN THREAD (v3.14.1).
 *
 * "objects: n is not a function" was two TensorFlow.js versions sharing one
 * global engine. face-api.min.js bundles tfjs-core 1.7 and registers it on
 * the page's global scope; tfjs 4.22 loaded afterwards found that registry and
 * REUSED it ("cpu backend was already registered. Reusing existing backend
 * factory") — so 4.22 code ran against 1.7 internals and died on the first
 * call that did not exist in the old version.
 *
 * A worker has its own global scope, so its tfjs has its own engine and can
 * never see face-api's. It also takes detection OFF the main thread, which is
 * what keeps the page's animations smooth while it runs.
 */
/* global tf, cocoSsd */
let model = null;
let loading = null;

async function load() {
  if (model) return model;
  if (loading) return loading;
  loading = (async () => {
    importScripts('/vendor/tf.min.js', '/vendor/coco-ssd.min.js');
    // WebGL in a worker needs OffscreenCanvas; Chrome has it. If not, the CPU
    // backend still works — slower, never broken.
    try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
    await tf.ready();
    try {
      model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: '/models/objects/model.json' });
    } catch {
      model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });   // Google's copy
    }
    return model;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}

self.onmessage = async (ev) => {
  const { id, type, bitmap, scale } = ev.data || {};
  try {
    if (type === 'load') {
      await load();
      self.postMessage({ id, ok: true, backend: tf.getBackend() });
      return;
    }
    if (type === 'detect') {
      const m = await load();
      // ImageBitmap straight into a tensor — no canvas, no copy on the page.
      const img = tf.browser.fromPixels(bitmap);
      let preds;
      try { preds = await m.detect(img, 20, 0.45); } finally { img.dispose(); bitmap.close?.(); }
      // Boxes back in VIDEO pixels: the page downscaled before sending.
      const s = Number(scale) || 1;
      self.postMessage({
        id, ok: true,
        found: preds.map((p) => ({
          label: p.class, score: p.score,
          box: [p.bbox[0] * s, p.bbox[1] * s, p.bbox[2] * s, p.bbox[3] * s],
        })),
      });
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message ${type}` });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
