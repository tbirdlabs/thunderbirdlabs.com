// Clotho foot pedal setup.
//
// Talks to the pedal firmware (firmware/src/main.cpp in the Clotho-eSpinner repo)
// over Web Serial using its existing text commands, so pedals that are already
// built don't need reflashing:
//   STATUS  -> "Cal min=318, max=522 | dzBottom=5%, dzTop=0% | Live ADC=320"
//   CAL     -> streams "ADC: 320  [318-522]" at 10 Hz until SAVE or CANCEL
//   DZ      -> prompts for the heel %, then the toe %
// The demo mode runs a copy of that firmware in the page.

'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  const STATUS_RE = /^Cal min=(\d+), max=(\d+) \| dzBottom=(\d+)%, dzTop=(\d+)% \| Live ADC=(\d+)/;
  const CAL_LINE_RE = /^ADC: (\d+)\s+\[(\d+)-(\d+)\]/;
  const CAL_MIN_RANGE = 100;  // same as the firmware's CAL_MIN_RANGE
  const POLL_MS = 100;

  // ── Firmware math ────────────────────────────────────────────────────────────
  // Same integer math as loop() in main.cpp: ADC reading -> duty 0-255.
  function dutyFor(adc, s) {
    const travel = s.calMax > s.calMin ? s.calMax - s.calMin : 0;
    const bot = s.calMin + Math.floor(travel * s.dzBot / 100);
    const top = s.calMax - Math.floor(travel * s.dzTop / 100);
    if (adc <= bot) return 0;
    if (adc >= top) return 255;
    return Math.max(0, Math.min(255, Math.trunc((adc - bot) * 255 / (top - bot))));
  }

  // Speed (0-1) for a pedal position (0-1) with the given dead zones.
  function speedAt(p, dzBot, dzTop) {
    const b = dzBot / 100, t = 1 - dzTop / 100;
    if (p <= b) return 0;
    if (p >= t) return 1;
    return (p - b) / (t - b);
  }

  // ── Web Serial link ──────────────────────────────────────────────────────────
  class SerialLink {
    constructor(onLine, onLost) {
      this.onLine = onLine;
      this.onLost = onLost;
      this.closing = false;
      this.enc = new TextEncoder();
    }

    async open() {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600 });
      // The 32U4's USB serial drops everything it sends unless DTR is set.
      try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (e) { /* not fatal */ }
      this.writer = this.port.writable.getWriter();
      this.loopDone = this.readLoop();
    }

    async readLoop() {
      const dec = new TextDecoder();
      let buf = '';
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.search(/[\r\n]/)) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (line) this.onLine(line);
            }
            if (buf.length > 512) buf = '';
          }
        } catch (e) {
          // Unplugged, or a read error the port may recover from; the while decides.
        } finally {
          this.reader.releaseLock();
        }
      }
      if (!this.closing) this.onLost();
    }

    async write(text) {
      await this.writer.write(this.enc.encode(text + '\n'));
    }

    async close() {
      this.closing = true;
      try { await this.reader?.cancel(); } catch (e) { /* already gone */ }
      try { await this.loopDone; } catch (e) { /* ignore */ }
      try { this.writer.releaseLock(); } catch (e) { /* ignore */ }
      try { await this.port.close(); } catch (e) { /* ignore */ }
    }
  }

  // ── Demo link ────────────────────────────────────────────────────────────────
  // A pretend pedal running the same logic and printing the same text as the
  // real firmware.  It starts with blank EEPROM, like a freshly flashed pedal.
  class DemoLink {
    constructor(onLine) {
      this.onLine = onLine;
      this.press = 0;   // 0 = all the way up, 1 = all the way down
      this.calMin = 0; this.calMax = 1023; this.dzBot = 5; this.dzTop = 3;
      this.armed = false; this.warned = false;
      this.mode = 'normal';
    }

    adc() {
      // The pedal swings the pot through about a fifth of its range, plus a little noise.
      const v = Math.round(318 + this.press * 204 + (Math.random() * 3 - 1.5));
      return Math.max(0, Math.min(1023, v));
    }

    say(...lines) {
      setTimeout(() => lines.forEach((l) => this.onLine(l)), 4);
    }

    async open() {
      this.say('EEPROM blank — using defaults (min=0, max=1023, dzBottom=5%, dzTop=3%).',
               'Clotho Foot Pedal ready.  Commands: CAL | DZ | STATUS');
      this.lastPrint = 0;
      this.timer = setInterval(() => this.tick(), 20);
    }

    tick() {
      const adc = this.adc();
      if (this.mode === 'normal') {
        const duty = dutyFor(adc, this);
        if (!this.armed) {
          if (duty === 0) { this.armed = true; this.warned = false; }
          else if (!this.warned) { this.say('Pedal not at rest — release it to enable the motor.'); this.warned = true; }
        }
      } else if (this.mode === 'cal') {
        this.obsMin = Math.min(this.obsMin, adc);
        this.obsMax = Math.max(this.obsMax, adc);
        const now = performance.now();
        if (now - this.lastPrint >= 100) {
          this.lastPrint = now;
          this.say(`ADC: ${adc}  [${this.obsMin}-${this.obsMax}]`);
        }
      }
    }

    async write(text) {
      const line = text.trim().toUpperCase();
      switch (this.mode) {
        case 'normal':
          if (!line) return;
          if (line === 'CAL') {
            this.mode = 'cal'; this.armed = false;
            this.obsMin = 1023; this.obsMax = 0;
            this.say('--- CAL MODE ---', 'Sweep pedal through full range.  Type SAVE or CANCEL.');
          } else if (line === 'DZ') {
            this.mode = 'dzBot'; this.armed = false;
            this.say(`Enter bottom (heel) dead zone % [0-50], current=${this.dzBot}:`);
          } else if (line === 'STATUS') {
            this.say(`Cal min=${this.calMin}, max=${this.calMax} | dzBottom=${this.dzBot}%, dzTop=${this.dzTop}% | Live ADC=${this.adc()}`);
          } else {
            this.say(`Unknown command: ${line}`, 'Valid commands: CAL | DZ | STATUS');
          }
          return;
        case 'cal':
          if (line === 'SAVE') {
            if (this.obsMax < this.obsMin + CAL_MIN_RANGE) {
              this.say(`ERROR: range too narrow (need ${CAL_MIN_RANGE}+ counts) — keep sweeping before SAVE.`);
            } else {
              this.calMin = this.obsMin; this.calMax = this.obsMax; this.mode = 'normal';
              this.say(`Saved — min=${this.calMin}, max=${this.calMax}`, '--- CAL END ---');
            }
          } else if (line === 'CANCEL') {
            this.mode = 'normal';
            this.say('Calibration cancelled — previous values unchanged.', '--- CAL END ---');
          } else if (line) {
            this.say('Type SAVE or CANCEL.');
          }
          return;
        case 'dzBot':
        case 'dzTop': {
          if (!line) { this.mode = 'normal'; this.say('DZ cancelled.'); return; }
          const v = /^\d{1,2}$/.test(line) ? Number(line) : -1;
          if (v < 0 || v > 50) { this.mode = 'normal'; this.say('ERROR: enter a whole number 0–50.  DZ cancelled.'); return; }
          if (this.mode === 'dzBot') {
            this.newBot = v; this.mode = 'dzTop';
            this.say(`Enter top (toe) dead zone % [0-50], current=${this.dzTop}:`);
          } else {
            this.dzBot = this.newBot; this.dzTop = v; this.mode = 'normal';
            this.say(`Dead zones saved — bottom=${this.dzBot}%, top=${this.dzTop}%`);
          }
        }
      }
    }

    async close() { clearInterval(this.timer); }
  }

  // ── State ────────────────────────────────────────────────────────────────────
  const st = {
    link: null,
    demo: false,
    mode: 'off',      // off | idle | cal | dz | menu (a prompt started from the console)
    saved: null,      // { calMin, calMax, dzBot, dzTop } as the pedal reports them
    adc: null,
    armed: true,
    edited: false,    // the dead zone sliders have been moved since the last sync
    obs: null,        // { adc, lo, hi } while calibrating
    statusPending: false,
    statusSentAt: 0,
    misses: 0,
  };

  const waiters = new Set();
  function waitFor(re, ms) {
    return new Promise((resolve, reject) => {
      const w = { re, resolve, reject, t: setTimeout(() => { waiters.delete(w); reject(new Error('timeout')); }, ms) };
      waiters.add(w);
    });
  }
  function dropWaiters() {
    for (const w of waiters) { clearTimeout(w.t); w.reject(new Error('disconnected')); }
    waiters.clear();
  }

  function send(text) {
    if (!st.link) return;
    log(text, 'out', text === 'STATUS');
    st.link.write(text).catch(() => { /* the read loop reports a lost port */ });
  }

  // ── Lines from the pedal ─────────────────────────────────────────────────────
  function onLine(line) {
    let m;
    const isStatus = STATUS_RE.test(line);
    log(line, 'in', isStatus);

    if ((m = line.match(STATUS_RE))) {
      st.statusPending = false;
      st.misses = 0;
      st.saved = { calMin: +m[1], calMax: +m[2], dzBot: +m[3], dzTop: +m[4] };
      st.adc = +m[5];
      if (st.mode === 'menu') st.mode = 'idle';
      if (dutyFor(st.adc, st.saved) === 0) st.armed = true;
      if (!st.edited) syncSliders();
    } else if ((m = line.match(CAL_LINE_RE))) {
      if (st.mode !== 'cal') enterCal();
      st.obs = { adc: +m[1], lo: +m[2], hi: +m[3] };
    } else if (/^--- CAL MODE/.test(line)) {
      if (st.mode !== 'cal') enterCal();
    } else if ((m = line.match(/^Saved\D+min=(\d+), max=(\d+)/))) {
      if (st.saved) Object.assign(st.saved, { calMin: +m[1], calMax: +m[2] });
    } else if (/^--- CAL END/.test(line)) {
      st.mode = 'idle'; st.armed = false; st.obs = null;
    } else if (/^Enter (bottom|top)/.test(line)) {
      if (st.mode !== 'dz') st.mode = 'menu';
    } else if ((m = line.match(/^Dead zones saved\D+bottom=(\d+)%, top=(\d+)%/))) {
      if (st.saved) Object.assign(st.saved, { dzBot: +m[1], dzTop: +m[2] });
      st.mode = 'idle'; st.armed = false;
    } else if (/^DZ cancelled|^ERROR: enter a whole number/.test(line)) {
      st.mode = 'idle'; st.armed = false;
    } else if (/^Pedal not at rest/.test(line)) {
      st.armed = false;
    }

    for (const w of [...waiters]) {
      if (w.re.test(line)) { clearTimeout(w.t); waiters.delete(w); w.resolve(line); }
    }
    render();
  }

  // ── Polling ──────────────────────────────────────────────────────────────────
  setInterval(() => {
    if (!st.link || st.mode !== 'idle') return;
    const now = performance.now();
    if (st.statusPending && now - st.statusSentAt < 1500) return;
    if (st.statusPending) { st.misses++; render(); }
    st.statusPending = true;
    st.statusSentAt = now;
    send('STATUS');
  }, POLL_MS);

  // ── Connect / disconnect ─────────────────────────────────────────────────────
  async function connect(demo) {
    const link = demo ? new DemoLink(onLine) : new SerialLink(onLine, lost);
    setConn('Connecting…', 'wait');
    try {
      await link.open();
    } catch (e) {
      if (e.name === 'NotFoundError') { setConn('Not connected'); return; }  // closed the picker
      setConn(e.name === 'NetworkError' || e.name === 'InvalidStateError'
        ? 'Couldn’t open the pedal. Is something else using it?'
        : `Couldn’t connect: ${e.message}`);
      return;
    }
    Object.assign(st, { link, demo, mode: 'idle', saved: null, adc: null, armed: true,
                        edited: false, obs: null, statusPending: false, misses: 0 });
    $('demo-pedal').hidden = !demo;
    $('demo-press').value = 0;
    $('dz-msg').textContent = '';
    $('cal-done').textContent = '';
    log(demo ? 'Demo pedal connected. It has never been calibrated.' : 'Connected.', 'sys');
    render();
  }

  async function disconnect() {
    const link = st.link;
    if (!link) return;
    if (st.mode === 'cal') await link.write('CANCEL').catch(() => {});
    if (st.mode === 'dz' || st.mode === 'menu') await link.write('').catch(() => {});
    st.link = null;
    dropWaiters();
    await link.close();
    reset('Disconnected.');
  }

  function lost() {
    st.link = null;
    dropWaiters();
    reset('The pedal was unplugged.');
  }

  function reset(message) {
    Object.assign(st, { mode: 'off', saved: null, adc: null, obs: null, edited: false });
    $('demo-pedal').hidden = true;
    log(message, 'sys');
    render();
  }

  // Leaving the page in the middle of a menu would leave the pedal stuck in it.
  window.addEventListener('pagehide', () => {
    if (!st.link) return;
    if (st.mode === 'cal') st.link.write('CANCEL').catch(() => {});
    if (st.mode === 'dz' || st.mode === 'menu') st.link.write('').catch(() => {});
  });

  // ── Dead zones ───────────────────────────────────────────────────────────────
  const heel = $('dz-heel'), toe = $('dz-toe');

  function syncSliders() {
    if (!st.saved) return;
    heel.value = st.saved.dzBot;
    toe.value = st.saved.dzTop;
  }

  function dirty() {
    return !!st.saved && (+heel.value !== st.saved.dzBot || +toe.value !== st.saved.dzTop);
  }

  for (const el of [heel, toe]) {
    el.addEventListener('input', () => { st.edited = true; $('dz-msg').textContent = ''; render(); });
  }

  $('dz-undo').addEventListener('click', () => { st.edited = false; syncSliders(); render(); });

  $('dz-save').addEventListener('click', async () => {
    if (st.mode !== 'idle' || !dirty()) return;
    const bot = String(+heel.value), top = String(+toe.value);
    st.mode = 'dz';
    setMsg('dz-msg', 'Saving…');
    render();
    try {
      if (st.statusPending) await waitFor(STATUS_RE, 500).catch(() => {});
      send('DZ');
      await waitFor(/^Enter bottom/, 2000);
      send(bot);
      if (!/^Enter top/.test(await waitFor(/^Enter top|^ERROR|cancelled/, 2000))) throw new Error('refused');
      send(top);
      if (!/^Dead zones saved/.test(await waitFor(/^Dead zones saved|^ERROR|cancelled/, 2000))) throw new Error('refused');
      st.edited = false;
      setMsg('dz-msg', 'Saved.', 'ok');
    } catch (e) {
      if (e.message === 'disconnected') return;
      if (st.mode === 'dz') send('');  // an empty line backs out of the prompt
      st.mode = 'idle';
      setMsg('dz-msg', 'The pedal didn’t take it. Try again, or check the serial console.', 'err');
    }
    render();
  });

  // ── Calibration ──────────────────────────────────────────────────────────────
  function enterCal() {
    st.mode = 'cal';
    st.obs = null;
    st.armed = false;
    setMsg('cal-msg', '');
    setMsg('cal-done', '');
  }

  $('cal-start').addEventListener('click', async () => {
    if (st.mode !== 'idle') return;
    enterCal();
    render();
    send('CAL');
    try {
      await waitFor(/^--- CAL MODE|^ADC: /, 2000);
    } catch (e) {
      if (e.message === 'disconnected') return;
      st.mode = 'idle';
      setMsg('cal-done', 'The pedal didn’t start calibrating. Try again, or check the serial console.', 'err');
      render();
    }
  });

  $('cal-save').addEventListener('click', async () => {
    $('cal-save').disabled = true;
    send('SAVE');
    try {
      const r = await waitFor(/^--- CAL END|^ERROR: range/, 2000);
      if (/^ERROR/.test(r)) {
        setMsg('cal-msg', 'Not enough travel yet. Keep pressing it all the way down and letting it all the way up.', 'err');
      } else if (st.saved) {
        setMsg('cal-done', `Calibrated. The pedal now runs from ${st.saved.calMin} to ${st.saved.calMax}.`, 'ok');
      }
    } catch (e) {
      if (e.message !== 'disconnected') setMsg('cal-msg', 'The pedal didn’t answer. Try again.', 'err');
    }
    render();
  });

  $('cal-cancel').addEventListener('click', async () => {
    send('CANCEL');
    try {
      await waitFor(/^--- CAL END/, 2000);
      setMsg('cal-done', 'Cancelled. The old calibration is still there.');
    } catch (e) {
      if (e.message !== 'disconnected') setMsg('cal-msg', 'The pedal didn’t answer. Try again.', 'err');
    }
    render();
  });

  // ── Buttons and console ──────────────────────────────────────────────────────
  const hasSerial = 'serial' in navigator;
  if (!hasSerial) $('unsupported').hidden = false;

  $('connect').addEventListener('click', () => (st.link ? disconnect() : connect(false)));
  $('demo').addEventListener('click', () => connect(true));
  $('demo-press').addEventListener('input', (e) => { if (st.demo && st.link) st.link.press = e.target.value / 1000; });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('send-text').value.trim();
    if (!st.link) return;
    send(text);
    $('send-text').value = '';
  });

  const logEl = $('log');
  function log(text, kind, isStatus) {
    if (isStatus && !$('log-status').checked) return;
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    const div = document.createElement('div');
    div.className = kind;
    div.textContent = kind === 'out' ? `> ${text}` : text;
    logEl.append(div);
    while (logEl.childNodes.length > 500) logEl.firstChild.remove();
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function setMsg(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setConn(text, kind) {
    const el = $('conn');
    el.textContent = text;
    el.className = 'conn' + (kind ? ' ' + kind : '');
  }

  // ── Chart ────────────────────────────────────────────────────────────────────
  // Drawn at the chart's real pixel size, so the labels stay readable on a phone.
  const svg = $('chart');
  let W, H, M, PW, PH;
  let bandHeel, bandToe, bandHeelText, bandToeText, savedCurve, curve, hoverLine, hoverDot, guide, dot;
  const X = (p) => M.l + p * PW;
  const Y = (s) => M.t + (1 - s) * PH;

  function el(tag, attrs, text) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  }

  function buildChart() {
    W = Math.round(svg.parentNode.clientWidth) || 600;
    H = Math.round(Math.max(210, Math.min(290, W * 0.45)));
    M = { l: 44, r: 6, t: 26, b: 40 };
    PW = W - M.l - M.r; PH = H - M.t - M.b;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.querySelectorAll(':scope > :not(desc)').forEach((e) => e.remove());

    bandHeel = el('rect', { class: 'band', y: M.t, height: PH });
    bandToe = el('rect', { class: 'band', y: M.t, height: PH });
    bandHeelText = el('text', { class: 'band-text', y: M.t + 16, 'text-anchor': 'middle' }, 'Off');
    bandToeText = el('text', { class: 'band-text', y: M.t + PH - 8, 'text-anchor': 'middle' }, 'Full');
    for (const s of [0, 0.5, 1]) {
      el('line', { class: 'grid', x1: M.l, x2: W - M.r, y1: Y(s), y2: Y(s) });
      el('text', { class: 'axis-text', x: M.l - 8, y: Y(s) + 4, 'text-anchor': 'end' }, `${s * 100}%`);
    }
    el('text', { class: 'axis-text', x: 0, y: 12 }, 'Motor speed');
    el('text', { class: 'axis-text', x: X(0), y: H - 14, 'text-anchor': 'start' }, 'All the way up');
    if (PW > 380) el('text', { class: 'axis-text', x: X(0.5), y: H - 14, 'text-anchor': 'middle' }, 'Halfway');
    el('text', { class: 'axis-text', x: X(1), y: H - 14, 'text-anchor': 'end' }, 'All the way down');
    savedCurve = el('polyline', { class: 'curve saved' });
    curve = el('polyline', { class: 'curve' });
    hoverLine = el('line', { class: 'hover-line', y1: M.t, y2: M.t + PH, visibility: 'hidden' });
    hoverDot = el('circle', { class: 'hover-dot', r: 5, visibility: 'hidden' });
    guide = el('line', { class: 'guide', visibility: 'hidden' });
    dot = el('circle', { class: 'dot', r: 7, visibility: 'hidden' });
  }

  buildChart();
  new ResizeObserver(() => {
    if (Math.round(svg.parentNode.clientWidth) !== W) { buildChart(); drawChart(); }
  }).observe(svg.parentNode);

  function curvePoints(dzBot, dzTop) {
    const b = dzBot / 100, t = Math.max(b, 1 - dzTop / 100);
    return [[0, 0], [b, 0], [t, 1], [1, 1]].map(([p, s]) => `${X(p)},${Y(s)}`).join(' ');
  }

  function drawChart() {
    const b = +heel.value, t = +toe.value;
    bandHeel.setAttribute('x', X(0)); bandHeel.setAttribute('width', X(b / 100) - X(0));
    bandToe.setAttribute('x', X(1 - t / 100)); bandToe.setAttribute('width', X(1) - X(1 - t / 100));
    bandHeelText.setAttribute('x', X(b / 200));
    bandHeelText.setAttribute('visibility', b >= 7 ? 'visible' : 'hidden');
    bandToeText.setAttribute('x', X(1 - t / 200));
    bandToeText.setAttribute('visibility', t >= 7 ? 'visible' : 'hidden');
    curve.setAttribute('points', curvePoints(b, t));

    const showSaved = dirty();
    savedCurve.setAttribute('visibility', showSaved ? 'visible' : 'hidden');
    if (showSaved) savedCurve.setAttribute('points', curvePoints(st.saved.dzBot, st.saved.dzTop));
    $('legend').hidden = !showSaved;

    svg.classList.toggle('off', !st.link);
    const live = liveValues();
    const showDot = live && st.mode === 'idle';
    for (const e of [dot, guide]) e.setAttribute('visibility', showDot ? 'visible' : 'hidden');
    if (showDot) {
      dot.setAttribute('cx', X(live.p)); dot.setAttribute('cy', Y(live.s));
      guide.setAttribute('x1', X(live.p)); guide.setAttribute('x2', X(live.p));
      guide.setAttribute('y1', Y(live.s)); guide.setAttribute('y2', M.t + PH);
    }
    $('chart-desc').textContent = `Motor speed for each position of the pedal. The motor is off for the first ${b}% of travel` +
      (t ? ` and at full speed for the last ${t}%.` : ' and only reaches full speed at the very bottom.');
  }

  // Hover readout: what speed you'd get at any point along the pedal's travel.
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const p = ((e.clientX - r.left) / r.width * W - M.l) / PW;
    if (p < 0 || p > 1) { hideHover(); return; }
    const s = speedAt(p, +heel.value, +toe.value);
    hoverLine.setAttribute('x1', X(p)); hoverLine.setAttribute('x2', X(p));
    hoverDot.setAttribute('cx', X(p)); hoverDot.setAttribute('cy', Y(s));
    hoverLine.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('visibility', 'visible');
    const tip = $('tip');
    tip.textContent = `${Math.round(p * 100)}% down: ${s === 0 ? 'off' : Math.round(s * 100) + '% speed'}`;
    tip.style.left = `${X(p) / W * 100}%`;
    tip.style.top = `${Y(s) / H * 100}%`;
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', hideHover);
  function hideHover() {
    hoverLine.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    $('tip').hidden = true;
  }

  // Where the pedal is (0-1) and the speed the firmware is actually giving (0-1).
  function liveValues() {
    if (st.adc == null || !st.saved) return null;
    const { calMin, calMax } = st.saved;
    const span = calMax > calMin ? calMax - calMin : 1;
    const p = Math.max(0, Math.min(1, (st.adc - calMin) / span));
    const s = st.mode === 'idle' && st.armed ? dutyFor(st.adc, st.saved) / 255 : 0;
    return { p, s };
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    const on = !!st.link;
    const idle = on && st.mode === 'idle' && !!st.saved;

    $('connect').textContent = on ? 'Disconnect' : 'Connect pedal';
    $('connect').disabled = !on && !hasSerial;
    $('demo').hidden = on;
    if (on) {
      if (st.misses >= 3) setConn('Connected, but the pedal isn’t answering. See below.', 'wait');
      else setConn(st.demo ? 'Demo pedal' : 'Connected', 'on');
    } else if (!/Connecting|Couldn/.test($('conn').textContent)) {
      setConn('Not connected');
    }

    const live = liveValues();
    $('r-adc').textContent = on && st.adc != null ? st.adc : '–';
    $('r-pedal').textContent = live ? `${Math.round(live.p * 100)}%` : '–';
    let speed = '–';
    if (on && st.mode === 'cal') speed = 'Off';
    else if (live) speed = !st.armed ? 'Locked' : live.s === 0 ? 'Off' : `${Math.round(live.s * 100)}%`;
    $('r-speed').textContent = speed;

    $('uncal').hidden = !(on && st.saved && st.saved.calMin === 0 && st.saved.calMax === 1023 && st.mode !== 'cal');
    $('locked').hidden = !(idle && !st.armed) || !$('uncal').hidden;

    $('dz-heel-out').textContent = `${heel.value}%`;
    $('dz-toe-out').textContent = `${toe.value}%`;
    heel.disabled = toe.disabled = !idle;
    $('dz-save').disabled = !idle || !dirty();
    $('dz-undo').disabled = !idle || !dirty();

    const calOn = on && st.mode === 'cal';
    $('cal-idle').hidden = calOn;
    $('cal-run').hidden = !calOn;
    $('cal-start').disabled = !idle;
    if (calOn) {
      const o = st.obs;
      if (o && o.hi >= o.lo) {
        $('cal-seen').style.left = `${o.lo / 1023 * 100}%`;
        $('cal-seen').style.width = `${(o.hi - o.lo) / 1023 * 100}%`;
        $('cal-now').style.left = `${o.adc / 1023 * 100}%`;
        const range = o.hi - o.lo;
        $('cal-text').textContent = `Seen ${o.lo} to ${o.hi}, a range of ${range}. ` +
          (range >= CAL_MIN_RANGE ? 'That’s enough to save.' : `It needs at least ${CAL_MIN_RANGE}.`);
        $('cal-save').disabled = range < CAL_MIN_RANGE;
      } else {
        $('cal-seen').style.width = '0';
        $('cal-text').textContent = 'Waiting for the pedal…';
        $('cal-save').disabled = true;
      }
    }

    $('send-text').disabled = $('send-btn').disabled = !on;
    drawChart();
  }

  render();
})();
