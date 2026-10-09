/*
 * NQ Options Explorer - UI layer.
 * Plain classic script. Needs the globals Plotly (CDN) and NQModel (js/model.js).
 * `state` is the single source of truth. Controls only update state and schedule one
 * render per animation frame; render redraws every panel with Plotly.react.
 */
(function () {
  'use strict';

  var PLOTLY_MSG = "Couldn't load the charting library (Plotly) from the CDN — check your internet connection and reload.";
  var PLOT_CONFIG = { responsive: true, displaylogo: false };
  var METRIC_KEYS = ['iv', 'price', 'delta', 'gamma', 'theta', 'vega'];
  var DIVERGING = { delta: true, theta: true };
  var TILE_FMT = { iv: '.1%', price: ',.1f', delta: '.3f', gamma: '.5f', theta: '.2f', vega: ',.1f' };
  var CHAIN_ROWS = 9;
  var PLAY_MS = 120;
  var VALUE_POINTS = 121;
  var SMILE_FALLBACK_LO = 0.5;

  /* ---------- number and date formats (en-US) ---------- */

  function makeNF(decimals, extra) {
    var o = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    if (extra) {
      Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    }
    return new Intl.NumberFormat('en-US', o);
  }
  var NF0 = makeNF(0), NF1 = makeNF(1), NF2 = makeNF(2), NF3 = makeNF(3), NF6 = makeNF(6);
  var SIGN1 = makeNF(1, { signDisplay: 'exceptZero' });
  var PCT1 = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "Sun 15 Nov 2026" from a UTC date, built by hand so no locale changes the format.
  function fmtDate(d) {
    return DAY_NAMES[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* ---------- app-level state (filled by init) ---------- */

  var CFG = {}, MULT = 20, BAND = [0.7, 1.3];
  var F0 = 25000, startDate = null, expiries = [], strikes = [];
  var dteMin = 0, dteMax = 1, maxDay = 0;
  var state = null;
  var zCache = {};
  var rafPending = false, playTimer = null, plotReady = false;
  var lastLiveCount = -1, chainRows = [];

  /* ---------- DOM and formatting helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function on(id, evt, fn) { var el = $(id); if (el) { el.addEventListener(evt, fn); } }
  function setText(el, t) { if (el) { el.textContent = t; } }
  function setPressed(id, pressed) { var el = $(id); if (el) { el.setAttribute('aria-pressed', pressed ? 'true' : 'false'); } }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  // Formats a number and swaps the hyphen for a true minus sign. Non-numbers show an em dash.
  function fmt(f, v) { return isNum(v) ? f.format(v + 0).replace(/-/g, '−') : '—'; }
  function volText(v) {
    var pts = Math.round(v * 1000) / 10;
    var sign = pts > 0 ? '+' : (pts < 0 ? '−' : '');
    return sign + NF1.format(Math.abs(pts)) + ' vol pts';
  }
  function showBanner(msg) {
    var b = $('banner');
    if (!b) { return; }
    b.textContent = msg;
    b.hidden = false;
  }
  function reportError(err) {
    showBanner('Something went wrong while drawing the explorer: ' + (err && err.message ? err.message : String(err)));
  }

  /* ---------- colour helpers (tokens are read from CSS at render time) ---------- */

  function hexToRgb(hex) {
    var h = String(hex).trim().replace('#', '');
    if (h.length === 3) { h = h.split('').map(function (c) { return c + c; }).join(''); }
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) {
      var x = Math.round(clamp(v, 0, 255)).toString(16);
      return x.length < 2 ? '0' + x : x;
    }).join('');
  }
  function mixHex(a, b, t) {
    var A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function withAlpha(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  // Samples a ramp (array of hex stops, evenly spaced) at u in [0, 1].
  function sampleRamp(stops, u) {
    var n = stops.length - 1;
    if (n < 1) { return stops[0]; }
    var x = clamp(u, 0, 1) * n;
    var i = Math.min(Math.floor(x), n - 1);
    return mixHex(stops[i], stops[i + 1], x - i);
  }
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function tok(name, fb) {
      var v = cs.getPropertyValue(name).trim();
      return v || fb;
    }
    function hexTok(name, fb) {
      var v = tok(name, fb);
      return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v : fb;
    }
    var seq = tok('--viz-seq', '#cde2fb #0d366b').split(/\s+/).filter(function (c) { return /^#/.test(c); });
    var lo = parseFloat(tok('--viz-smile-lo', String(SMILE_FALLBACK_LO)));
    return {
      surface: hexTok('--surface', '#fcfcfb'),
      text: hexTok('--text', '#0b0b0b'),
      text2: hexTok('--text-2', '#52514e'),
      muted: hexTok('--text-muted', '#6b6a65'),
      grid: hexTok('--grid', '#e1e0d9'),
      axis: hexTok('--axis', '#c3c2b7'),
      accent: hexTok('--accent', '#2a78d6'),
      seq: seq.length >= 2 ? seq : ['#cde2fb', '#0d366b'],
      divNeg: hexTok('--viz-div-neg', '#e34948'),
      divMid: hexTok('--viz-div-mid', '#f0efec'),
      divPos: hexTok('--viz-div-pos', '#184f95'),
      smileLo: isFinite(lo) ? clamp(lo, 0, 0.95) : SMILE_FALLBACK_LO,
      font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
    };
  }
  // Sequential: one hue, low -> high magnitude.
  function sequentialScale(th) {
    var s = th.seq, n = s.length - 1, out = [];
    for (var i = 0; i <= n; i++) { out.push([n ? i / n : 0, s[i]]); }
    return out;
  }
  // Diverging: blue (positive) <-> red (negative), neutral at zero. Built over the actual
  // [lo, hi] domain so a mostly-negative metric (theta) still uses the full red ramp.
  function divergingScale(th, lo, hi) {
    var m = Math.max(Math.abs(lo), Math.abs(hi)) || 1e-9, out = [];
    for (var i = 0; i <= 12; i++) {
      var v = lo + (hi - lo) * i / 12;
      out.push([i / 12, v < 0 ? mixHex(th.divMid, th.divNeg, -v / m) : mixHex(th.divMid, th.divPos, v / m)]);
    }
    return out;
  }
  // Smile lines: t = 0 for the shortest-dated expiry (strongest), 1 for the longest (lightest).
  function smileColour(th, t) {
    return sampleRamp(th.seq, th.smileLo + (1 - th.smileLo) * (1 - clamp(t, 0, 1)));
  }
  function expiryT(dteAtStart) {
    var span = dteMax - dteMin;
    return span > 0 ? (dteAtStart - dteMin) / span : 0;
  }

  /* ---------- plotting helpers ---------- */

  function baseLayout(th) {
    return {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: th.font, color: th.text2, size: 12 },
      hoverlabel: { bgcolor: th.surface, bordercolor: th.grid, font: { family: th.font, color: th.text, size: 12 } }
    };
  }
  function axis2d(th, title, tickfmt, range) {
    var a = {
      title: { text: title, font: { size: 12, color: th.text2 } },
      tickformat: tickfmt,
      tickfont: { size: 11, color: th.text2 },
      showgrid: true,
      gridcolor: th.grid,
      gridwidth: 1,
      zeroline: false,
      showline: true,
      linecolor: th.axis,
      linewidth: 1,
      ticks: 'outside',
      tickcolor: th.axis,
      automargin: true
    };
    if (range) { a.range = range; }
    return a;
  }
  function axis3(th, title, tickfmt, range) {
    var a = {
      title: { text: title, font: { size: 12, color: th.text2 } },
      tickformat: tickfmt,
      tickfont: { size: 11, color: th.text2 },
      gridcolor: th.grid,
      zerolinecolor: th.axis,
      linecolor: th.axis,
      showbackground: false,
      backgroundcolor: 'rgba(0,0,0,0)'
    };
    if (range) { a.range = range; }
    return a;
  }
  // Every chart goes through here so errors surface in the banner, not the console.
  function plot(el, traces, layout) {
    try {
      var p = Plotly.react(el, traces, layout, PLOT_CONFIG);
      if (p && typeof p.catch === 'function') { p.catch(reportError); }
      return p;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  /* ---------- data helpers ---------- */

  function parseStartDate(s) {
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      try {
        var d = NQModel.parseISODate(s);
        if (d instanceof Date && !isNaN(d.getTime())) { return d; }
      } catch (e) { /* fall back to today */ }
    }
    var now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  function nearestIndex(x) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < strikes.length; i++) {
      var d = Math.abs(strikes[i] - x);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function nearestListed(x) { return strikes[nearestIndex(x)]; }
  function findExpiry(iso) {
    for (var i = 0; i < expiries.length; i++) {
      if (expiries[i].iso === iso) { return expiries[i]; }
    }
    return null;
  }
  function isExpired(e, day) { return e.dteAtStart - day <= 0; }
  // Fixed-range z for a metric. Cached by metric|type|F|volShift only, never by day.
  function zRangeFor(metric, type, F, vs) {
    var key = metric + '|' + type + '|' + F + '|' + vs;
    var r = zCache[key];
    if (!r) {
      if (Object.keys(zCache).length > 80) { zCache = {}; }
      r = NQModel.zRange({ metric: metric, type: type, expiries: expiries, strikes: strikes, F: F, volShift: vs, maxDay: maxDay });
      if (!(r[1] > r[0])) { r = [r[0] - 1e-9, r[1] + 1e-9]; }
      zCache[key] = r;
    }
    return r;
  }

  /* ---------- init ---------- */

  function init() {
    if (typeof NQModel === 'undefined') {
      showBanner('The pricing model (js/model.js) did not load, so the explorer cannot run. Check that file and reload.');
      return;
    }
    CFG = NQModel.CONFIG || {};
    MULT = CFG.multiplier || 20;
    BAND = CFG.displayBand || [0.7, 1.3];

    var params = new URLSearchParams(window.location.search);
    var f0 = parseFloat(params.get('f0'));
    F0 = (isFinite(f0) && f0 > 0) ? f0 : (CFG.F0 || 25000);
    startDate = parseStartDate(params.get('date'));

    expiries = NQModel.buildExpiries(startDate);
    strikes = NQModel.buildStrikes(F0);
    if (!expiries.length || !strikes.length) {
      showBanner('No expiries or strikes were generated for this start date.');
      return;
    }

    var dtes = expiries.map(function (e) { return e.dteAtStart; });
    dteMin = Math.min.apply(null, dtes);
    dteMax = Math.max.apply(null, dtes);
    maxDay = Math.max(0, dteMax - 1);

    var defaultExp = null;
    for (var i = 0; i < expiries.length; i++) {
      if (expiries[i].kind === 'quarterly') { defaultExp = expiries[i]; break; }
    }
    if (!defaultExp) { defaultExp = expiries[0]; }

    state = {
      day: 0,
      F: F0,
      volShift: 0,
      metric: 'iv',
      type: 'call',
      selExpiryIso: defaultExp.iso,
      selStrike: nearestListed(F0),
      playing: false
    };

    plotReady = typeof Plotly !== 'undefined';
    buildControls();
    bindEvents();
    if (!plotReady) { showBanner(PLOTLY_MSG); }
    scheduleRender();
  }

  function buildControls() {
    var dayEl = $('day');
    if (dayEl) {
      dayEl.min = '0';
      dayEl.max = String(maxDay);
      dayEl.step = '1';
      dayEl.value = String(state.day);
    }

    var futEl = $('fut');
    if (futEl) {
      futEl.min = String(Math.round(0.8 * F0));
      futEl.max = String(Math.round(1.2 * F0));
      futEl.step = '25';
      futEl.value = String(F0);
      state.F = Number(futEl.value);
    }

    var volEl = $('volshift');
    if (volEl) {
      volEl.min = '-10';
      volEl.max = '10';
      volEl.step = '0.5';
      volEl.value = '0';
    }

    var metricEl = $('metric');
    if (metricEl) {
      METRIC_KEYS.forEach(function (k) {
        var o = document.createElement('option');
        o.value = k;
        o.textContent = NQModel.METRICS[k].label;
        metricEl.appendChild(o);
      });
      metricEl.value = state.metric;
    }

    var strikeEl = $('strike');
    if (strikeEl) {
      strikes.forEach(function (K) {
        var o = document.createElement('option');
        o.value = String(K);
        o.textContent = NF0.format(K);
        strikeEl.appendChild(o);
      });
    }

    buildChainRows();
  }

  // Rows are built once and reused, so keyboard focus survives re-renders during playback.
  function buildChainRows() {
    var body = $('chain-body');
    if (!body) { return; }
    var n = Math.min(CHAIN_ROWS, strikes.length);
    chainRows = [];
    for (var r = 0; r < n; r++) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      var cells = [];
      for (var c = 0; c < 5; c++) {
        var td = document.createElement('td');
        td.className = c === 2 ? 'strike-cell' : 'num';
        tr.appendChild(td);
        cells.push(td);
      }
      tr.addEventListener('click', onChainRowPick);
      tr.addEventListener('keydown', onChainRowKey);
      body.appendChild(tr);
      chainRows.push({ tr: tr, cells: cells });
    }
  }

  function onChainRowPick(ev) {
    var K = Number(ev.currentTarget.dataset.strike);
    if (!isNum(K)) { return; }
    state.selStrike = K;
    scheduleRender();
  }
  function onChainRowKey(ev) {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      onChainRowPick(ev);
    }
  }

  function bindEvents() {
    on('play', 'click', function () {
      if (state.playing) { stopPlay(); } else { startPlay(); }
    });
    on('day', 'input', function (ev) {
      stopPlay();
      state.day = clamp(Math.round(Number(ev.target.value)), 0, maxDay);
      scheduleRender();
    });
    on('fut', 'input', function (ev) {
      state.F = Number(ev.target.value);
      scheduleRender();
    });
    on('volshift', 'input', function (ev) {
      state.volShift = Number(ev.target.value) / 100;
      scheduleRender();
    });
    on('metric', 'change', function (ev) {
      state.metric = ev.target.value;
      scheduleRender();
    });
    on('type-call', 'click', function () { state.type = 'call'; scheduleRender(); });
    on('type-put', 'click', function () { state.type = 'put'; scheduleRender(); });
    on('expiry', 'change', function (ev) {
      state.selExpiryIso = ev.target.value;
      scheduleRender();
    });
    on('strike', 'change', function (ev) {
      state.selStrike = Number(ev.target.value);
      scheduleRender();
    });
    on('reset', 'click', resetAll);
    window.addEventListener('resize', scheduleRender);

    if (window.matchMedia) {
      var mql = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { scheduleRender(); };
      if (mql.addEventListener) { mql.addEventListener('change', onScheme); }
      else if (mql.addListener) { mql.addListener(onScheme); }
    }
  }

  /* ---------- playback and reset ---------- */

  function startPlay() {
    if (state.playing) { return; }
    if (state.day >= maxDay) { state.day = 0; }
    state.playing = true;
    setText($('play'), 'Pause');
    playTimer = window.setInterval(tick, PLAY_MS);
    scheduleRender();
  }

  function stopPlay() {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
    state.playing = false;
    setText($('play'), 'Play');
  }

  function tick() {
    if (state.day < maxDay) { state.day += 1; }
    if (state.day >= maxDay) { stopPlay(); }
    scheduleRender();
  }

  function resetAll() {
    stopPlay();
    state.day = 0;
    var futEl = $('fut');
    if (futEl) {
      futEl.value = String(F0);
      state.F = Number(futEl.value);
    }
    var volEl = $('volshift');
    if (volEl) { volEl.value = '0'; }
    state.volShift = 0;
    var dayEl = $('day');
    if (dayEl) { dayEl.value = '0'; }
    scheduleRender();
  }

  /* ---------- render scheduling ---------- */

  function scheduleRender() {
    if (rafPending) { return; }
    rafPending = true;
    window.requestAnimationFrame(render);
  }

  function render() {
    rafPending = false;
    if (!state) { return; }
    try {
      renderControls();
      var sel = findExpiry(state.selExpiryIso) || expiries[0];
      if (plotReady) {
        var th = readTheme();
        renderSurface(th);
        renderSmile(th, sel);
        renderValue(th, sel);
      }
      renderContract(sel);
      renderChain(sel);
    } catch (err) {
      reportError(err);
    }
  }

  function paintFill(input) {
    if (!input) { return; }
    var min = Number(input.min), max = Number(input.max), v = Number(input.value);
    var pct = max > min ? (v - min) / (max - min) * 100 : 0;
    input.style.setProperty('--fill', clamp(pct, 0, 100).toFixed(2) + '%');
  }

  function rebuildExpiryOptions() {
    var sel = $('expiry');
    if (!sel) { return; }
    while (sel.firstChild) { sel.removeChild(sel.firstChild); }
    expiries.forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.iso;
      o.textContent = e.label + (isExpired(e, state.day) ? ' (expired)' : '');
      sel.appendChild(o);
    });
  }

  function renderControls() {
    var s = state;
    var d = NQModel.addDays(startDate, s.day);
    setText($('day-readout'), (s.day === 0 ? 'Day 0' : 'Day +' + s.day) + ' · ' + fmtDate(d));

    var live = NQModel.liveExpiries(expiries, s.day);
    setText($('next-expiry'), live.length
      ? 'Next expiry: ' + live[0].label + ' in ' + (live[0].dteAtStart - s.day) + 'd'
      : 'No live expiries left');

    var dayEl = $('day');
    if (dayEl && dayEl.value !== String(s.day)) { dayEl.value = String(s.day); }
    paintFill(dayEl);

    var futEl = $('fut');
    if (futEl && futEl.value !== String(s.F)) { futEl.value = String(s.F); }
    paintFill(futEl);
    setText($('fut-readout'), fmt(NF2, s.F));

    var volEl = $('volshift');
    var volPts = Math.round(s.volShift * 1000) / 10;
    if (volEl && Number(volEl.value) !== volPts) { volEl.value = String(volPts); }
    paintFill(volEl);
    setText($('vol-readout'), volText(s.volShift));

    var metricEl = $('metric');
    if (metricEl) { metricEl.value = s.metric; }
    setPressed('type-call', s.type === 'call');
    setPressed('type-put', s.type === 'put');

    if (live.length !== lastLiveCount) {
      lastLiveCount = live.length;
      rebuildExpiryOptions();
    }
    var expEl = $('expiry');
    if (expEl) { expEl.value = s.selExpiryIso; }
    var strEl = $('strike');
    if (strEl) { strEl.value = String(s.selStrike); }
  }

  /* ---------- 3D surface ---------- */

  function renderSurface(th) {
    var el = $('surface-chart');
    if (!el) { return; }
    var s = state, metric = s.metric, M = NQModel.METRICS[metric];
    var grid = NQModel.surfaceGrid({ metric: metric, type: s.type, expiries: expiries, strikes: strikes, day: s.day, F: s.F, volShift: s.volShift });
    var zr = zRangeFor(metric, s.type, s.F, s.volShift);

    var cmin = zr[0], cmax = zr[1], cscale;
    if (DIVERGING[metric]) {
      cscale = divergingScale(th, cmin, cmax);
    } else {
      cscale = sequentialScale(th);
    }

    var tfmt = TILE_FMT[metric] || '.4g';
    var zTitle = M.label + (M.unit ? ' (' + M.unit + ')' : '');
    var textOf = function (v) { return isNum(v) ? M.format(v) : '—'; };
    var hoverGrid = 'Strike %{x:,.0f}<br>%{y:.0f} days to expiry<br>' + M.label + ' %{z:' + tfmt + '}<extra></extra>';
    var hoverText = 'Strike %{x:,.0f}<br>%{y:.0f} days to expiry<br>%{text}<extra></extra>';
    // Plotly sizes a 3D scene by the plot's height, so a narrow plot clips the scene's
    // sides. Narrow screens get a horizontal colour bar, and the camera backs off
    // whenever the scene area is taller than it is wide.
    var compact = el.clientWidth < 560;
    var sceneW = compact ? el.clientWidth : el.clientWidth - 130;
    var sceneH = compact ? el.clientHeight - 70 : el.clientHeight;
    var zoomOut = Math.max(1, sceneH / Math.max(sceneW, 1)) * (compact ? 1.12 : 1);
    var colorbar = {
      title: { text: zTitle, font: { size: 12, color: th.text2 } },
      tickformat: tfmt,
      tickfont: { size: 11, color: th.text2 },
      thickness: compact ? 10 : 12,
      len: compact ? 0.9 : 0.6,
      outlinewidth: 0
    };
    if (compact) {
      colorbar.orientation = 'h';
      colorbar.x = 0.5;
      colorbar.xanchor = 'center';
      colorbar.y = 0;
      colorbar.yanchor = 'top';
      colorbar.title.side = 'top';
    }

    var nX = grid.x.length, nY = grid.y.length;
    var traces = [];
    if (nY >= 2) {
      traces.push({
        type: 'surface',
        x: grid.x, y: grid.y, z: grid.z,
        cmin: cmin, cmax: cmax,
        colorscale: cscale,
        showscale: true,
        colorbar: colorbar,
        hovertemplate: hoverGrid
      });
      // Listed contracts sit on the surface as small muted points.
      var lx = [], ly = [], lz = [], lt = [];
      for (var i = 0; i < nY; i++) {
        for (var j = 0; j < nX; j++) {
          var v = grid.z[i][j];
          lx.push(grid.x[j]);
          ly.push(grid.y[i]);
          lz.push(v);
          lt.push(textOf(v));
        }
      }
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x: lx, y: ly, z: lz,
        text: lt,
        hovertemplate: hoverText,
        marker: { size: 2, color: th.text2, opacity: 0.8 },
        showlegend: false
      });
    } else {
      // One live expiry: a surface needs at least two rows, so draw the strip as a line.
      var yv = grid.x.map(function () { return grid.y[0]; });
      var zv = grid.z[0];
      traces.push({
        type: 'scatter3d',
        mode: 'lines+markers',
        x: grid.x, y: yv, z: zv,
        text: zv.map(textOf),
        hovertemplate: hoverText,
        line: { color: th.text2, width: 4 },
        marker: { size: 5, color: zv, cmin: cmin, cmax: cmax, colorscale: cscale, showscale: true, colorbar: colorbar }
      });
    }

    var layout = baseLayout(th);
    layout.uirevision = 'keep';
    layout.margin = { l: 0, r: 0, t: 8, b: 0 };
    layout.scene = {
      uirevision: 'keep',
      bgcolor: 'rgba(0,0,0,0)',
      xaxis: axis3(th, 'Strike', ',.0f', nX ? [grid.x[0], grid.x[nX - 1]] : null),
      yaxis: axis3(th, 'Days to expiry', '.0f', [0, dteMax]),
      zaxis: axis3(th, '', tfmt, [zr[0], zr[1]]),
      aspectmode: 'manual',
      aspectratio: { x: 1.2, y: 1.1, z: 0.95 },
      camera: { eye: { x: -1.75 * zoomOut, y: -1.75 * zoomOut, z: 0.95 * zoomOut }, center: { x: 0.05, y: 0, z: -0.3 } }
    };

    setText($('surface-caption'), zTitle + ' · ' + (s.type === 'call' ? 'Call' : 'Put') + ' · ' +
      nY + ' live expir' + (nY === 1 ? 'y' : 'ies') + ' · click a point to select its expiry and strike');

    bindSurfaceClick(el, plot(el, traces, layout));
  }

  function bindSurfaceClick(el, p) {
    if (!p || typeof p.then !== 'function' || el.__nqBound) { return; }
    el.__nqBound = true;
    p.then(function () {
      el.on('plotly_click', onSurfaceClick);
    }).catch(reportError);
  }

  // Picks the nearest live expiry (by days to expiry) and the nearest listed strike.
  function onSurfaceClick(ev) {
    var pt = ev && ev.points && ev.points[0];
    if (!pt || !isNum(pt.x) || !isNum(pt.y)) { return; }
    var live = NQModel.liveExpiries(expiries, state.day);
    if (!live.length) { return; }
    var best = live[0], bestD = Infinity;
    live.forEach(function (e) {
      var d = Math.abs((e.dteAtStart - state.day) - pt.y);
      if (d < bestD) { bestD = d; best = e; }
    });
    state.selExpiryIso = best.iso;
    state.selStrike = nearestListed(pt.x);
    scheduleRender();
  }

  /* ---------- smile chart ---------- */

  function renderSmile(th, sel) {
    var el = $('smile-chart');
    if (!el) { return; }
    var s = state;
    var grid = NQModel.surfaceGrid({ metric: 'iv', type: s.type, expiries: expiries, strikes: strikes, day: s.day, F: s.F, volShift: s.volShift });
    var zr = zRangeFor('iv', s.type, s.F, s.volShift);
    var pad = (zr[1] - zr[0]) * 0.06;
    var yRange = [Math.max(0, zr[0] - pad), zr[1] + pad];
    var lastX = grid.x.length - 1;

    var back = [], front = [];
    var selGridIdx = -1;
    grid.expiries.forEach(function (e, i) {
      var dte = e.dteAtStart - s.day;
      var isSel = !!sel && e.iso === sel.iso;
      var base = smileColour(th, expiryT(e.dteAtStart));
      var name = e.label + ' · ' + dte + 'd';
      var trace = {
        type: 'scatter',
        mode: 'lines',
        name: e.label,
        x: grid.x,
        y: grid.z[i],
        line: { color: isSel ? base : withAlpha(base, 0.6), width: isSel ? 3 : 1.25 },
        customdata: grid.x.map(function () { return name; }),
        hovertemplate: '%{customdata}<br>K %{x:,.0f} · IV %{y:.1%}<extra></extra>',
        showlegend: false
      };
      if (isSel) {
        selGridIdx = i;
        front.push(trace);
      } else {
        back.push(trace);
      }
    });

    var layout = baseLayout(th);
    layout.hovermode = 'closest';
    layout.showlegend = false;
    layout.margin = { l: 56, r: 16, t: 28, b: 48 };
    layout.xaxis = axis2d(th, 'Strike', ',.0f', [BAND[0] * s.F, BAND[1] * s.F]);
    layout.yaxis = axis2d(th, 'Implied volatility', '.0%', yRange);
    layout.shapes = [{
      type: 'line', xref: 'x', yref: 'paper',
      x0: s.F, x1: s.F, y0: 0, y1: 1,
      line: { color: th.text2, width: 1, dash: 'dash' }
    }];
    layout.annotations = [{
      x: s.F, xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom',
      showarrow: false, text: 'F', font: { size: 12, color: th.text }
    }];
    if (selGridIdx >= 0 && isNum(grid.z[selGridIdx][lastX])) {
      layout.annotations.push({
        x: grid.x[lastX], xref: 'x', y: grid.z[selGridIdx][lastX], yref: 'y',
        xanchor: 'right', yanchor: 'bottom', yshift: 6, showarrow: false,
        text: sel.label + ' · ' + (sel.dteAtStart - s.day) + 'd',
        font: { size: 12, color: th.text }
      });
    }

    var key = $('smile-ramp');
    if (key) {
      var stops = [];
      for (var k = 0; k <= 4; k++) { stops.push(smileColour(th, k / 4) + ' ' + (k * 25) + '%'); }
      key.style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';
    }

    plot(el, back.concat(front), layout);
  }

  /* ---------- value vs futures chart ---------- */

  function renderValue(th, sel) {
    var el = $('value-chart');
    if (!el) { return; }
    var s = state;
    var K = s.selStrike, typ = s.type;
    var expired = isExpired(sel, s.day);
    var typeName = typ === 'call' ? 'Call' : 'Put';
    setText($('value-title'), (sel.code || sel.label) + ' ' + NF0.format(K) + ' ' + typeName + ' — value vs futures price');

    var lo = 0.8 * F0, hi = 1.2 * F0;
    var xs = [], payoff = [], day0 = [], now = [];
    for (var i = 0; i < VALUE_POINTS; i++) {
      var fx = lo + (hi - lo) * i / (VALUE_POINTS - 1);
      xs.push(fx);
      payoff.push(NQModel.contractState({ expiry: sel, K: K, type: typ, day: sel.dteAtStart, F: fx, volShift: s.volShift }).intrinsic);
      if (!expired) {
        day0.push(NQModel.contractState({ expiry: sel, K: K, type: typ, day: 0, F: fx, volShift: s.volShift }).price);
        now.push(NQModel.contractState({ expiry: sel, K: K, type: typ, day: s.day, F: fx, volShift: s.volShift }).price);
      }
    }
    var cur = NQModel.contractState({ expiry: sel, K: K, type: typ, day: s.day, F: s.F, volShift: s.volShift });
    var markerY = expired ? cur.intrinsic : cur.price;
    var nowLabel = 'Now (' + (s.day === 0 ? 'Day 0' : 'Day +' + s.day) + ')';

    var traces = [{
      type: 'scatter', mode: 'lines', name: 'At expiry (payoff)',
      x: xs, y: payoff,
      line: { color: th.text2, width: 1.75, dash: 'dash' },
      hovertemplate: '%{y:,.1f} pts<extra>At expiry (payoff)</extra>'
    }];
    if (!expired) {
      traces.push({
        type: 'scatter', mode: 'lines', name: 'Day 0',
        x: xs, y: day0,
        line: { color: th.muted, width: 1.5 },
        hovertemplate: '%{y:,.1f} pts<extra>Day 0</extra>'
      });
      traces.push({
        type: 'scatter', mode: 'lines', name: nowLabel,
        x: xs, y: now,
        line: { color: th.accent, width: 3 },
        hovertemplate: '%{y:,.1f} pts<extra>' + nowLabel + '</extra>'
      });
    }
    traces.push({
      type: 'scatter', mode: 'markers', name: 'Current futures',
      x: [s.F], y: [markerY],
      marker: { size: 11, color: th.accent, line: { color: th.surface, width: 2 } },
      hoverinfo: 'skip',
      showlegend: false
    });

    var ymax = 0;
    [payoff, day0, now].forEach(function (arr) {
      arr.forEach(function (v) { if (isNum(v) && v > ymax) { ymax = v; } });
    });

    var layout = baseLayout(th);
    layout.hovermode = 'x unified';
    layout.margin = { l: 60, r: 16, t: 44, b: 50 };
    layout.showlegend = true;
    layout.legend = {
      orientation: 'h', x: 0, xanchor: 'left', y: 1.02, yanchor: 'bottom',
      font: { size: 12, color: th.text2 }, bgcolor: 'rgba(0,0,0,0)'
    };
    layout.xaxis = axis2d(th, 'Futures price', ',.0f', [lo, hi]);
    layout.yaxis = axis2d(th, 'Value (pts)', ',.0f', [0, ymax > 0 ? ymax * 1.08 : 1]);
    layout.shapes = [{
      type: 'line', xref: 'x', yref: 'paper',
      x0: K, x1: K, y0: 0, y1: 1,
      line: { color: th.muted, width: 1, dash: 'dot' }
    }];
    layout.annotations = expired ? [{
      xref: 'paper', yref: 'paper', x: 0.01, y: 0.97,
      xanchor: 'left', yanchor: 'top', showarrow: false,
      text: 'Expired — settled at intrinsic ' + NF1.format(cur.intrinsic) + ' pts',
      font: { size: 13, color: th.text }
    }] : [];

    plot(el, traces, layout);
  }

  /* ---------- contract card ---------- */

  function renderContract(sel) {
    var s = state;
    var cs = NQModel.contractState({ expiry: sel, K: s.selStrike, type: s.type, day: s.day, F: s.F, volShift: s.volShift });
    var base = NQModel.contractState({ expiry: sel, K: s.selStrike, type: s.type, day: 0, F: s.F, volShift: s.volShift });
    var typeName = s.type === 'call' ? 'Call' : 'Put';
    setText($('contract-title'), (sel.code || sel.label) + ' ' + NF0.format(s.selStrike) + ' ' + typeName);

    var st = $('contract-status');
    if (st) {
      st.textContent = cs.expired
        ? 'Expired · settled at intrinsic ' + fmt(NF2, cs.intrinsic) + ' pts'
        : 'Live · expires ' + fmtDate(NQModel.addDays(startDate, sel.dteAtStart));
      st.classList.toggle('is-expired', !!cs.expired);
    }

    var dash = '—';
    setText($('c-premium'), fmt(NF2, cs.price) + ' pts');
    setText($('c-premium-usd'), fmt(USD0, cs.price * MULT));
    setText($('c-iv'), cs.expired ? dash : fmt(PCT1, cs.iv));
    setText($('c-delta'), cs.expired ? dash : fmt(NF3, cs.delta));
    setText($('c-gamma'), cs.expired ? dash : fmt(NF6, cs.gamma));
    setText($('c-theta'), cs.expired ? dash : fmt(NF2, cs.theta) + ' pts/day');
    setText($('c-theta-usd'), cs.expired ? '' : fmt(USD0, cs.theta * MULT) + ' per day');
    setText($('c-vega'), cs.expired ? dash : fmt(NF2, cs.vega) + ' pts per vol pt');
    setText($('c-vega-usd'), cs.expired ? '' : fmt(USD0, cs.vega * MULT) + ' per vol pt');
    setText($('c-dte'), cs.expired ? 'Expired' : fmt(NF0, cs.dte) + (cs.dte === 1 ? ' day' : ' days'));
    setText($('c-moneyness'), fmt(NF3, s.selStrike / s.F));

    var diff = cs.price - base.price;
    var pct = base.price > 0 ? diff / base.price : NaN;
    setText($('c-decay'), 'Decay since Day 0: ' + fmt(SIGN1, diff) + ' pts (' +
      (isNum(pct) ? fmt(SIGN1, pct * 100) + '%' : 'n/a') + ')');
  }

  /* ---------- mini chain ---------- */

  function renderChain(sel) {
    if (!chainRows.length) { return; }
    var s = state, n = chainRows.length;
    var expired = isExpired(sel, s.day);
    var dte = sel.dteAtStart - s.day;
    setText($('chain-caption'), 'Chain · ' + sel.label + ' · ' +
      (expired ? '(expired)' : fmt(NF0, dte) + 'd'));

    var atm = nearestIndex(s.F);
    var start = clamp(atm - Math.floor(n / 2), 0, Math.max(0, strikes.length - n));
    for (var r = 0; r < n; r++) {
      var idx = start + r;
      var K = strikes[idx];
      var c = NQModel.contractState({ expiry: sel, K: K, type: 'call', day: s.day, F: s.F, volShift: s.volShift });
      var p = NQModel.contractState({ expiry: sel, K: K, type: 'put', day: s.day, F: s.F, volShift: s.volShift });
      var row = chainRows[r];
      var tr = row.tr, cells = row.cells;
      var isSel = K === s.selStrike;
      tr.dataset.strike = String(K);
      tr.classList.toggle('atm', idx === atm);
      tr.classList.toggle('selected', isSel);
      if (isSel) { tr.setAttribute('aria-current', 'true'); }
      else { tr.removeAttribute('aria-current'); }
      setText(cells[0], expired ? '—' : fmt(NF2, c.delta));
      setText(cells[1], fmt(NF1, expired ? c.intrinsic : c.price));
      setText(cells[2], NF0.format(K));
      setText(cells[3], fmt(NF1, expired ? p.intrinsic : p.price));
      setText(cells[4], expired ? '—' : fmt(NF2, p.delta));
    }
  }

  /* ---------- boot ---------- */

  function safeInit() {
    try {
      init();
    } catch (err) {
      reportError(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
