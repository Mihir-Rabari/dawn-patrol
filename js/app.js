/* Dawn Patrol — app.js
 * The alarm clock that only stops for real birdsong.
 *
 * State machine:  SETUP -> ARMED -> RINGING -> LISTENING -> VICTORY
 * Listening sources: live microphone | bundled dawn-chorus sample | any file.
 * All classification is on-device (see js/engine.js). Nothing leaves the page.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const FRAME_S = 0.96;
  const SENSITIVITY = {
    relaxed: { threshold: 0.1, requireSeconds: 4 },
    normal: { threshold: 0.15, requireSeconds: 6 },
    strict: { threshold: 0.25, requireSeconds: 8 },
  };

  const engine = new window.DawnEngine();
  const alarm = new window.DawnAudio.AlarmSynth();
  let mic = null;
  let settings = window.DawnStore.loadSettings();
  let pendingFileBytes = null;
  let view = 'setup';
  let alarmAt = null;
  let armedTick = null;
  let ringStart = null;
  let listen = null; // {source, timer, birdSeconds, census, frames, lastHearing}
  let wakeLock = null;

  /* ---------- helpers ---------- */

  function fmtClock(d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setView(v) {
    view = v;
    document.body.dataset.view = v;
    for (const el of document.querySelectorAll('[data-view]')) {
      el.hidden = el.dataset.view.split(' ').indexOf(v) === -1;
    }
  }

  function thresholds() {
    return SENSITIVITY[settings.sensitivity] || SENSITIVITY.normal;
  }

  function status(msg, isError = false) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function requestWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          wakeLock = l;
          l.addEventListener('release', () => (wakeLock = null));
        })
        .catch(() => {});
    }
  }

  /* ---------- alarm lifecycle ---------- */

  function armAlarm() {
    const t = $('alarm-time').value;
    if (!t) {
      status('Pick a wake time first.', true);
      return;
    }
    const [h, m] = t.split(':').map(Number);
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    alarmAt = at;
    status('');
    requestWakeLock();
    setView('armed');
    tickArmed();
    armedTick = setInterval(tickArmed, 1000);
  }

  function tickArmed() {
    const ms = alarmAt - new Date();
    if (ms <= 0) {
      clearInterval(armedTick);
      armedTick = null;
      startRinging();
      return;
    }
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    $('countdown').textContent = `${h}h ${m}m ${String(sec).padStart(2, '0')}s`;
    $('armed-for').textContent = fmtClock(alarmAt);
  }

  function startRinging() {
    ringStart = Date.now();
    try {
      alarm.start();
    } catch {
      /* autoplay until user gesture — first tap will resume */
    }
    setView('ringing');
    // warm the model NOW if it somehow isn't
    engine.load().catch((e) => status('Model failed to load: ' + e.message, true));
  }

  function dismissArmed() {
    if (armedTick) clearInterval(armedTick);
    armedTick = null;
    setView('setup');
  }

  /* ---------- listening ---------- */

  async function startListening(source) {
    engine
      .load()
      .then(() => status(''))
      .catch((e) => status('Model failed to load: ' + e.message, true));
    listen = {
      source, // 'mic' | 'sample' | 'file'
      timer: null,
      birdSeconds: 0,
      frames: 0,
      census: {},
      lastHearing: null,
      t0: Date.now(),
      errored: false,
    };
    engine.lastFrameTime = -Infinity;
    setView('listening');
    $('listen-mode').textContent =
      source === 'mic'
        ? 'Live microphone'
        : source === 'sample'
          ? 'Demo: bundled dawn chorus (CC BY-SA, see credits)'
          : 'Demo: your file';
    updateMeter();

    if (source === 'mic') {
      mic = new window.DawnAudio.MicSource();
      mic.onLevel((rms) => {
        $('level-bar').style.width = Math.min(100, Math.round(Math.sqrt(rms) * 160)) + '%';
      });
      try {
        await mic.start();
      } catch (e) {
        listen.errored = true;
        status(
          'Microphone unavailable (' + e.name + '). Demo modes below use the same verification.',
          true,
        );
        $('source-mic').disabled = true;
        $('mic-fallback').hidden = false;
        return;
      }
      pollMic();
    } else {
      try {
        let bytes;
        if (source === 'sample') {
          bytes = await (await fetch('samples/dawn-chorus-demo.wav')).arrayBuffer();
        } else {
          bytes = pendingFileBytes;
        }
        if (!bytes) {
          status('No file loaded.', true);
          return;
        }
        const pcm = await window.DawnAudio.decodeToMono16k(bytes);
        streamBuffered(pcm);
      } catch (e) {
        status('Could not decode audio: ' + e.message, true);
        return;
      }
    }
  }

  function stopListening() {
    if (mic) {
      mic.stop();
      mic = null;
    }
    if (listen && listen.timer) {
      clearTimeout(listen.timer);
      listen.timer = null;
    }
  }

  /* live mic: classify the rolling window every ~1.5 s */
  function pollMic() {
    if (!listen || listen.source !== 'mic' || !mic || !mic.active) return;
    const windowSec = 3;
    const have = mic.elapsed();
    if (have >= 1 && engine.session) {
      const windowStart = Math.max(0, have - windowSec);
      const samples = mic.latest(windowSec);
      runClassification(samples, windowStart);
    }
    listen.timer = setTimeout(pollMic, 1500);
  }

  /* demo sources: replay the buffer through the same engine in 3 s windows */
  function streamBuffered(pcm) {
    const SR = window.DawnAudio.SR;
    const win = SR * 3;
    let pos = 0;
    const stepMs = 1400;
    const step = () => {
      if (!listen || view !== 'listening' || listen.source === 'mic') return;
      if (pos >= pcm.length) {
        // exhausted the buffer: stop and let the user retry/switch
        status('Buffer finished before proof of dawn. Try the sample or go outside.', true);
        return;
      }
      const end = Math.min(pos + win, pcm.length);
      const slice = pcm.slice(pos, end);
      runClassification(slice, pos / SR);
      pos = end;
      listen.timer = setTimeout(step, stepMs);
    };
    if (pcm.length < 16000) {
      status('Clip too short — need at least a second.', true);
      return;
    }
    step();
  }

  async function runClassification(samples, windowStart) {
    const { threshold } = thresholds();
    let res;
    try {
      res = await engine.classifyWindow(samples, { windowStart });
    } catch (e) {
      status('Inference error: ' + e.message, true);
      return;
    }
    if (!res || !listen) return;
    // engine.classifyWindow already deduplicated overlapping windows:
    // `counted` is exactly the set of NEW frames to accumulate.
    for (const fr of res.counted) {
      listen.frames++;
      if (fr.evidence >= threshold) {
        listen.birdSeconds += FRAME_S;
      }
      if (fr.best) {
        const c = listen.census[fr.best.name] || { max: 0, hits: 0 };
        c.max = Math.max(c.max, fr.evidence);
        c.hits += fr.evidence >= threshold ? 1 : 0;
        listen.census[fr.best.name] = c;
      }
    }
    const lastFrame = res.frames[res.frames.length - 1];
    if (lastFrame) {
      listen.lastHearing = lastFrame.top3
        .filter((c) => c.score > 0.08)
        .map((c) => `${c.name} ${(c.score * 100).toFixed(0)}%`)
        .join(' · ');
      $('hearing').textContent = listen.lastHearing || '…';
    }
    updateMeter();
    if (listen.birdSeconds >= thresholds().requireSeconds) {
      victory();
    }
  }

  function updateMeter() {
    const req = thresholds().requireSeconds;
    const pct = Math.min(100, ((listen ? listen.birdSeconds : 0) / req) * 100);
    $('ring-fill').style.strokeDashoffset = String(289 - (289 * pct) / 100);
    $('bird-seconds').textContent = (listen ? listen.birdSeconds : 0).toFixed(1);
    $('req-seconds').textContent = String(req);
    const min = Math.floor((Date.now() - (listen ? listen.t0 : Date.now())) / 60000);
    const sec = Math.floor(((Date.now() - (listen ? listen.t0 : Date.now())) % 60000) / 1000);
    $('listen-elapsed').textContent = `${min}:${String(sec).padStart(2, '0')}`;
    const hinted = listen && Date.now() - listen.t0 > 90000 && listen.birdSeconds < 0.96;
    $('frustration-hint').hidden = !hinted;
  }

  function victory() {
    alarm.stop();
    if (mic) {
      mic.stop();
      mic = null;
    }
    if (listen && listen.timer) {
      clearTimeout(listen.timer);
      listen.timer = null;
    }
    const entry = {
      ts: Date.now(),
      dayKey: new Date().toISOString().slice(0, 10),
      mode: listen ? listen.source : 'mic',
      wakeAt: ringStart ? new Date(ringStart).toISOString() : null,
      dismissedAfterSec: Math.round((Date.now() - (ringStart || Date.now())) / 1000),
      birdSeconds: +(listen ? listen.birdSeconds : 0).toFixed(2),
      sensitivity: settings.sensitivity,
      census: listen ? listen.census : {},
    };
    window.DawnStore.saveEntry(entry);
    renderVictory(entry);
    renderJournal();
    setView('victory');
    if (wakeLock) {
      try {
        wakeLock.release();
      } catch {
        /* noop */
      }
      wakeLock = null;
    }
  }

  function concede() {
    alarm.stop();
    if (mic) {
      mic.stop();
      mic = null;
    }
    if (listen && listen.timer) clearTimeout(listen.timer);
    window.DawnStore.saveEntry({
      ts: Date.now(),
      dayKey: new Date().toISOString().slice(0, 10),
      mode: listen ? listen.source : 'mic',
      wakeAt: ringStart ? new Date(ringStart).toISOString() : null,
      dismissedAfterSec: Math.round((Date.now() - (ringStart || Date.now())) / 1000),
      birdSeconds: 0,
      conceded: true,
      sensitivity: settings.sensitivity,
      census: {},
    });
    listen = null;
    renderJournal();
    setView('setup');
    status('Conceded — logged honestly. The birds won this round.');
  }

  /* ---------- rendering ---------- */

  function renderVictory(entry) {
    $('victory-line').textContent =
      entry.mode === 'mic'
        ? `Alarm off in ${Math.round(entry.dismissedAfterSec / 60)}m ${entry.dismissedAfterSec % 60}s — the real world vouched for you.`
        : `Alarm off (demo mode) — ${entry.birdSeconds}s of verified birdsong.`;
    const census = Object.entries(entry.census)
      .filter(([, c]) => c.hits > 0)
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, 6);
    const box = $('census');
    box.textContent = '';
    if (!census.length) {
      const p = document.createElement('p');
      p.textContent = 'No bird classes crossed the threshold — try relaxed sensitivity.';
      box.appendChild(p);
    }
    for (const [name, c] of census) {
      const row = document.createElement('div');
      row.className = 'census-row';
      const label = document.createElement('span');
      label.textContent = name;
      const barWrap = document.createElement('span');
      barWrap.className = 'bar';
      const bar = document.createElement('i');
      bar.style.width = Math.min(100, c.hits * 25) + '%';
      barWrap.appendChild(bar);
      const count = document.createElement('span');
      count.textContent = `${c.hits}× · peak ${(c.max * 100).toFixed(0)}%`;
      row.append(label, barWrap, count);
      box.appendChild(row);
    }
  }

  function renderJournal() {
    const { entries } = window.DawnStore.loadJournal();
    $('streak').textContent = String(window.DawnStore.streak(entries));
    $('journal-count').textContent = String(entries.length);
    const list = $('journal-list');
    list.textContent = '';
    for (const e of entries.slice(0, 30)) {
      const card = document.createElement('div');
      card.className = 'journal-card' + (e.conceded ? ' conceded' : '');
      const head = document.createElement('div');
      head.className = 'j-head';
      const when = new Date(e.ts);
      head.textContent = `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmtClock(when)} · ${e.mode === 'mic' ? 'live' : 'demo'}`;
      const title = document.createElement('strong');
      title.textContent = e.conceded ? 'conceded' : `${e.birdSeconds}s of birdsong`;
      head.appendChild(title);
      card.appendChild(head);
      const meta = document.createElement('div');
      meta.className = 'j-meta';
      meta.textContent = Object.entries(e.census || {})
        .filter(([, c]) => c.hits > 0)
        .slice(0, 3)
        .map(([n]) => n)
        .join(' · ');
      card.appendChild(meta);
      list.appendChild(card);
    }
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'j-empty';
      empty.textContent = 'No mornings logged yet.';
      list.appendChild(empty);
    }
  }

  /* ---------- offline ---------- */

  function refreshOnline() {
    const off = !navigator.onLine;
    $('offline-badge').hidden = !off;
  }

  /* ---------- boot ---------- */

  document.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.addEventListener('online', refreshOnline);
    window.addEventListener('offline', refreshOnline);
    refreshOnline();

    const timeInput = $('alarm-time');
    const soon = new Date(Date.now() + 8 * 3600 * 1000);
    timeInput.value = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;

    $('arm-btn').addEventListener('click', armAlarm);
    $('disarm-btn').addEventListener('click', dismissArmed);
    $('test-btn').addEventListener('click', startRinging);
    $('source-mic').addEventListener('click', () => startListening('mic'));
    $('source-sample').addEventListener('click', () => startListening('sample'));
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      f.arrayBuffer().then((b) => {
        pendingFileBytes = b;
        startListening('file');
      });
    });
    $('source-sample-2').addEventListener('click', () => startListening('sample'));
    $('file-input-2').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      f.arrayBuffer().then((b) => {
        pendingFileBytes = b;
        startListening('file');
      });
    });
    $('concede-btn').addEventListener('click', concede);
    $('back-btn').addEventListener('click', () => {
      stopListening();
      listen = null;
      setView('setup');
      status('');
    });
    $('again-btn').addEventListener('click', () => {
      stopListening();
      listen = null;
      setView('setup');
      status('');
    });
    $('sensitivity').value = settings.sensitivity;
    $('sensitivity').addEventListener('change', (e) => {
      settings.sensitivity = e.target.value;
      window.DawnStore.saveSettings(settings);
      updateMeter();
    });
    $('export-btn').addEventListener('click', () => {
      const blob = new Blob([window.DawnStore.exportJournal()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dawn-patrol-journal.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('clear-btn').addEventListener('click', () => {
      if (confirm('Delete all journal entries on this device?')) {
        window.DawnStore.clearJournal();
        renderJournal();
      }
    });

    engine.load().catch((e) => status('Model failed to load: ' + e.message, true));
    renderJournal();
    setView('setup');
  });
})();
