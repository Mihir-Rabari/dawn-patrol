"""Dawn Patrol — bird-evidence scoring + threshold tuning.

Builds the bird-class index (which of YAMNet's 521 classes count as "bird
evidence"), then runs the model over real audio to choose thresholds with
ground truth:

  - samples/dawn-chorus-demo.wav  -> REAL birds: must PASS comfortably
  - synthetic chirp               -> must PASS
  - white noise / silence         -> must FAIL
  - speech-like audio             -> must FAIL (talking near the mic is not birds)

Outputs model/bird-classes.json (used by the app, committed for auditability)
and prints a per-second evidence trace for each test input.

Run:  /opt/data/dawn-venv/bin/python tools/tune_scoring.py
"""

import json
import os
import re
import sys

import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BIRD_PATTERNS = [
    r"\bbird",
    r"\bchirp",
    r"\btweet",
    r"\bowl\b",
    r"\brooster\b",
    r"\bcrow(ing)?\b",
    r"\braven\b",
    r"\bpigeon",
    r"\bdove",
    r"\bcuckoo",
    r"\bsparrow",
    r"\bwren\b",
    r"\bfinch",
    r"\bcanary\b",
    r"\bparrot",
    r"\bduck\b",
    r"\bgoose\b",
    r"\bswan\b",
    r"\bgull",
    r"\bhawk\b",
    r"\beagle\b",
    r"\bfalcon\b",
    r"\bhummingbird",
    r"\bwoodpecker",
    r"\bpeacock\b",
    r"\bturkey\b",
    r"\bquail\b",
    r"\bpheasant",
    r"\bchicken",
    r"\bhen\b",
    r"\bpoultry",
    r"\bclucking",
    r"\bsquawk",
]

# generic classes deliberately EXCLUDED even though animals: too broad, a dog or
# a lawnmower must not count as birds. "Chirp tone" is the ELECTRONIC chirp
# class (alarm beeps, radar) — including it would let our own alarm sound
# verify itself, so it stays out.
EXCLUDE_EXACT = {
    "Animal",
    "Wild animals",
    "Domestic animals, pets",
    "Chirp tone",
}


def load_class_map() -> dict:
    names = {}
    with open(os.path.join(ROOT, "model", "yamnet_class_map.csv"), encoding="utf-8") as f:
        f.readline()
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            idx, _mid, disp = line.split(",", 2)
            names[int(idx)] = disp.strip().strip('"')
    return names


def bird_index(names: dict) -> list[dict]:
    out = []
    for i, disp in names.items():
        if disp in EXCLUDE_EXACT:
            continue
        if any(re.search(p, disp, re.IGNORECASE) for p in BIRD_PATTERNS):
            out.append({"index": i, "name": disp, "weight": 1.0})
    return out


def evidence_per_second(scores: np.ndarray, bird_idx: list[dict], thresh: float) -> np.ndarray:
    """scores: [frames, 521]. YAMNet emits ~1 frame per 0.96s; we approximate
    per-frame evidence = max bird-class score, then threshold."""
    idxs = [b["index"] for b in bird_idx]
    bird_scores = scores[:, idxs]  # [frames, n_bird]
    frame_max = bird_scores.max(axis=1)
    return frame_max, (frame_max >= thresh).astype(np.float32)


def run_trace(label: str, wav: np.ndarray, sess, names, bird_idx, thresh=0.15) -> None:
    inp = sess.get_inputs()[0].name
    out = sess.run([sess.get_outputs()[0].name], {inp: wav})[0]
    frame_max, hit = evidence_per_second(out, bird_idx, thresh)
    print(f"--- {label} ({len(wav)/16000:.1f}s, {len(frame_max)} frames)")
    bar = "".join("#" if h else "." for h in hit)
    print(f"    evidence trace (>= {thresh}): {bar}")
    print(f"    frame max: min={frame_max.min():.3f} mean={frame_max.mean():.3f} max={frame_max.max():.3f}")
    print(f"    bird-seconds: {hit.sum():.1f}/{len(hit)}")
    if frame_max.size:
        best = int(np.argmax(frame_max))
        print(f"    best frame classes:")
        for i in np.argsort(out[best])[::-1][:4]:
            print(f"        {out[best][i]:.3f} {names.get(i, '?')}")


def main() -> None:
    import soundfile as sf

    names = load_class_map()
    bidx = bird_index(names)
    print(f"bird index: {len(bidx)} classes of {len(names)}")
    for b in bidx:
        print(f"    {b['index']:3d} {b['name']}")

    with open(os.path.join(ROOT, "model", "bird-classes.json"), "w", encoding="utf-8") as f:
        json.dump(bidx, f, indent=1)
    print("wrote model/bird-classes.json")

    sess = ort.InferenceSession(os.path.join(ROOT, "model", "yamnet.onnx"), providers=["CPUExecutionProvider"])

    tests = []
    sample_path = os.path.join(ROOT, "samples", "dawn-chorus-demo.wav")
    if os.path.exists(sample_path):
        data, sr = sf.read(sample_path, dtype="float32")
        assert sr == 16000
        tests.append(("REAL dawn chorus (bundled sample)", data))
    sys.path.insert(0, HERE)
    from probe_model import synth_bird_chirp, synth_silence, synth_white_noise  # noqa: E402

    tests.append(("synthetic chirp", synth_bird_chirp(6.0)))
    tests.append(("white noise", synth_white_noise(6.0)))
    tests.append(("silence", synth_silence(3.0)))
    # speech-ish: filtered noise bursts in human vocal band (rough stand-in)
    rng = np.random.default_rng(3)
    t = np.arange(16000 * 5) / 16000
    speech = np.zeros_like(t)
    for _ in range(30):
        s = rng.uniform(0, 4.5)
        dur = rng.uniform(0.08, 0.3)
        m = (t >= s) & (t <= s + dur)
        f0 = rng.uniform(90, 220)
        speech[m] += np.sin(2 * np.pi * f0 * t[m]) * (1 + 0.6 * np.sin(2 * np.pi * 5 * t[m]))
    speech = (speech / np.max(np.abs(speech)) * 0.8).astype(np.float32)
    tests.append(("speech-like (mumbled vowels)", speech))

    for label, wav in tests:
        run_trace(label, np.asarray(wav, dtype=np.float32), sess, names, bidx)


if __name__ == "__main__":
    main()
