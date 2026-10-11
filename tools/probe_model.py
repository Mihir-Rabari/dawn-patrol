"""Dawn Patrol — model probe.

Answers the make-or-break questions before any app code is written:
  1. What input/output contract does each candidate YAMNet ONNX export have?
     (raw waveform in = whole frontend inside the model; mel in = we do features in JS)
  2. Does it produce sane scores? (synthetic chirp should light up bird classes,
     white noise and silence should not)
  3. Can we fetch a real CC-licensed birdsong recording to use as a bundled demo
     sample, with its license recorded?

Run:  /opt/data/dawn-venv/bin/python tools/probe_model.py
"""

import json
import math
import os
import random
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODEL_DIR = os.path.join(ROOT, "model")
SCRATCH = os.path.join(ROOT, "..", "dawn-scratch")
os.makedirs(SCRATCH, exist_ok=True)

SR = 16000


def fetch(url: str, dest: str, timeout: int = 60) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "dawn-patrol-probe/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        f.write(r.read())


def load_class_map() -> dict:
    names = {}
    with open(os.path.join(MODEL_DIR, "yamnet_class_map.csv"), encoding="utf-8") as f:
        header = f.readline()
        assert "display_name" in header, f"unexpected class map header: {header}"
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            idx, _mid, disp = line.split(",", 2)
            names[int(idx)] = disp.strip()
    return names


def synth_bird_chirp(seconds: float = 3.0) -> np.ndarray:
    """Repeated FM chirps: 3-6 kHz sweeps with amplitude trills."""
    rng = random.Random(42)
    t_total = np.arange(int(seconds * SR)) / SR
    out = np.zeros_like(t_total)
    pos = 0.0
    while pos < seconds - 0.4:
        chirp_len = rng.uniform(0.05, 0.12)
        f0 = rng.uniform(2800, 4200)
        f1 = rng.uniform(4500, 6500)
        n = int(chirp_len * SR)
        t = np.arange(n) / SR
        freq = f0 + (f1 - f0) * (t / chirp_len)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        trill = 0.5 * (1 + np.sin(2 * np.pi * rng.uniform(60, 110) * t))
        seg = np.sin(phase) * trill
        start = int(pos * SR)
        out[start : start + n] += seg
        pos += chirp_len + rng.uniform(0.08, 0.25)
    peak = np.max(np.abs(out))
    return (out / peak * 0.9).astype(np.float32)


def synth_white_noise(seconds: float = 3.0) -> np.ndarray:
    rng = np.random.default_rng(7)
    return (rng.uniform(-1, 1, int(seconds * SR)) * 0.3).astype(np.float32)


def synth_silence(seconds: float = 1.0) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


COMMONS_QUERIES = ["dawn chorus birdsong", "birdsong recording", "birds singing morning"]


def commons_search_audio(query: str) -> list[dict]:
    api = (
        "https://commons.wikimedia.org/w/api.php?action=query&format=json"
        f"&list=search&srsearch={urllib.request.quote(query + ' filetype:audio')}&srnamespace=6&srlimit=10"
    )
    req = urllib.request.Request(api, headers={"User-Agent": "dawn-patrol-probe/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    titles = [h["title"] for h in data.get("query", {}).get("search", [])]
    results = []
    for title in titles:
        info = (
            "https://commons.wikimedia.org/w/api.php?action=query&format=json"
            f"&titles={urllib.request.quote(title)}&prop=imageinfo&iiprop=url|extmetadata|mime|size"
        )
        try:
            req2 = urllib.request.Request(info, headers={"User-Agent": "dawn-patrol-probe/0.1"})
            with urllib.request.urlopen(req2, timeout=20) as r2:
                d2 = json.load(r2)
            page = next(iter(d2["query"]["pages"].values()))
            ii = page.get("imageinfo", [{}])[0]
            meta = ii.get("extmetadata", {})
            results.append(
                {
                    "title": title,
                    "url": ii.get("url", ""),
                    "mime": ii.get("mime", ""),
                    "size": ii.get("size", 0),
                    "license": meta.get("LicenseShortName", {}).get("value", "?"),
                    "artist": meta.get("Artist", {}).get("value", "?")[:80],
                }
            )
        except Exception as e:  # noqa: BLE001
            results.append({"title": title, "error": str(e)})
    return results


def main() -> None:
    import onnxruntime as ort

    classes = load_class_map()
    print(f"class map loaded: {len(classes)} classes")

    candidates = {
        "zeropointnine": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx",
        "andrelgomes": "https://huggingface.co/andrelgomes/yamnet-onnx/resolve/main/yamnet.onnx",
    }
    local = {}
    for name, url in candidates.items():
        dest = os.path.join(SCRATCH, f"{name}_yamnet.onnx")
        if not os.path.exists(dest):
            print(f"downloading {name} ...")
            fetch(url, dest)
        local[name] = dest
        print(f"  {name}: {os.path.getsize(dest)/1e6:.1f} MB")

    tests = {
        "synthetic_chirp": synth_bird_chirp(),
        "white_noise": synth_white_noise(),
        "silence": synth_silence(),
    }

    for name, path in local.items():
        print(f"\n================ {name} ================")
        try:
            sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        except Exception as e:  # noqa: BLE001
            print(f"  LOAD FAILED: {e}")
            continue
        for inp in sess.get_inputs():
            print(f"  input : {inp.name} shape={inp.shape} dtype={inp.type}")
        for out in sess.get_outputs():
            print(f"  output: {out.name} shape={out.shape} dtype={out.type}")

        for tname, wav in tests.items():
            try:
                scores_name = sess.get_outputs()[0].name
                inp_name = sess.get_inputs()[0].name
                outs = sess.run([scores_name], {inp_name: wav})
                scores = outs[0]
                if scores.ndim == 3:
                    scores = scores[0]
                mean = scores.mean(axis=0)
                top = np.argsort(mean)[::-1][:8]
                print(f"  [{tname}] out shape={list(outs[0].shape)}")
                for i in top:
                    print(f"      {mean[i]:.3f}  {classes.get(i, '?')}")
            except Exception as e:  # noqa: BLE001
                print(f"  [{tname}] RUN FAILED: {type(e).__name__}: {e}")

    print("\n================ commons audio hunt ================")
    seen = set()
    for q in COMMONS_QUERIES:
        try:
            for r in commons_search_audio(q):
                key = r["title"]
                if key in seen:
                    continue
                seen.add(key)
                if "error" in r:
                    print(f"  {r['title']} ERROR {r['error']}")
                    continue
                print(
                    f"  {r['license']:<18} {r['size']/1e6:6.1f}MB {r['mime']:<12} {r['title'][:60]} | {r['artist']}"
                )
        except Exception as e:  # noqa: BLE001
            print(f"  query '{q}' failed: {e}")


if __name__ == "__main__":
    main()
