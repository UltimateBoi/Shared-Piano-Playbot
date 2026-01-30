// ==UserScript==
// @name         Shared Piano Playbot
// @namespace    http://qriositylog.com/
// @version      2.0
// @description  Fast MIDI playback with draggable UI panel, seek, unlimited speed, pause/resume/stop, transpose, sustain for the chrome Shared Piano Experiment
// @author       Queue-ri
// @match        https://musiclab.chromeexperiments.com/Shared-Piano/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js
// ==/UserScript==
/* global Midi */

(function () {
  'use strict';

  // -------------------- Utilities --------------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const whenDefined = (tag) => customElements.whenDefined(tag);
  const nowSec = () => performance.now() / 1000;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lsGet = (k, d=null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const waitFor = (sel, root = document) =>
    new Promise((resolve) => {
      const t = setInterval(() => {
        const el = root.querySelector(sel);
        if (el) { clearInterval(t); resolve(el); }
      }, 100);
    });

  // -------------------- Autoplay (Chrome policy) --------------------
  async function resumeAudioIfNeeded() {
    try {
      if (window.Tone?.start) {
        await window.Tone.start();
      } else {
        const ctx =
          window.Tone?.getContext?.()?.rawContext ||
          window.audioContext ||
          null;
        if (ctx?.state === 'suspended') await ctx.resume();
      }
    } catch (e) {
      console.debug('Audio resume attempt failed (non-fatal)', e);
    }
  }

  // -------------------- File input --------------------
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mid,.midi';
  input.style.display = 'none';
  document.body.appendChild(input);

  // -------------------- Global state --------------------
  let notes = [];                // sorted merged notes
  let pieceDurationSec = 0;      // original total piece duration (seconds)

  let transposeOffset = 0;       // semitones
  let bpm = 120;

  // Sustain
  let sustainMs = 2000;
  let autoSustain = true;
  let linkSustainToTempo = true; // link sustain interval to speed factor

  // Speed (unlimited via manual input)
  let speedFactor = 1.0;

  // Scheduler state
  let playState = 'stopped';     // 'stopped' | 'playing' | 'paused'
  let startEpoch = 0;            // performance time at (re)start
  let offsetTimeSec = 0;         // effective timeline seconds (already scaled by speed)
  let currentIndex = 0;          // next note to schedule
  let scheduleTimer = null;      // setInterval handle
  let sustainTimer = null;       // sustain retrigger interval
  let lookaheadMs = 25;          // scheduler tick interval (configurable)
  let scheduleAheadSec = 0.20;   // how far ahead to schedule (configurable)
  let progressTimer = null;      // seek bar updater

  // Prewarm state
  const warmedOctaves = new Set(); // e.g., '3','4','5'

  // Keyboard DOM mapping
  let p = [];       // octaves
  const keys = {};  // 'C#4' -> element
  let pianoInput = null;   // <piano-input> API (keyDown/keyUp)

  // UI elements
  let ui = {};

  // -------------------- MIDI loading & prep --------------------
  function parseAndPrepareMidi(midi) {
    const all = [];
    midi.tracks.forEach(t => {
      t.notes.forEach(n => {
        all.push({
          name: n.name,        // "C#4"
          midi: n.midi,        // 0..127
          time: n.time,        // seconds (original timeline)
          duration: n.duration // seconds
        });
      });
    });
    all.sort((a, b) => (a.time - b.time) || (a.midi - b.midi));
    notes = all;

    // compute piece duration in original timeline
    pieceDurationSec = 0;
    for (const n of notes) {
      pieceDurationSec = Math.max(pieceDurationSec, n.time + n.duration);
    }

    bpm = Math.floor(midi.header.tempos?.[0]?.bpm || 120);
    sustainMs = 480000 / bpm;    // 4 measures in ms at given BPM
    if (sustainMs > 3000) sustainMs /= 2;

    updateStatus(`Loaded. BPM=${bpm}  Notes=${notes.length}  Dur=${pieceDurationSec.toFixed(2)}s`);
    updateSeekRange();      // refresh seek slider max
    prewarmUsedOctavesSoon();
  }

  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const midi = new Midi(ev.target.result);
        parseAndPrepareMidi(midi);
        // reset playback state for new song
        stop();
      } catch (err) {
        console.error('MIDI parse failed', err);
        updateStatus('Failed to parse MIDI.');
      }
    };
    reader.readAsArrayBuffer(file);
  });

  // -------------------- Note name <-> MIDI helpers --------------------
  const NOTE_TO_SEMITONE = {
    'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4,
    'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11
  };
  const SEMITONE_TO_NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  function nameToMidi(name) {
    const m = /^([A-G]#?)(-?\d+)$/.exec(name);
    if (!m) return null;
    const pitch = m[1];
    const oct = parseInt(m[2], 10);
    return (oct + 1) * 12 + NOTE_TO_SEMITONE[pitch];
  }
  function midiToName(midi) {
    const n = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return `${SEMITONE_TO_NOTE[n]}${oct}`;
  }
  function transposedName(name, offset) {
    const m = nameToMidi(name);
    if (m == null) return name;
    const mm = clamp(m + offset, 24, 107); // clamp to C1..B7 for Shared Piano
    return midiToName(mm);
  }
  function nameToOctave(name) {
    const m = /^([A-G]#?)(-?\d+)$/.exec(name);
    return m ? m[2] : null;
  }

  // -------------------- Keyboard mapping --------------------
  async function mapKeyboard() {
    const kbHost = await waitFor('#piano > piano-keyboard');
    pianoInput = document.querySelector('piano-input') || null;

    const octaves = kbHost.shadowRoot.querySelectorAll('#container > piano-keyboard-octave');
    if (!octaves?.length) {
      await wait(300);
      return mapKeyboard();
    }
    p = [...octaves];

    const whites = p.map((o) => o.shadowRoot.querySelectorAll('#container > #white-notes > piano-keyboard-note'));
    const blacks = p.map((o) => o.shadowRoot.querySelectorAll('#container > #black-notes > piano-keyboard-note'));
    const sharpIndexMap = { 'C#': 1, 'D#': 2, 'F#': 4, 'G#': 5, 'A#': 6 };

    for (let octave = 1; octave <= 7; octave++) {
      const w = whites[octave - 1];
      const b = blacks[octave - 1];
      if (!w || !b || w.length < 7) continue;
      // White notes
      keys[`C${octave}`] = w[0];
      keys[`D${octave}`] = w[1];
      keys[`E${octave}`] = w[2];
      keys[`F${octave}`] = w[3];
      keys[`G${octave}`] = w[4];
      keys[`A${octave}`] = w[5];
      keys[`B${octave}`] = w[6];
      // Black notes
      for (const [name, idx] of Object.entries(sharpIndexMap)) {
        keys[`${name}${octave}`] = b[idx];
      }
    }

    // Optional: force 7 octaves manual sizing if available
    const setting = document.querySelector('piano-settings');
    if (setting) {
      setting.resizeMode = 'manual';
      setting.octaves = 7;
    }
  }

  // -------------------- Sustain helpers --------------------
  function sustainDown() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
  }
  function sustainUp() {
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }));
  }
  function effectiveSustainIntervalMs() {
    return linkSustainToTempo ? Math.max(10, Math.round(sustainMs / Math.max(0.0001, speedFactor))) : sustainMs;
  }
  function beginAutoSustain() {
    if (!autoSustain) return;
    clearInterval(sustainTimer);
    sustainDown();
    sustainTimer = setInterval(() => { sustainUp(); sustainDown(); }, effectiveSustainIntervalMs());
  }
  function stopAutoSustain() {
    clearInterval(sustainTimer);
    sustainUp();
  }

  // -------------------- Press logic (prefer piano-input) --------------------
  function press_and_schedule(name, durationMs) {
    const midi = nameToMidi(name);
    // Prefer using the official input API if present (more reliable for samples)
    if (pianoInput && typeof pianoInput.keyDown === 'function' && midi != null) {
      try {
        pianoInput.keyDown(midi, 0.75); // velocity
        const t = setTimeout(() => {
          try { pianoInput.keyUp(midi); } catch {}
        }, Math.max(1, durationMs));
        return;
      } catch (e) {
        // fall through to clicked fallback
      }
    }
    // Fallback: visual "clicked" toggle
    const el = keys[name];
    if (!el) return;
    el.clicked = true;
    setTimeout(() => { el.clicked = false; }, Math.max(1, durationMs));
  }

  // -------------------- Readiness & prewarm --------------------
  async function ensureInstrumentReady() {
    await customElements.whenDefined('piano-keyboard');
    await customElements.whenDefined('piano-input');

    // Probe C4 to ensure internal sampler is initialized
    const probe = async () => {
      const tap = (name) => {
        const m = nameToMidi(name);
        if (pianoInput && typeof pianoInput.keyDown === 'function' && m != null) {
          try {
            pianoInput.keyDown(m, 0.3);
            setTimeout(() => { try { pianoInput.keyUp(m); } catch {} }, 6);
            return true;
          } catch {}
        }
        const el = keys[name];
        if (!el) return false;
        el.clicked = true; setTimeout(() => { el.clicked = false; }, 6);
        return true;
      };
      return tap('C4');
    };

    const start = performance.now();
    while (true) {
      const ok = await probe();
      if (ok) break;
      await wait(150);
      if (performance.now() - start > 10000) break;
    }
  }

  // Warm just two notes per octave (C, F#) to trigger white/black sample groups
  async function prewarmOctave(oct, tapMs = 10) {
    const names = [`C${oct}`, `F#${oct}`];
    for (const nm of names) {
      const m = nameToMidi(nm);
      if (pianoInput && typeof pianoInput.keyDown === 'function' && m != null) {
        try {
          pianoInput.keyDown(m, 0.25);
          await wait(tapMs);
          pianoInput.keyUp(m);
          await wait(tapMs);
          continue;
        } catch {}
      }
      const el = keys[nm];
      if (!el) continue;
      el.clicked = true; await wait(tapMs); el.clicked = false; await wait(tapMs);
    }
    warmedOctaves.add(String(oct));
  }

  function octavesUsedAtCurrentTranspose() {
    if (!notes.length) return [];
    const used = new Set();
    const step = Math.ceil(notes.length / 1000); // cap sample points
    for (let i = 0; i < notes.length; i += step) {
      const nm = transposedName(notes[i].name, transposeOffset);
      const oc = nameToOctave(nm);
      if (oc) used.add(oc);
    }
    return [...used].sort((a, b) => a - b);
  }

  async function prewarmUsedOctavesSoon() {
    const run = async () => {
      await ensureInstrumentReady();
      const used = octavesUsedAtCurrentTranspose();
      for (const oc of used) {
        if (!warmedOctaves.has(String(oc))) {
          await prewarmOctave(oc, 10);
          await wait(60);
        }
      }
      updateStatus(`Ready. Warmed: ${[...warmedOctaves].join(', ') || 'none'}`);
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 0);
    }
  }

  async function ensureOctaveWarmedForName(name) {
    const oc = nameToOctave(name);
    if (!oc || warmedOctaves.has(String(oc))) return;
    await prewarmOctave(oc, 8);
  }

  // -------------------- Scheduler --------------------
  const pendingTimeouts = new Set();

  function clearPendingTimeouts() {
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts.clear();
  }

  function resetPlayback() {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    clearPendingTimeouts();
    stopAutoSustain();
    currentIndex = 0;
    offsetTimeSec = 0;
    startEpoch = 0;
    stopProgressUpdater();
    updateSeekUI(0);
  }

  function scheduleNote(i) {
    const n = notes[i];
    const s = Math.max(0.0001, speedFactor);
    const effectiveStartSec = n.time / s;
    const effectiveDurationMs = (n.duration / s) * 1000;

    const nm = transposedName(n.name, transposeOffset);
    ensureOctaveWarmedForName(nm);

    const playhead = offsetTimeSec + (nowSec() - startEpoch);
    const delayMs = Math.max(0, (effectiveStartSec - playhead) * 1000);

    const tid = setTimeout(() => {
      pendingTimeouts.delete(tid);
      const liveName = transposedName(n.name, transposeOffset);
      try {
        press_and_schedule(liveName, effectiveDurationMs);
      } catch {}
    }, delayMs);
    pendingTimeouts.add(tid);
  }

  function schedulerTick() {
    if (playState !== 'playing') return;
    const elapsed = nowSec() - startEpoch;
    const playhead = offsetTimeSec + elapsed; // effective timeline time
    const s = Math.max(0.0001, speedFactor);

    while (
      currentIndex < notes.length &&
      (notes[currentIndex].time / s) <= playhead + scheduleAheadSec
    ) {
      scheduleNote(currentIndex);
      currentIndex++;
    }

    if (currentIndex >= notes.length) {
      stop(); // done
    }
  }

  // --- binary search for seeking (effective timeline) ---
  function findIndexForEffectiveTime(targetSec) {
    let lo = 0, hi = notes.length;
    const s = Math.max(0.0001, speedFactor);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = notes[mid].time / s;
      if (t < targetSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  async function play() {
    if (!notes.length) {
      updateStatus('No MIDI loaded. Use "Load".');
      return;
    }
    await resumeAudioIfNeeded();
    await ensureInstrumentReady();

    if (playState === 'stopped') {
      currentIndex = 0;
      offsetTimeSec = 0;
      warmedOctaves.clear();
      prewarmUsedOctavesSoon();
      updateSeekUI(0);
    }

    if (autoSustain) beginAutoSustain();

    startEpoch = nowSec();
    playState = 'playing';
    updateButtons();
    updateStatus(`Playing… ${speedFactor}×`);
    startProgressUpdater();

    clearInterval(scheduleTimer);
    scheduleTimer = setInterval(schedulerTick, lookaheadMs);
  }

  function pause() {
    if (playState !== 'playing') return;
    offsetTimeSec += nowSec() - startEpoch;
    playState = 'paused';
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    clearPendingTimeouts();
    stopAutoSustain();
    updateButtons();
    updateStatus('Paused.');
    stopProgressUpdater();
  }

  function stop() {
    if (playState === 'stopped') return;
    playState = 'stopped';
    resetPlayback();
    updateButtons();
    updateStatus('Stopped.');
  }

  function resume() {
    if (playState !== 'paused') return;
    startEpoch = nowSec();
    playState = 'playing';
    if (autoSustain) beginAutoSustain();
    updateButtons();
    updateStatus(`Playing… ${speedFactor}×`);
    startProgressUpdater();
    clearInterval(scheduleTimer);
    scheduleTimer = setInterval(schedulerTick, lookaheadMs);
  }

  // -------------------- Speed changes (keep musical position) --------------------
  function setSpeed(newSpeed) {
    const ns = Math.max(0.0001, Number(newSpeed));
    const old = speedFactor;

    // keep absolute musical position (original timeline) constant
    const effectiveNow = (playState === 'playing') ? offsetTimeSec + (nowSec() - startEpoch) : offsetTimeSec;
    const absOriginalSec = effectiveNow * old;         // convert back to original timeline seconds
    speedFactor = ns;
    const newEffective = absOriginalSec / speedFactor; // convert to new effective timeline

    // reset timers around new position
    offsetTimeSec = newEffective;
    startEpoch = nowSec();

    clearPendingTimeouts();
    currentIndex = findIndexForEffectiveTime(offsetTimeSec);
    if (playState === 'playing') {
      if (autoSustain) beginAutoSustain(); // adjust sustain interval
      clearInterval(scheduleTimer);
      scheduleTimer = setInterval(schedulerTick, lookaheadMs);
      updateStatus(`Playing… ${speedFactor}×`);
    }
    updateSeekRange();
    updateSeekUI(offsetTimeSec);
  }

  // -------------------- Seek bar --------------------
  function effectiveDurationSec() {
    return pieceDurationSec / Math.max(0.0001, speedFactor);
  }

  function updateSeekRange() {
    const max = Math.max(0.01, effectiveDurationSec());
    if (ui.seekRange) {
      ui.seekRange.max = String(max);
    }
    if (ui.seekManualMax) {
      ui.seekManualMax.textContent = ` / ${max.toFixed(2)}s`;
    }
  }

  function updateSeekUI(effSec) {
    if (ui.seekRange) ui.seekRange.value = String(clamp(effSec, 0, effectiveDurationSec()));
    if (ui.seekVal) ui.seekVal.textContent = `${effSec.toFixed(2)}s`;
  }

  function setSeekPosition(effSec) {
    const t = clamp(Number(effSec) || 0, 0, effectiveDurationSec());
    // move playhead (don’t change play/pause state)
    offsetTimeSec = t;
    startEpoch = nowSec();
    clearPendingTimeouts();
    currentIndex = findIndexForEffectiveTime(offsetTimeSec);
    if (playState === 'playing') {
      clearInterval(scheduleTimer);
      scheduleTimer = setInterval(schedulerTick, lookaheadMs);
    }
    updateSeekUI(offsetTimeSec);
  }

  function startProgressUpdater() {
    stopProgressUpdater();
    progressTimer = setInterval(() => {
      const eff = (playState === 'playing') ? offsetTimeSec + (nowSec() - startEpoch) : offsetTimeSec;
      updateSeekUI(eff);
    }, 100);
  }
  function stopProgressUpdater() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
  }

  // -------------------- UI Panel (Truly draggable + autosize) --------------------
  function buildUI() {
    const container = document.createElement('div');
    container.id = 'sp-playbot-ui';
    container.innerHTML = `
      <style>
        #sp-playbot-ui {
          position: fixed;
          /* No bottom/right anchoring here. We’ll set left/top inline for full control. */
          z-index: 100000;
          background: rgba(255,255,255,0.96);
          backdrop-filter: blur(3px);
          border: 1px solid #cfcfcf;
          border-radius: 10px;
          padding: 8px 10px;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          color: #333;
          box-shadow: 0 8px 22px rgba(0,0,0,0.15);
          width: fit-content;
          max-width: 90vw;
          max-height: 90vh;
          overflow: auto;
          box-sizing: border-box;
          touch-action: none; /* smoother dragging on touch/pen */
        }
        #sp-playbot-ui .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
        #sp-playbot-ui button {
          border: 1px solid #bbb; border-radius: 6px; padding: 6px 10px; cursor: pointer;
          background: #fff; color: #333; font-weight: 600;
        }
        #sp-playbot-ui button.primary { background: #4c8bf5; color: #fff; border-color: #3d72c8; }
        #sp-playbot-ui button:disabled { opacity: .5; cursor: not-allowed; }
        #sp-playbot-ui .badge { font-size: 12px; padding: 2px 6px; border-radius: 6px; background: #f0f0f0; }
        #sp-playbot-ui .label { font-size: 12px; color: #666; }
        #sp-playbot-ui input[type="range"] { width: 180px; }
        #sp-playbot-ui input[type="number"] { width: 84px; padding: 4px 6px; }
        #sp-playbot-ui .titlebar {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 4px; cursor: move; user-select: none;
        }
        #sp-playbot-ui .titlebar .title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
        #sp-advanced { display: none; border-top: 1px dashed #ddd; padding-top: 6px; margin-top: 6px; }
        #sp-advanced-toggle { margin-left: auto; font-size: 12px; color: #555; cursor: pointer; }
      </style>

      <div class="titlebar" id="sp-drag-handle">
        <div class="title">Playbot Controls</div>
        <span id="sp-status" class="badge">Idle</span>
      </div>

      <div class="row">
        <button id="sp-load">Load</button>
        <button id="sp-play" class="primary">Play</button>
        <button id="sp-pause">Pause</button>
        <button id="sp-stop">Stop</button>
        <span id="sp-advanced-toggle">Advanced ▾</span>
      </div>

      <div class="row">
        <span class="label">Seek:</span>
        <input id="sp-seek-range" type="range" min="0" max="1" step="0.01">
        <span id="sp-seek-val" class="badge">0.00s</span>
        <input id="sp-seek-manual" type="number" placeholder="seconds">
        <span id="sp-seek-max" class="label">/ 0.00s</span>
      </div>

      <div class="row">
        <span class="label">Transpose:</span>
        <button id="sp-transpose-minus">−</button>
        <span id="sp-transpose-val" class="badge">0</span>
        <button id="sp-transpose-plus">+</button>
        <input id="sp-transpose-manual" type="number" placeholder="semitones">
      </div>

      <div class="row">
        <span class="label">Sustain:</span>
        <button id="sp-sustain-toggle">Auto: On</button>
        <input id="sp-sustain-range" type="range" min="50" max="8000" step="50">
        <span id="sp-sustain-val" class="badge"></span>
        <label style="display:flex; align-items:center; gap:4px;">
          <input id="sp-sustain-link" type="checkbox" checked />
          <span class="label">Link to speed</span>
        </label>
        <input id="sp-sustain-manual" type="number" placeholder="ms (any)">
      </div>

      <div class="row">
        <span class="label">Speed:</span>
        <input id="sp-speed-range" type="range" min="0.50" max="2.00" step="0.05">
        <span id="sp-speed-val" class="badge">1.00×</span>
        <input id="sp-speed-manual" type="number" placeholder="e.g. 2.5 (any)">
      </div>

      <div id="sp-advanced">
        <div class="row">
          <span class="label">Lookahead (ms):</span>
          <input id="sp-lookahead-manual" type="number" placeholder="25">
          <span class="label">Schedule ahead (s):</span>
          <input id="sp-sahead-manual" type="number" placeholder="0.20">
        </div>
      </div>
    `;
    document.body.appendChild(container);

    // Place initial position bottom-right using left/top (no bottom/right anchoring)
    const savedPos = lsGet('sp_ui_pos', null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      container.style.left = `${savedPos.left}px`;
      container.style.top  = `${savedPos.top}px`;
    } else {
      // After layout, measure and position 20px from bottom-right
      requestAnimationFrame(() => {
        const rect = container.getBoundingClientRect();
        const left = Math.max(10, window.innerWidth - rect.width - 20);
        const top  = Math.max(10, window.innerHeight - rect.height - 20);
        container.style.left = `${left}px`;
        container.style.top  = `${top}px`;
      });
    }

    // Dragging (pure top/left, no bottom/right at all)
    const handle = container.querySelector('#sp-drag-handle');
    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const onPointerDown = (e) => {
      dragging = true;
      const rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      container.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      const left = e.clientX - dragOffsetX;
      const top  = e.clientY - dragOffsetY;
      // Keep within viewport a bit (10px margins)
      const maxLeft = window.innerWidth - container.offsetWidth - 10;
      const maxTop  = window.innerHeight - container.offsetHeight - 10;
      container.style.left = `${clamp(left, 10, Math.max(10, maxLeft))}px`;
      container.style.top  = `${clamp(top, 10, Math.max(10, maxTop))}px`;
    };
    const onPointerUp = (e) => {
      dragging = false;
      container.releasePointerCapture?.(e.pointerId);
      const rect = container.getBoundingClientRect();
      lsSet('sp_ui_pos', { left: rect.left, top: rect.top });
    };

    handle.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // Wire controls
    ui.root       = container;
    ui.status     = container.querySelector('#sp-status');

    ui.loadBtn    = container.querySelector('#sp-load');
    ui.playBtn    = container.querySelector('#sp-play');
    ui.pauseBtn   = container.querySelector('#sp-pause');
    ui.stopBtn    = container.querySelector('#sp-stop');

    ui.seekRange  = container.querySelector('#sp-seek-range');
    ui.seekVal    = container.querySelector('#sp-seek-val');
    ui.seekManual = container.querySelector('#sp-seek-manual');
    ui.seekManualMax = container.querySelector('#sp-seek-max');

    ui.trMinus    = container.querySelector('#sp-transpose-minus');
    ui.trPlus     = container.querySelector('#sp-transpose-plus');
    ui.trVal      = container.querySelector('#sp-transpose-val');
    ui.trManual   = container.querySelector('#sp-transpose-manual');

    ui.susToggle  = container.querySelector('#sp-sustain-toggle');
    ui.susRange   = container.querySelector('#sp-sustain-range');
    ui.susVal     = container.querySelector('#sp-sustain-val');
    ui.susLink    = container.querySelector('#sp-sustain-link');
    ui.susManual  = container.querySelector('#sp-sustain-manual');

    ui.speedRange = container.querySelector('#sp-speed-range');
    ui.speedVal   = container.querySelector('#sp-speed-val');
    ui.speedManual= container.querySelector('#sp-speed-manual');

    ui.advToggle  = container.querySelector('#sp-advanced-toggle');
    ui.advPanel   = container.querySelector('#sp-advanced');
    ui.lookaheadManual = container.querySelector('#sp-lookahead-manual');
    ui.sAheadManual    = container.querySelector('#sp-sahead-manual');

    ui.loadBtn.addEventListener('click', () => input.click());
    ui.playBtn.addEventListener('click', () => { if (playState === 'paused') resume(); else play(); });
    ui.pauseBtn.addEventListener('click', () => pause());
    ui.stopBtn.addEventListener('click', () => stop());

    // Seek
    ui.seekRange.addEventListener('input', () => setSeekPosition(Number(ui.seekRange.value)));
    ui.seekRange.addEventListener('change', () => setSeekPosition(Number(ui.seekRange.value)));
    ui.seekManual.addEventListener('change', () => setSeekPosition(Number(ui.seekManual.value)));

    // Transpose
    ui.trMinus.addEventListener('click', async () => {
      transposeOffset -= 1;
      ui.trVal.textContent = String(transposeOffset);
      await prewarmUsedOctavesSoon();
    });
    ui.trPlus.addEventListener('click', async () => {
      transposeOffset += 1;
      ui.trVal.textContent = String(transposeOffset);
      await prewarmUsedOctavesSoon();
    });
    ui.trManual.addEventListener('change', async () => {
      const v = Math.round(Number(ui.trManual.value) || 0);
      transposeOffset = v;
      ui.trVal.textContent = String(transposeOffset);
      await prewarmUsedOctavesSoon();
    });

    // Sustain
    ui.susRange.addEventListener('input', () => {
      sustainMs = parseInt(ui.susRange.value, 10);
      ui.susVal.textContent = `${sustainMs} ms`;
      if (playState === 'playing' && autoSustain) beginAutoSustain();
    });
    ui.susManual.addEventListener('change', () => {
      const v = Math.abs(Number(ui.susManual.value) || sustainMs);
      sustainMs = v;
      ui.susVal.textContent = `${sustainMs} ms`;
      ui.susRange.value = String(clamp(sustainMs, 50, 8000)); // slider stays sane, manual is unlimited
      if (playState === 'playing' && autoSustain) beginAutoSustain();
    });
    ui.susToggle.addEventListener('click', () => {
      autoSustain = !autoSustain;
      ui.susToggle.textContent = `Auto: ${autoSustain ? 'On' : 'Off'}`;
      if (playState === 'playing') { if (autoSustain) beginAutoSustain(); else stopAutoSustain(); }
    });
    ui.susLink.addEventListener('change', () => {
      linkSustainToTempo = ui.susLink.checked;
      if (playState === 'playing' && autoSustain) beginAutoSustain();
    });

    // Speed
    ui.speedRange.addEventListener('input', () => {
      const v = parseFloat(ui.speedRange.value);
      setSpeed(v);
      ui.speedVal.textContent = `${speedFactor.toFixed(2)}×`;
      ui.speedManual.value = ''; // keep manual separate
    });
    ui.speedManual.addEventListener('change', () => {
      const v = Number(ui.speedManual.value);
      if (isFinite(v) && v !== 0) {
        setSpeed(Math.abs(v)); // any positive number (unlimited)
        ui.speedVal.textContent = `${speedFactor}×`;
      }
    });

    // Advanced
    ui.advToggle.addEventListener('click', () => {
      const open = ui.advPanel.style.display !== 'none';
      ui.advPanel.style.display = open ? 'none' : 'block';
      ui.advToggle.textContent = open ? 'Advanced ▾' : 'Advanced ▴';
    });
    ui.lookaheadManual.addEventListener('change', () => {
      const v = Math.abs(Number(ui.lookaheadManual.value) || lookaheadMs);
      lookaheadMs = v;
      if (playState === 'playing') {
        clearInterval(scheduleTimer);
        scheduleTimer = setInterval(schedulerTick, lookaheadMs);
      }
    });
    ui.sAheadManual.addEventListener('change', () => {
      const v = Math.abs(Number(ui.sAheadManual.value) || scheduleAheadSec);
      scheduleAheadSec = v;
    });

    // Initialize values
    ui.trVal.textContent = String(transposeOffset);
    ui.susRange.value = sustainMs;
    ui.susVal.textContent = `${sustainMs} ms`;
    ui.susLink.checked = linkSustainToTempo;
    ui.speedRange.value = speedFactor.toFixed(2);
    ui.speedVal.textContent = `${speedFactor.toFixed(2)}×`;
    ui.lookaheadManual.value = String(lookaheadMs);
    ui.sAheadManual.value = String(scheduleAheadSec);
    updateButtons();
    updateSeekRange();
    updateSeekUI(0);
  }

  function updateButtons() {
    if (!ui.playBtn) return;
    ui.playBtn.textContent = (playState === 'paused') ? 'Resume' : 'Play';
    ui.playBtn.disabled = (playState === 'playing' && currentIndex >= notes.length);
    ui.pauseBtn.disabled = (playState !== 'playing');
    ui.stopBtn.disabled = (playState === 'stopped');
  }
  function updateStatus(text) {
    if (ui.status) ui.status.textContent = text;
    else console.log(text);
  }

  // -------------------- Keyboard shortcuts (optional) --------------------
  document.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      if (playState === 'paused') await resume(); else await play();
    }
    if (event.key === 'm' && event.ctrlKey) {
      input.click();
    }

    // Sustain quick tweaks
    if (event.keyCode === 40) { // down
      sustainMs = Math.max(1, Math.floor(sustainMs / 2));
      if (ui.susRange) ui.susRange.value = String(clamp(sustainMs, 50, 8000));
      if (ui.susVal) ui.susVal.textContent = `${sustainMs} ms`;
      if (playState === 'playing' && autoSustain) beginAutoSustain();
    }
    if (event.keyCode === 38) { // up
      sustainMs = Math.floor(sustainMs * 2);
      if (ui.susRange) ui.susRange.value = String(clamp(sustainMs, 50, 8000));
      if (ui.susVal) ui.susVal.textContent = `${sustainMs} ms`;
      if (playState === 'playing' && autoSustain) beginAutoSustain();
    }

    // Transpose
    if (event.keyCode === 189) { // minus
      transposeOffset -= 1;
      if (ui.trVal) ui.trVal.textContent = String(transposeOffset);
      await prewarmUsedOctavesSoon();
    }
    if (event.keyCode === 187) { // plus
      transposeOffset += 1;
      if (ui.trVal) ui.trVal.textContent = String(transposeOffset);
      await prewarmUsedOctavesSoon();
    }
  });

  // -------------------- Boot --------------------
  (async () => {
    await buildUI();
    await whenDefined('piano-keyboard');
    await whenDefined('piano-logo');

    // Cosmetic header tag
    try {
      const logoHost = document.querySelector('piano-logo');
      const headerLogo = logoHost?.shadowRoot?.getElementById('header-logo');
      if (headerLogo) {
        const sublogo_html = `
          <sub-logo>
            bot 2.0
            <style>
              sub-logo {
                font-family: Quicksand, sans-serif;
                text-transform: uppercase; font-weight: 700; color: white;
                text-align: center; font-size: 12px; letter-spacing: 1px;
                margin: auto; margin-left: 10px; padding: 5px 12px;
                background-color: #b064ff; border: none; border-radius: 7px;
              }
            </style>
          </sub-logo>`;
        headerLogo.insertAdjacentHTML('afterend', sublogo_html);
      }
    } catch {}

    await mapKeyboard();
    updateStatus('Ready. Load a MIDI (Ctrl+M). Drag the panel anywhere.');
  })();

})();
