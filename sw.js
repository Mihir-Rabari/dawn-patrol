/* Dawn Patrol — sw.js
 * Precache-everything offline strategy: the model, the wasm runtime, the
 * sample, and every asset. After one load, airplane mode is a supported
 * runtime mode, not a failure.
 */
const CACHE = 'dawn-patrol-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'icon.svg',
  'manifest.webmanifest',
  'js/engine.js',
  'js/audio.js',
  'js/store.js',
  'js/app.js',
  'worklet-processor.js',
  'vendor/ort.min.js',
  'vendor/ort-wasm-simd-threaded.wasm',
  'vendor/ort-wasm-simd-threaded.mjs',
  'vendor/ort-wasm-simd-threaded.jsep.wasm',
  'vendor/ort-wasm-simd-threaded.jsep.mjs',
  'model/yamnet.onnx',
  'model/yamnet_class_map.csv',
  'model/bird-classes.json',
  'samples/dawn-chorus-demo.wav',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // refresh in background when online; serve cache-first always
        fetch(e.request)
          .then((r) => {
            if (r && r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
          })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request);
    })
  );
});
