/* Dawn Patrol — engine.js
 * YAMNet wrapper: loads the ONNX model + class map + bird index, exposes
 *   classifyWindow(Float32Array) -> per-frame evidence
 * Everything runs on-device via onnxruntime-web WASM. No network after load.
 */
(() => {
  const SR = 16000;
  const FRAME_SECONDS = 0.96; // YAMNet patch hop

  class YamnetEngine {
    constructor() {
      this.session = null;
      this.classNames = null; // Array(521) of display names
      this.birdIdx = null; // Array of bird class indices
      this.ready = null; // promise
      this.lastFrameTime = -Infinity; // dedup cursor for overlapping windows
    }

    async load() {
      if (!this.ready) this.ready = this._load();
      return this.ready;
    }

    async _load() {
      const [clsText, birdText] = await Promise.all([
        fetch('model/yamnet_class_map.csv').then((r) => r.text()),
        fetch('model/bird-classes.json').then((r) => r.json()),
      ]);
      this.classNames = [];
      for (const line of clsText.split('\n').slice(1)) {
        if (!line) continue;
        const p1 = line.indexOf(',');
        const p2 = line.indexOf(',', p1 + 1);
        this.classNames[+line.slice(0, p1)] = line
          .slice(p2 + 1)
          .trim()
          .replace(/^"|"$/g, '');
      }
      this.birdIdx = birdText.map((b) => b.index);
      ort.env.wasm.numThreads = 1; // plain https: no COOP/COEP headers on Pages
      this.session = await ort.InferenceSession.create('model/yamnet.onnx', {
        executionProviders: ['wasm'],
      });
    }

    get sampleRate() {
      return SR;
    }

    /* Run the model on a mono 16 kHz window.
     * Returns null if called while busy (caller retries next tick). */
    async classifyWindow(samples, { windowStart = 0, dedup = true } = {}) {
      if (!this.session) throw new Error('engine not loaded');
      if (this._busy) return null;
      this._busy = true;
      try {
        const n = samples.length;
        const feeds = { waveform: new ort.Tensor('float32', samples, [n]) };
        const outName = this.session.outputNames[0];
        const res = await this.session.run(feeds);
        const scores = res[outName]; // dims [frames, 521]
        const frames = scores.dims[0];
        const data = scores.data;

        const perFrame = []; // {t, evidence, best:{name,score}, hits}
        for (let f = 0; f < frames; f++) {
          const base = f * 521;
          let ev = 0;
          let bestI = -1;
          let bestV = 0;
          for (const i of this.birdIdx) {
            const v = data[base + i];
            if (v > ev) ev = v;
            if (v > bestV) {
              bestV = v;
              bestI = i;
            }
          }
          // overall top-3 for the "now hearing" readout (any class)
          const order = [];
          for (let c = 0; c < 521; c++) order.push([data[base + c], c]);
          order.sort((a, b) => b[0] - a[0]);
          const top3 = order.slice(0, 3).map(([v, c]) => ({ name: this.classNames[c], score: v }));
          const t = windowStart + (f + 0.5) * FRAME_SECONDS;
          perFrame.push({
            t,
            evidence: ev,
            best: bestI >= 0 ? { name: this.classNames[bestI], score: bestV } : null,
            top3,
          });
        }
        // dedup overlapping windows: only frames past the cursor count
        const counted = [];
        for (const fr of perFrame) {
          if (!dedup || fr.t > this.lastFrameTime) {
            this.lastFrameTime = Math.max(this.lastFrameTime, fr.t);
            counted.push(fr);
          }
        }
        return { frames: perFrame, counted };
      } finally {
        this._busy = false;
      }
    }
  }

  window.DawnEngine = YamnetEngine;
})();
