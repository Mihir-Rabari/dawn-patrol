/* Dawn Patrol — audio.js
 * Microphone capture (AudioWorklet at 16 kHz mono, noiseSuppression OFF —
 * distant birdsong is exactly the "noise" browsers like to delete), a rolling
 * ring buffer, file/sample decode for demo mode, and the procedural alarm.
 */
(() => {
  const SR = 16000;

  class MicSource {
    constructor() {
      this.ctx = null;
      this.stream = null;
      this.node = null;
      this.buffer = new Float32Array(SR * 8); // 8 s ring
      this.writePos = 0;
      this.totalFrames = 0;
      this.listeners = [];
      this.active = false;
    }

    onLevel(fn) {
      this.listeners.push(fn);
    }

    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      try {
        this.ctx = new AudioContext({ sampleRate: SR });
      } catch {
        this.ctx = new AudioContext(); // Safari may ignore requested rate
      }
      await this.ctx.audioWorklet.addModule('worklet-processor.js');
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'dawn-capture');
      this.node.port.onmessage = (e) => {
        const chunk = e.data.samples; // Float32Array at SR (worklet resamples)
        this._append(chunk);
        const rms = e.data.rms;
        for (const fn of this.listeners) fn(rms);
      };
      src.connect(this.node);
      // Do NOT connect to destination — no feedback, no monitoring.
      this.active = true;
    }

    _append(chunk) {
      const n = chunk.length;
      const end = this.writePos + n;
      if (end <= this.buffer.length) {
        this.buffer.set(chunk, this.writePos);
      } else {
        const first = this.buffer.length - this.writePos;
        this.buffer.set(chunk.subarray(0, first), this.writePos);
        this.buffer.set(chunk.subarray(first), 0);
      }
      this.writePos = end % this.buffer.length;
      this.totalFrames += n;
    }

    /* latest `seconds` of audio, chronological order */
    latest(seconds) {
      const n = Math.min(seconds * SR, this.totalFrames);
      const out = new Float32Array(n);
      if (this.totalFrames <= this.buffer.length) {
        const start = this.writePos - n;
        if (start >= 0) out.set(this.buffer.subarray(start, this.writePos));
        else {
          out.set(this.buffer.subarray(this.buffer.length + start), 0);
          out.set(this.buffer.subarray(0, this.writePos), this.buffer.length + start);
        }
      } else {
        // ring has wrapped at least once; reconstruct from cursor
        for (let i = 0; i < n; i++) {
          const idx = (this.writePos - n + i + this.buffer.length) % this.buffer.length;
          out[i] = this.buffer[idx];
        }
      }
      return out;
    }

    elapsed() {
      return this.totalFrames / SR;
    }

    async stop() {
      this.active = false;
      for (const track of this.stream ? this.stream.getTracks() : []) track.stop();
      if (this.ctx) {
        try {
          await this.ctx.close();
        } catch {
          /* already closed */
        }
      }
      this.ctx = this.stream = this.node = null;
      this.totalFrames = 0;
      this.writePos = 0;
    }
  }

  /* Decode any audio file the browser can read (wav/ogg/mp3) to 16 kHz mono
   * Float32 — used by demo mode and the "try a file" input. */
  async function decodeToMono16k(arrayBuffer) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    await ctx.close();
    const len = decoded.length;
    let ch = decoded.getChannelData(0);
    if (decoded.numberOfChannels > 1) {
      const all = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) all.push(decoded.getChannelData(c));
      ch = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < all.length; c++) s += all[c][i];
        ch[i] = s / all.length;
      }
    }
    if (Math.abs(decoded.sampleRate - SR) > 1) {
      const nOut = Math.round((len * SR) / decoded.sampleRate);
      const out = new Float32Array(nOut);
      const step = decoded.sampleRate / SR;
      for (let i = 0; i < nOut; i++) {
        const x0 = Math.floor(i * step);
        const x1 = Math.min(x0 + 1, len - 1);
        const frac = i * step - x0;
        out[i] = ch[x0] * (1 - frac) + ch[x1] * frac;
      }
      return out;
    }
    return ch;
  }

  /* Procedural alarm — synthetic FM chirp clusters, no audio assets.
   * Ironic by design: an obviously-artificial "bird" demanding the real one. */
  class AlarmSynth {
    constructor() {
      this.ctx = null;
      this.gain = null;
      this.timer = null;
      this.level = 0.18;
    }

    start() {
      this.stop();
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.level;
      this.gain.connect(this.ctx.destination);
      this._loop();
      this.timer = setInterval(() => this._loop(), 2200);
      // escalate politely
      this._ramp = setInterval(() => {
        this.level = Math.min(1.0, this.level + 0.09);
        if (this.gain) this.gain.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.3);
      }, 8000);
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    }

    _loop() {
      const t0 = this.ctx.currentTime + 0.05;
      for (let rep = 0; rep < 3; rep++) {
        const start = t0 + rep * 0.36;
        for (let i = 0; i < 3; i++) {
          const s = start + i * 0.1;
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(1500, s);
          o.frequency.exponentialRampToValueAtTime(2600, s + 0.07);
          g.gain.setValueAtTime(0, s);
          g.gain.linearRampToValueAtTime(0.9, s + 0.012);
          g.gain.exponentialRampToValueAtTime(0.001, s + 0.09);
          o.connect(g);
          g.connect(this.gain);
          o.start(s);
          o.stop(s + 0.1);
        }
      }
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      if (this._ramp) clearInterval(this._ramp);
      this.timer = this._ramp = null;
      if (navigator.vibrate) navigator.vibrate(0);
      if (this.ctx) {
        const ctx = this.ctx;
        this.ctx = null;
        try {
          this.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
          setTimeout(() => ctx.close(), 250);
        } catch {
          /* noop */
        }
      }
      this.level = 0.18;
    }
  }

  window.DawnAudio = { MicSource, decodeToMono16k, AlarmSynth, SR };
})();
