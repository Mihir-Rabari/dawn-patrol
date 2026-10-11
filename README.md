# Dawn Patrol (web companion)

> **This is now the companion/demo edition.** The real product — a native
> Android alarm clock — lives at
> [dawn-patrol-android](https://github.com/Mihir-Rabari/dawn-patrol-android)
> (installable APK in Releases). A website can't wake a sleeping phone; a
> native alarm can. This repo keeps the same verified engine as a browser
> demo + offline PWA.

The alarm clock that only stops for real birdsong.

Dawn Patrol refuses every snooze. When your alarm fires, it keeps ringing
until you take your phone outside and it hears actual birds — 30 seconds of
live microphone audio, classified **entirely on your device** by
[YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet),
a 4 MB open-weight audio model (Apache-2.0, Google Research). No server, no
API key, no network. Works in airplane mode.

Every morning ends with a **dawn census** — the bird sounds your yard made,
logged into a local field journal. Your data never leaves the phone.

**Live demo:** https://mihir-rabari.github.io/dawn-patrol/
(load it once — airplane mode after that is fine; the model is in the
service-worker cache).

## What each piece is

| File | Job |
|---|---|
| `model/yamnet.onnx` | the entire engine — mel frontend inside the model file, raw waveform in, 521 class scores out |
| `js/engine.js` | ONNX Runtime WASM wrapper + bird-evidence scoring (dedup cursor, 0.96s frames) |
| `js/audio.js` | mic capture (AudioWorklet, 16 kHz mono, noiseSuppression OFF) + procedural alarm + sample decode |
| `js/app.js` | state machine: setup → armed → ringing → listening → victory |
| `sw.js` | precache-everything offline PWA |
| `tools/` | the verification scripts — probe, threshold tuner (real traces committed) |

## Verification (same-day, real runs)

- Browser WASM: 3s window → `[6,521]` scores in ~1.1s, single-threaded.
- Real dawn chorus (CC BY-SA): best frame **Bird 0.999** → passes in ~6s.
- White noise 0.005 · silence 0.000 · speech-mumble 0.000 → never pass.
- Full loop verified live: test flow → demo chorus → victory at 8.64
  bird-seconds → census → journal persisted.
- The model even caught a **frog** in the real recording. Left in on purpose.

## Credits

- YAMNet — Apache-2.0 — Google Research / TensorFlow models.
- onnxruntime-web — MIT — ONNX Runtime.
- Demo sample: [Birdsong morning 01](https://commons.wikimedia.org/wiki/File:Birdsong_morning_01.ogg)
  by Matutinho, CC BY-SA 4.0 — see `samples/CREDITS.md`.
- Code: MIT (see LICENSE).

