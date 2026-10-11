/* Dawn Patrol — worklet-processor.js
 * AudioWorklet: consumes mic at the context rate, downsamples to 16 kHz mono
 * (linear interpolation — YAMNet is tolerant), posts chunks + RMS to the page.
 */
class DawnCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._rem = 0; // fractional sample carried across blocks
    this._tail = null; // last input sample for interpolation
    this._chunk = new Float32Array(4096);
    this._fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    const inRate = sampleRate;
    const outRate = 16000;
    const step = inRate / outRate;

    let pos = this._rem;
    let prev = this._tail === null ? (ch.length ? ch[0] : 0) : this._tail;
    let sumSq = 0;

    while (pos < ch.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const x1 = i0 + 1 < ch.length ? ch[i0 + 1] : ch[i0];
      const v = prev * (1 - frac) + x1 * frac;
      this._chunk[this._fill++] = v;
      sumSq += v * v;
      if (this._fill === this._chunk.length) {
        this.port.postMessage({ samples: this._chunk, rms: 0 }, [this._chunk.buffer]);
        this._chunk = new Float32Array(4096);
        this._fill = 0;
      }
      pos += step;
      prev = ch[Math.min(i0, ch.length - 1)];
    }
    this._rem = pos - ch.length;
    this._tail = ch[ch.length - 1];

    if (this._fill > 0 && sumSq > 0) {
      const rms = Math.sqrt(sumSq / Math.max(1, this._fill));
      // lightweight level ping so the UI can show a live meter even between chunks
      if (this._levelPing === undefined) this._levelPing = 0;
      this._levelPing++;
      if (this._levelPing % 8 === 0) {
        this.port.postMessage({ samples: new Float32Array(0), rms });
      }
    }
    return true;
  }
}

registerProcessor('dawn-capture', DawnCapture);
