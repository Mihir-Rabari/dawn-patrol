/* Dawn Patrol — store.js
 * Journal + settings in localStorage. Your mornings never leave this device.
 */
(() => {
  const JKEY = 'dawnpatrol.journal.v1';
  const SKEY = 'dawnpatrol.settings.v1';

  const DEFAULTS = {
    sensitivity: 'normal', // relaxed | normal | strict
    requireSeconds: 6,
    threshold: 0.15,
  };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SKEY) || '{}');
      return { ...DEFAULTS, ...s };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(s) {
    localStorage.setItem(SKEY, JSON.stringify(s));
  }

  function loadJournal() {
    try {
      const j = JSON.parse(localStorage.getItem(JKEY) || '{"entries":[]}');
      if (!Array.isArray(j.entries)) return { entries: [] };
      return j;
    } catch {
      return { entries: [] };
    }
  }

  function saveEntry(entry) {
    const j = loadJournal();
    j.entries.unshift(entry);
    localStorage.setItem(JKEY, JSON.stringify(j));
    return entry;
  }

  function clearJournal() {
    localStorage.removeItem(JKEY);
  }

  /* consecutive-day streak across entries that have day stamps */
  function streak(entries, todayKey) {
    const days = new Set(entries.map((e) => e.dayKey).filter(Boolean));
    let n = 0;
    const d = new Date();
    for (;;) {
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) {
        n++;
      } else if (n > 0 || key !== todayKey) {
        break;
      }
      d.setDate(d.getDate() - 1);
      if (n > 3650) break;
    }
    return n;
  }

  function exportJournal() {
    return localStorage.getItem(JKEY) || '{"entries":[]}';
  }

  window.DawnStore = {
    loadSettings,
    saveSettings,
    loadJournal,
    saveEntry,
    clearJournal,
    streak,
    exportJournal,
    DEFAULTS,
  };
})();
