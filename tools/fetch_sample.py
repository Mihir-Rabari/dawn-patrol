"""Dawn Patrol — fetch and prepare the bundled demo sample.

Downloads a CC-licensed dawn-chorus recording from Wikimedia Commons,
converts it to 16 kHz mono WAV (the format the app bundles for demo mode),
and writes a credits file so the license chain is auditable.

Run:  /opt/data/dawn-venv/bin/python tools/fetch_sample.py
"""

import json
import os
import time
import urllib.request

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SAMPLES = os.path.join(ROOT, "samples")
os.makedirs(SAMPLES, exist_ok=True)

UA = {"User-Agent": "dawn-patrol-build/0.1 (hackathon build; contact via GitHub)"}
TARGET_SR = 16000
CLIP_SECONDS = 30
CLIP_OFFSET = 10  # skip the first quiet seconds

CANDIDATES = [
    {
        "file": "File:Birdsong morning 01.ogg",
        "reason": "small ogg, birdsong, CC BY-SA 4.0",
    },
    {
        "file": "File:Home Dawn Chorus 2020-04-28 0600.mp3",
        "reason": "mp3 fallback, CC BY-SA 4.0",
    },
]


def api_imageinfo(title: str) -> dict:
    url = (
        "https://commons.wikimedia.org/w/api.php?action=query&format=json"
        f"&titles={urllib.request.quote(title)}&prop=imageinfo"
        "&iiprop=url|extmetadata|mime|size"
    )
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    page = next(iter(d["query"]["pages"].values()))
    ii = page["imageinfo"][0]
    meta = ii.get("extmetadata", {})
    strip = lambda s: (  # noqa: E731
        str(s).replace("<a href=", "").replace("&amp;", "&")[:200]
    )
    return {
        "title": title,
        "url": ii["url"],
        "mime": ii["mime"],
        "size": ii["size"],
        "license": meta.get("LicenseShortName", {}).get("value", "?"),
        "artist": strip(meta.get("Artist", {}).get("value", "?")),
        "desc_url": f"https://commons.wikimedia.org/wiki/{title.replace(' ', '_')}",
    }


def resample_linear(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return x
    n_out = int(len(x) * sr_out / sr_in)
    idx = np.linspace(0.0, len(x) - 1, n_out)
    return np.interp(idx, np.arange(len(x)), x)


def main() -> None:
    chosen = None
    for cand in CANDIDATES:
        try:
            time.sleep(2)  # be polite to the API
            info = api_imageinfo(cand["file"])
            print(f"candidate: {info['title']} | {info['mime']} | {info['size']/1e6:.1f}MB | {info['license']}")
            dest = os.path.join(SAMPLES, "_download")
            req = urllib.request.Request(info["url"], headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                f.write(r.read())
            data, sr = sf.read(dest, dtype="float32", always_2d=False)
            if data.ndim > 1:
                data = data.mean(axis=1)
            data = resample_linear(data.astype(np.float64), sr, TARGET_SR).astype(np.float32)
            start = int(CLIP_OFFSET * TARGET_SR)
            end = min(len(data), start + CLIP_SECONDS * TARGET_SR)
            clip = data[start:end]
            peak = float(np.max(np.abs(clip)))
            if peak > 0:
                clip = clip / peak * 0.9
            wav_path = os.path.join(SAMPLES, "dawn-chorus-demo.wav")
            sf.write(wav_path, clip, TARGET_SR, subtype="PCM_16")
            os.remove(dest)
            chosen = {**info, "wav": wav_path, "clip_seconds": round(end - start) / TARGET_SR}
            break
        except Exception as e:  # noqa: BLE001
            print(f"  failed ({cand['file']}): {type(e).__name__}: {e}")

    if not chosen:
        raise SystemExit("no sample downloaded")

    credits = (
        "# Sample credits\n\n"
        f"- `dawn-chorus-demo.wav` — {chosen['clip_seconds']:.0f}s excerpt, resampled to 16 kHz mono,\n"
        "  from:\n"
        f"  - Source: {chosen['desc_url']}\n"
        f"  - Author: {chosen['artist']}\n"
        f"  - License: {chosen['license']} (Wikimedia Commons)\n\n"
        "The excerpt is bundled so the demo works without a microphone (judges on\n"
        "laptops, or phones where mic permission is awkward). The app itself does\n"
        "live classification from the microphone — this file is only a demo input.\n"
    )
    with open(os.path.join(SAMPLES, "CREDITS.md"), "w", encoding="utf-8") as f:
        f.write(credits)
    print("wrote", chosen["wav"])
    print(credits)


if __name__ == "__main__":
    main()
