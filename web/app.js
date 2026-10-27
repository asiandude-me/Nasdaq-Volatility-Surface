/* VolDesk front end. Reads window.VOLDESK (built by build_dashboard.py) and renders
 * everything client-side: GEX, the pricer and scenario P&L are computed live here. */
(() => {
  'use strict';

  const D = window.VOLDESK;
  if (!D) {
    document.querySelector('main').innerHTML = '<p class="muted">No data payload. Run <code>python build_dashboard.py</code>.</p>';
    return;
  }
  const HAS_PLOTLY = typeof window.Plotly !== 'undefined';
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  // ---------------------------------------------------------------- math
  const SQRT2PI = Math.sqrt(2 * Math.PI);
  function erf(x) { // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
    const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    const y = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return s * (1 - y * Math.exp(-a * a));
  }
  const ncdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
  const npdf = x => Math.exp(-0.5 * x * x) / SQRT2PI;

  function black(F, K, T, sig, isCall, Df) {
    if (T <= 1e-9 || sig <= 1e-9) return Df * Math.max(isCall ? F - K : K - F, 0);
    const v = sig * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * v * v) / v, d2 = d1 - v;
    return isCall ? Df * (F * ncdf(d1) - K * ncdf(d2)) : Df * (K * ncdf(-d2) - F * ncdf(-d1));
  }
  const sviW = (p, k) => p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) ** 2 + p.sigma ** 2));
  const callDelta = (k, iv, T) => { const sw = iv * Math.sqrt(T); return ncdf(-k / sw + 0.5 * sw); };
  const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
  const DAY_TICKS = [1, 2, 5, 10, 30, 60, 120, 250, 500, 1000];
  const dayTicks = days => {
    const lo = Math.min(...days), hi = Math.max(...days);
    return { tickvals: DAY_TICKS.filter(d => d >= lo * 0.8 && d <= hi * 1.25) };
  };

  // ---------------------------------------------------------------- data views
  const M = D.meta, SUM = D.summary, E = D.expiries, P = D.points, H = D.history, G = D.gex;
  const SPOT = M.spot;
  E.forEach((e, i) => { e.i = i; e.days = e.T * 365; });
  const FITTED = E.filter(e => e.svi);
  const POINTS_BY_EXPIRY = E.map(() => []);
  P.e.forEach((ei, j) => POINTS_BY_EXPIRY[ei].push(j));

  function ivAt(e, k) { // vol held flat past the quoted range, matching the Python side
    if (!e.svi) return NaN;
    const kc = Math.min(Math.max(k, e.k_lo - 0.05), e.k_hi + 0.05);
    return Math.sqrt(Math.max(sviW(e.svi, kc), 1e-12) / e.T);
  }
  function atmAt(days) { // constant maturity: linear in total variance
    const pts = FITTED.filter(e => e.atm != null);
    const t = days / 365;
    if (!pts.length) return NaN;
    if (t <= pts[0].T) return pts[0].atm;
    if (t >= pts[pts.length - 1].T) return pts[pts.length - 1].atm;
    const j = pts.findIndex(e => e.T >= t);
    const a = pts[j - 1], b = pts[j], lam = (t - a.T) / (b.T - a.T);
    return Math.sqrt(((1 - lam) * a.atm ** 2 * a.T + lam * b.atm ** 2 * b.T) / t);
  }
  const nearestFitted = days => FITTED.reduce((best, e) => Math.abs(e.days - days) < Math.abs(best.days - days) ? e : best, FITTED[0]);

  // ---------------------------------------------------------------- formatting
  const MINUS = '−';
  const ok = v => v != null && Number.isFinite(v);
  const num = (v, d = 2) => ok(v) ? (v < 0 ? MINUS : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const signed = (v, d = 2) => ok(v) ? (v > 0 ? '+' : '') + num(v, d) : '—';
  const pct = (v, d = 1) => ok(v) ? num(v * 100, d) + '%' : '—';
  const volPts = (v, d = 1) => ok(v) ? signed(v * 100, d) : '—';
  const usd = (v, d = 2) => ok(v) ? (v < 0 ? MINUS : '') + '$' + num(Math.abs(v), d) : '—';
  function usdCompact(v) {
    if (!ok(v)) return '—';
    const a = Math.abs(v), sign = v < 0 ? MINUS : (v > 0 ? '+' : '');
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}bn`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}m`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}k`;
    return `${sign}$${a.toFixed(0)}`;
  }
  const shortDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const longDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const EST_NAME = { c2c: 'close–close', parkinson: 'Parkinson', garman_klass: 'Garman–Klass', yang_zhang: 'Yang–Zhang' };
  const VIX_NAME = SUM.vol_index ? SUM.vol_index.name.replace('^', '') : null;

  // ---------------------------------------------------------------- theme
  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
      text: v('--text'), text2: v('--text-2'), muted: v('--muted'), grid: v('--grid'), baseline: v('--baseline'),
      surface: v('--surface'), surface2: v('--surface-2'), border: v('--border-strong'),
      s: [v('--s1'), v('--s2'), v('--s3')], pos: v('--pos'), neg: v('--neg'),
      seq: v('--seq').split(',').map(c => c.trim()),
    };
  }
  function alpha(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------------------------------------------------------------- plotly helpers
  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const CONFIG = { responsive: true, displayModeBar: false, displaylogo: false };
  function axis(t, extra = {}) {
    const { title, ...rest } = extra;
    return {
      gridcolor: t.grid, gridwidth: 1, linecolor: t.baseline, linewidth: 1, showline: true, zeroline: false,
      ticks: '', tickfont: { color: t.muted, size: 10.5 }, automargin: true, fixedrange: true, ...rest,
      title: { font: { color: t.muted, size: 11 }, standoff: 10, ...title },
    };
  }
  function layout(t, extra = {}) {
    return {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: FONT, size: 11, color: t.text2 },
      margin: { l: 8, r: 12, t: 6, b: 8 },
      showlegend: false, hovermode: 'closest', dragmode: false,
      hoverlabel: { bgcolor: t.surface2, bordercolor: t.border, font: { family: FONT, size: 12, color: t.text }, align: 'left' },
      legend: {
        orientation: 'h', x: 0, xanchor: 'left', y: 1.02, yanchor: 'bottom', bgcolor: 'rgba(0,0,0,0)',
        font: { size: 11.5, color: t.text2 }, itemclick: false, itemdoubleclick: false,
      },
      ...extra,
      xaxis: axis(t, extra.xaxis), yaxis: axis(t, extra.yaxis),
    };
  }
  const vline = (x, color, dash = 'solid', width = 1) => ({ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color, width, dash } });
  const hline = (y, color, dash = 'solid') => ({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1, dash } });
  const label = (t, x, y, text, extra = {}) => ({
    x, y, xref: 'x', yref: 'paper', text, showarrow: false, font: { size: 11, color: t.text2 },
    bgcolor: alpha(t.surface, 0.85), borderpad: 3, yanchor: 'bottom', ...extra,
  });
  const lineTrace = (x, y, color, name, extra = {}) => ({ type: 'scatter', mode: 'lines', x, y, name, line: { color, width: 2 }, ...extra });
  const markers = (t, color, size = 8) => ({ size, color, line: { color: t.surface, width: 2 } });

  function draw(el, traces, lay) {
    if (!HAS_PLOTLY) {
      el.innerHTML = '<p class="muted small" style="padding:24px">Charts need Plotly, which failed to load. Toggle the table view to read the data.</p>';
      return;
    }
    return Plotly.react(el, traces, lay, CONFIG);
  }

  // ---------------------------------------------------------------- state + panels
  const state = {
    surfaceView: '3d', showQuotes: false, orbit: false, smileX: 'moneyness', pricerType: 'call',
    gexWindow: 'all', range: '252', estimator: 'yang_zhang', tables: {},
  };
  const panels = {};
  function panel(name, chartId, render, table, sync = () => {}) {
    const root = $(`[data-panel="${name}"]`);
    const chart = $('#' + chartId);
    const tableView = document.createElement('div');
    tableView.className = 'table-view';
    tableView.hidden = true;
    chart.after(tableView);
    panels[name] = { root, chart, tableView, render, table, sync };
  }
  function renderPanel(name) {
    const p = panels[name];
    if (!p || p.root.hidden) return;
    const asTable = !!state.tables[name];
    p.sync();
    p.chart.hidden = asTable;
    p.tableView.hidden = !asTable;
    if (asTable) p.tableView.innerHTML = tableHTML(p.table());
    else p.render(p.chart);
  }
  const renderAll = () => Object.keys(panels).forEach(renderPanel);

  function tableHTML({ columns, rows }) {
    const head = columns.map(c => `<th>${esc(c)}</th>`).join('');
    const body = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ================================================================ top bar + KPIs
  function renderTopbar() {
    const chg = SPOT - M.prev_close, chgPct = chg / M.prev_close;
    const dir = chg >= 0 ? 'up' : 'down';
    $('#quote').innerHTML = `<span class="ticker">${esc(M.ticker)}</span><span class="px">${num(SPOT)}</span>` +
      `<span class="chg ${dir}">${signed(chg)} (${signed(chgPct * 100)}%)</span>`;

    const gen = new Date(M.generated);
    const ageH = (Date.now() - gen.getTime()) / 36e5;
    const when = gen.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const ago = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))}m ago` : ageH < 48 ? `${Math.round(ageH)}h ago` : `${Math.round(ageH / 24)}d ago`;
    const stale = ageH > 72;
    $('#meta').innerHTML =
      `<span class="pulse${stale ? ' stale' : ''}" title="${stale ? 'Snapshot is over 3 days old' : 'Recent snapshot'}"></span>` +
      `<span>Snapshot ${esc(when)} ET · ${ago}</span>` +
      (M.demo ? `<span class="badge warn"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1L8 1.5z"/><path d="M8 6v3.5M8 11.5v.5"/></svg>Demo data</span>` : '');
    $('#demo-banner').hidden = !M.demo;
    if (M.repo) {
      const link = $('#refresh-link');
      link.href = `https://github.com/${M.repo}/actions/workflows/dashboard.yml`;
      link.hidden = false;
      link.title = 'Open the workflow on GitHub and press "Run workflow" to rebuild with fresh data';
    }
    $('#footer-data').textContent =
      `${M.demo ? 'Synthetic demo market.' : 'Yahoo Finance via yfinance, quotes delayed about 15 minutes.'} ` +
      `${M.ticker} options stand in for NQ futures options, which Yahoo does not publish. ` +
      `${M.n_quotes.toLocaleString()} OTM quotes across ${M.n_expiries} expiries, SVI fitted on ${M.n_fitted}. ` +
      `Discounting at ${pct(M.rate, 2)} (13-week T-bill). Last daily bar ${longDate(M.last_session)}.`;
  }

  function sparkline(values) {
    const v = values.filter(ok);
    if (v.length < 2) return '';
    const lo = Math.min(...v), hi = Math.max(...v), w = 96, h = 36, pad = 4;
    const xs = i => pad + (w - 2 * pad) * i / (v.length - 1);
    const ys = y => h - pad - (h - 2 * pad) * (hi === lo ? 0.5 : (y - lo) / (hi - lo));
    const d = v.map((y, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(y).toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="line" d="${d}"/>` +
      `<circle cx="${xs(v.length - 1).toFixed(1)}" cy="${ys(v[v.length - 1]).toFixed(1)}" r="3.5"/></svg>`;
  }

  function renderKpis(gexAll) {
    const n = H.date.length, tail = (arr, k = 60) => (arr || []).slice(Math.max(0, n - k));
    const rvYZ = SUM.rv21.yang_zhang;
    const vi = SUM.vol_index;
    const nm = SUM.next_move;
    const vrpSeries = H.vix ? H.vix.map((x, i) => ok(x) && ok(H.rv.yang_zhang[i]) ? x - H.rv.yang_zhang[i] : null) : [];
    const chg = SPOT - M.prev_close;
    const tiles = [
      { label: `${M.ticker} spot`, value: num(SPOT), foot: `<span class="${chg >= 0 ? 'up' : 'down'}">${signed(chg)}</span> vs prior close`, spark: tail(H.close) },
      { label: '30d ATM implied vol', value: pct(SUM.iv30), foot: `60d ${pct(SUM.iv60)} · 90d ${pct(SUM.iv90)}` },
      vi ? { label: `${VIX_NAME} index`, value: num(vi.level * 100, 2), foot: `${signed(vi.change * 100)} pts · ${Math.round(vi.percentile * 100)}th pctile 1y`, spark: tail(H.vix) }
        : { label: '180d ATM implied vol', value: pct(SUM.iv180), foot: 'No vol index for this ticker' },
      { label: '21d realised (Yang–Zhang)', value: pct(rvYZ), foot: `C2C ${pct(SUM.rv21.c2c)} · Parkinson ${pct(SUM.rv21.parkinson)}`, spark: tail(H.rv.yang_zhang) },
      { label: 'Vol risk premium', value: `${volPts(SUM.vrp)}<small>pts</small>`, foot: `30d implied ${SUM.vrp >= 0 ? 'over' : 'under'} 21d realised`, spark: tail(vrpSeries) },
      { label: '25Δ risk reversal · 30d', value: `${volPts(SUM.rr25_30)}<small>pts</small>`, foot: `25Δ fly ${volPts(SUM.bf25_30, 2)} pts` },
      G ? { label: 'Net dealer gamma', value: usdCompact(gexAll.net), foot: gexAll.flip ? `per 1% move · flip ${num(gexAll.flip)}` : 'per 1% move · no flip in ±12%' }
        : { label: 'Net dealer gamma', value: '—', foot: 'No open interest in this snapshot' },
      nm ? { label: `1σ implied move · ${shortDate(nm.expiry)}`, value: `±${usd(nm.abs)}`, foot: `±${pct(nm.abs / SPOT, 2)} · ${nm.dte}d at ${pct(nm.iv)} ATM` }
        : { label: 'Implied move', value: '—', foot: '' },
    ];
    $('#kpis').innerHTML = tiles.map(t => `<div class="tile"><div class="label">${t.label}</div>` +
      `<div class="value">${t.value}</div>${t.spark ? sparkline(t.spark) : ''}<div class="foot">${t.foot}</div></div>`).join('');
  }

  function renderNotes(gexAll) {
    const notes = [];
    const slope = SUM.iv90 - SUM.iv30;
    notes.push(['Term', Math.abs(slope) < 0.0025
      ? `<strong>Flat term structure</strong>: 30d ${pct(SUM.iv30)} vs 90d ${pct(SUM.iv90)}.`
      : slope > 0
        ? `<strong>Contango</strong>: 90d ATM ${pct(SUM.iv90)} sits ${num(slope * 100, 1)} pts over 30d, the normal calm-market shape.`
        : `<strong>Backwardation</strong>: 30d ATM ${pct(SUM.iv30)} is ${num(-slope * 100, 1)} pts over 90d. Front-end demand like this usually means event or stress pricing.`]);
    notes.push(['Premium', `30d implied is <strong>${volPts(SUM.vrp)} pts ${SUM.vrp >= 0 ? 'above' : 'below'}</strong> 21d Yang–Zhang realised. ` +
      (SUM.vrp >= 0 ? 'Options are priced for more movement than the index has delivered.' : 'The index is moving more than options price, which is unusual and tends not to persist.')]);
    notes.push(['Skew', `25Δ risk reversal at 30d is <strong>${volPts(SUM.rr25_30)} pts</strong>: ` + (SUM.rr25_30 <= 0
      ? `downside puts trade ${num(-SUM.rr25_30 * 100, 1)} vol pts over equivalent upside calls.`
      : `upside calls trade ${num(SUM.rr25_30 * 100, 1)} vol pts over downside puts, unusual for an equity index.`)]);
    if (SUM.vol_index) {
      const vi = SUM.vol_index;
      notes.push(['Level', `${VIX_NAME} at <strong>${num(vi.level * 100)}</strong> is in the ${Math.round(vi.percentile * 100)}th percentile of its 1y range (${num(vi.low * 100, 1)}–${num(vi.high * 100, 1)}).`]);
    }
    if (!G) notes.push(['Gamma', NO_OI]);
    else notes.push(['Gamma', gexAll.flip
      ? `Naive dealer gamma is <strong>${usdCompact(gexAll.net)}</strong> per 1% at spot, flipping sign near <strong>${num(gexAll.flip)}</strong> (${signed((gexAll.flip / SPOT - 1) * 100)}% from spot). ` +
        (gexAll.net >= 0 ? 'Long gamma above the flip tends to dampen moves.' : 'Short gamma below the flip tends to amplify moves.')
      : `Naive dealer gamma is <strong>${usdCompact(gexAll.net)}</strong> per 1% with no sign change within ±12% of spot.`]);
    const bad = FITTED.filter(e => e.min_g < -1e-6).length;
    const cal = D.calendar.length;
    const issues = [bad && `${bad} butterfly`, cal && `${cal} calendar`].filter(Boolean).join(' and ');
    notes.push(['Model', !issues
      ? `SVI fits are <strong>arbitrage-free</strong> on all ${FITTED.length} slices (butterfly and calendar).`
      : `<strong>${issues}</strong> violation${bad + cal > 1 ? 's' : ''} across ${FITTED.length} SVI slices, typically thin far-dated quotes. See diagnostics below.`]);
    $('#notes').innerHTML = notes.map(([tag, html]) => `<li><span class="tag">${tag}</span><span>${html}</span></li>`).join('');
  }

  // ================================================================ surface
  let flown = false, orbitTimer = null, lastCamera = null;
  const CAMERA = { eye: { x: 1.3, y: -1.38, z: 0.62 }, center: { x: 0.02, y: 0, z: -0.14 } };

  function renderSurface(el) {
    const t = tokens(), S = D.surface;
    const z = S.iv.map(row => row.map(v => v == null ? null : v * 100));
    const colorscale = t.seq.map((c, i, a) => [i / (a.length - 1), c]);
    const colorbar = {
      thickness: 10, len: 0.62, outlinewidth: 0, ticksuffix: '%', tickfont: { color: t.muted, size: 10.5 },
      title: { text: 'IV', font: { color: t.muted, size: 11 } }, x: 1.0, xpad: 4,
    };
    const hover = 'K/S %{x:.3f}<br>%{y:.0f} days<br><b>IV %{z:.2f}%</b><extra></extra>';
    stopOrbit();
    if (state.surfaceView === 'heatmap') {
      const traces = [{
        type: 'heatmap', x: S.x, y: S.dte, z, colorscale, zsmooth: 'best', colorbar, hovertemplate: hover, hoverongaps: false,
      }];
      if (state.showQuotes) traces.push(quoteTrace2d(t));
      draw(el, traces, layout(t, {
        xaxis: { title: { text: 'Moneyness K / S' }, showline: false, showgrid: false },
        yaxis: { title: { text: 'Days to expiry' }, type: 'log', showline: false, showgrid: false, ...dayTicks(S.dte) },
        shapes: [vline(1, alpha(t.text, 0.5), 'dot')],
      }));
      return;
    }
    const sceneAxis = (title, extra = {}) => ({
      title: { text: title, font: { color: t.muted, size: 11 } }, gridcolor: t.grid, linecolor: t.baseline, zerolinecolor: t.baseline,
      showbackground: false, tickfont: { color: t.muted, size: 10 }, showspikes: false, ...extra,
    });
    // 3D uses the fan grid: each row spans only its own quoted K/S range, so edges stay smooth.
    const fz = S.fan_iv.map(row => row.map(v => v == null ? null : v * 100));
    const fy = S.dte.map(d => S.fan_x[0].map(() => d));
    const zmin = Math.min(...fz.flat().filter(ok)), zmax = Math.max(...fz.flat().filter(ok));
    const traces = [{
      type: 'surface', x: S.fan_x, y: fy, z: fz, colorscale, colorbar, hovertemplate: hover,
      lighting: { ambient: 0.62, diffuse: 0.6, specular: 0.14, roughness: 0.65, fresnel: 0.15 },
      lightposition: { x: 1e5, y: -1e5, z: 2e5 },
      contours: {
        z: { show: true, start: Math.ceil(zmin), end: Math.floor(zmax), size: zmax - zmin > 20 ? 2 : 1, color: alpha(t.surface, 0.45), width: 1 },
        x: { highlight: true, highlightcolor: t.text, highlightwidth: 2 },
        y: { highlight: true, highlightcolor: t.text, highlightwidth: 2 },
      },
    }];
    if (state.showQuotes) {
      // Only quotes inside the plotted fan: far-wing prints would stretch the IV axis and flatten the surface.
      const inFan = P.K.map((K, j) => {
        const d = E[P.e[j]].days, row = S.dte.reduce((b, v, r) => Math.abs(Math.log(v / d)) < Math.abs(Math.log(S.dte[b] / d)) ? r : b, 0);
        const xs = S.fan_x[row], x = K / SPOT;
        return d >= S.dte[0] * 0.95 && d <= S.dte[S.dte.length - 1] * 1.05 && x >= xs[0] && x <= xs[xs.length - 1];
      });
      const keep = P.K.map((_, j) => j).filter(j => inFan[j]);
      traces.push({
        type: 'scatter3d', mode: 'markers', x: keep.map(j => P.K[j] / SPOT), y: keep.map(j => E[P.e[j]].days), z: keep.map(j => P.iv[j] * 100),
        marker: { size: 1.8, color: t.text2, opacity: 0.7 }, hoverinfo: 'skip', name: 'Quotes',
      });
    }
    draw(el, traces, {
      ...layout(t), margin: { l: 0, r: 0, t: 0, b: 0 }, uirevision: 'surface',
      scene: {
        xaxis: sceneAxis('K / S'), yaxis: sceneAxis('Days', { type: 'log', ...dayTicks(S.dte) }), zaxis: sceneAxis('', { ticksuffix: '%' }),
        aspectmode: 'manual', aspectratio: { x: 1.25, y: 1.35, z: 0.78 }, camera: flown ? (lastCamera || homeCamera(el)) : farCamera(),
        bgcolor: 'rgba(0,0,0,0)', dragmode: 'turntable',
      },
    })?.then(() => {
      if (!flown) { flown = true; flyIn(el); }
      if (state.orbit) startOrbit(el);
    });
    if (!el.dataset.bound && HAS_PLOTLY) {
      el.dataset.bound = '1';
      el.addEventListener('pointerdown', () => { if (state.orbit) setToggle('orbit', false); });
      el.on('plotly_relayout', ev => {
        if (ev['scene.camera']) lastCamera = ev['scene.camera'];
        else if (ev['scene.camera.eye']) lastCamera = { ...(lastCamera || CAMERA), eye: ev['scene.camera.eye'] };
      });
    }
  }
  function homeCamera(el) { // narrow panels need the camera further back to fit the scene
    const k = el.clientWidth < 640 ? 1.4 : 1;
    return { eye: { x: CAMERA.eye.x * k, y: CAMERA.eye.y * k, z: CAMERA.eye.z * k }, center: CAMERA.center };
  }
  function farCamera() {
    return REDUCED_MOTION ? homeCamera(panels.surface.chart) : { eye: { x: 2.7, y: -0.6, z: 1.6 }, center: CAMERA.center };
  }
  function animateCamera(el, from, to, ms) {
    return new Promise(resolve => {
      const t0 = performance.now();
      const step = now => {
        if (state.surfaceView !== '3d' || state.tables.surface) return resolve(); // view changed mid-flight
        const u = Math.min(1, (now - t0) / ms), e = 1 - (1 - u) ** 3;
        const lerp = k => from[k] + (to[k] - from[k]) * e;
        Plotly.relayout(el, { 'scene.camera.eye': { x: lerp('x'), y: lerp('y'), z: lerp('z') } });
        if (u < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function flyIn(el) {
    if (REDUCED_MOTION || !HAS_PLOTLY) return;
    animateCamera(el, farCamera().eye, homeCamera(el).eye, 1600);
  }
  function startOrbit(el) {
    stopOrbit();
    let last = performance.now();
    orbitTimer = setInterval(() => {
      const eye = el.layout?.scene?.camera?.eye || homeCamera(el).eye;
      const now = performance.now(), dtheta = (now - last) / 1000 * 0.22;
      last = now;
      const r = Math.hypot(eye.x, eye.y), th = Math.atan2(eye.y, eye.x) + dtheta;
      Plotly.relayout(el, { 'scene.camera.eye': { x: r * Math.cos(th), y: r * Math.sin(th), z: eye.z } });
    }, 40);
  }
  function stopOrbit() { if (orbitTimer) { clearInterval(orbitTimer); orbitTimer = null; } }
  function quoteTrace2d(t) {
    return {
      type: 'scatter', mode: 'markers', x: P.K.map(k => k / SPOT), y: P.e.map(i => E[i].days),
      marker: { size: 3, color: t.text, opacity: 0.45 }, hoverinfo: 'skip',
    };
  }
  function surfaceTable() {
    const cols = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15];
    return {
      columns: ['Expiry', 'DTE', ...cols.map(x => `${x.toFixed(2)} K/S`)],
      rows: FITTED.map(e => [longDate(e.date), e.dte, ...cols.map(x => {
        const k = Math.log(x * SPOT / e.F);
        return k < e.k_lo - 0.02 || k > e.k_hi + 0.02 ? '<span class="muted">—</span>' : pct(ivAt(e, k));
      })]),
    };
  }

  // ================================================================ term + skew
  function renderTerm(el) {
    const t = tokens();
    const withAtm = E.filter(e => e.atm != null && e.days > 0.5);
    const fx = FITTED.filter(e => e.iv25p != null && e.iv25c != null);
    const cd = arr => arr.map(e => `${shortDate(e.date)} · ${e.dte}d`);
    const traces = [
      lineTrace(fx.map(e => e.days), fx.map(e => e.iv25p * 100), t.s[1], '25Δ put', { mode: 'lines+markers', marker: markers(t, t.s[1], 6), customdata: cd(fx), hovertemplate: '25Δ put %{y:.1f}%<extra></extra>' }),
      lineTrace(withAtm.map(e => e.days), withAtm.map(e => e.atm * 100), t.s[0], 'ATM', { mode: 'lines+markers', marker: markers(t, t.s[0], 7), customdata: cd(withAtm), hovertemplate: '%{customdata}<br>ATM %{y:.1f}%<extra></extra>' }),
      lineTrace(fx.map(e => e.days), fx.map(e => e.iv25c * 100), t.s[2], '25Δ call', { mode: 'lines+markers', marker: markers(t, t.s[2], 6), customdata: cd(fx), hovertemplate: '25Δ call %{y:.1f}%<extra></extra>' }),
    ];
    const annotations = [];
    if (SUM.vol_index) {
      traces.push({
        type: 'scatter', mode: 'markers', x: [30], y: [SUM.vol_index.level * 100], name: VIX_NAME, showlegend: false,
        marker: { symbol: 'diamond', size: 10, color: t.surface, line: { color: t.text2, width: 1.5 } },
        hovertemplate: `${VIX_NAME} %{y:.2f} (30d index)<extra></extra>`,
      });
      annotations.push({ x: Math.log10(30), y: SUM.vol_index.level * 100, text: VIX_NAME, showarrow: false, yshift: 14, font: { size: 10.5, color: t.muted } });
    }
    draw(el, traces, layout(t, {
      showlegend: true, hovermode: 'x unified', annotations,
      xaxis: { type: 'log', title: { text: 'Days to expiry' }, showgrid: false, ...dayTicks(E.map(e => e.days)) },
      yaxis: { ticksuffix: '%' },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  const termTable = () => ({
    columns: ['Expiry', 'DTE', 'ATM', '25Δ put', '25Δ call'],
    rows: E.filter(e => e.atm != null).map(e => [longDate(e.date), e.dte, pct(e.atm), pct(e.iv25p), pct(e.iv25c)]),
  });

  function renderSkew(el) {
    const t = tokens();
    const fx = FITTED.filter(e => e.rr25 != null);
    const cd = fx.map(e => `${shortDate(e.date)} · ${e.dte}d`);
    draw(el, [
      lineTrace(fx.map(e => e.days), fx.map(e => e.rr25 * 100), t.s[0], '25Δ risk reversal', { mode: 'lines+markers', marker: markers(t, t.s[0], 6), customdata: cd, hovertemplate: '%{customdata}<br>RR %{y:.2f}<extra></extra>' }),
      lineTrace(fx.map(e => e.days), fx.map(e => e.bf25 * 100), t.s[1], '25Δ butterfly', { mode: 'lines+markers', marker: markers(t, t.s[1], 6), hovertemplate: 'BF %{y:.2f}<extra></extra>' }),
    ], layout(t, {
      showlegend: true, hovermode: 'x unified',
      xaxis: { type: 'log', title: { text: 'Days to expiry' }, showgrid: false, ...dayTicks(E.map(e => e.days)) },
      yaxis: { zeroline: true, zerolinecolor: t.baseline, zerolinewidth: 1 },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  const skewTable = () => ({
    columns: ['Expiry', 'DTE', 'RR 25Δ (pts)', 'BF 25Δ (pts)'],
    rows: FITTED.map(e => [longDate(e.date), e.dte, volPts(e.rr25, 2), volPts(e.bf25, 2)]),
  });

  // ================================================================ smile explorer
  const smileSlots = [null, null, null]; // colour follows the expiry, never its rank
  const smileOrder = [];
  function toggleSmile(i) {
    const slot = smileSlots.indexOf(i);
    if (slot >= 0) {
      if (smileOrder.length === 1) return;
      smileSlots[slot] = null;
      smileOrder.splice(smileOrder.indexOf(i), 1);
    } else {
      let free = smileSlots.indexOf(null);
      if (free < 0) { // replace the oldest pick
        const oldest = smileOrder.shift();
        free = smileSlots.indexOf(oldest);
      }
      smileSlots[free] = i;
      smileOrder.push(i);
    }
    renderChips();
    renderPanel('smile');
  }
  function renderChips() {
    const t = tokens();
    $('#expiry-chips').innerHTML = E.map(e => {
      const slot = smileSlots.indexOf(e.i);
      const disabled = POINTS_BY_EXPIRY[e.i].length < 3;
      return `<button type="button" data-i="${e.i}" aria-pressed="${slot >= 0}" ${disabled ? 'disabled' : ''}>` +
        `<span class="dot" style="${slot >= 0 ? `background:${t.s[slot]}` : ''}"></span>${shortDate(e.date)} <span class="dte">${e.dte}d</span></button>`;
    }).join('');
  }
  function smileX(mode, e, k, iv) {
    if (mode === 'strike') return e.F * Math.exp(k);
    if (mode === 'delta') return callDelta(k, iv, e.T);
    return e.F * Math.exp(k) / SPOT;
  }
  function renderSmile(el) {
    const t = tokens(), mode = state.smileX;
    const traces = [], shapes = [];
    const selected = smileOrder.map(i => E[i]);
    selected.forEach(e => {
      const color = t.s[smileSlots.indexOf(e.i)];
      const idx = POINTS_BY_EXPIRY[e.i];
      const name = `${shortDate(e.date)} · ${e.dte}d`;
      if (e.svi) {
        const ks = linspace(e.k_lo - 0.01, e.k_hi + 0.01, 160);
        const ivs = ks.map(k => ivAt(e, k));
        traces.push({
          type: 'scatter', mode: 'lines', name, x: ks.map((k, j) => smileX(mode, e, k, ivs[j])), y: ivs.map(v => v * 100),
          line: { color, width: 2 }, hovertemplate: `${name} SVI %{y:.2f}%<extra></extra>`, legendgroup: name,
        });
      }
      const mid = idx.map(j => P.iv[j]);
      traces.push({
        type: 'scatter', mode: 'markers', name, showlegend: !e.svi, legendgroup: name,
        x: idx.map(j => smileX(mode, e, P.k[j], P.iv[j])), y: mid.map(v => v * 100),
        marker: { size: 5, color: idx.map(j => P.last[j] ? 'rgba(0,0,0,0)' : alpha(color, 0.7)), line: { color, width: 1 } },
        error_y: {
          type: 'data', symmetric: false, thickness: 1, width: 0, color: alpha(color, 0.4),
          array: idx.map(j => ok(P.ask[j]) ? (P.ask[j] - P.iv[j]) * 100 : 0),
          arrayminus: idx.map(j => ok(P.bid[j]) ? (P.iv[j] - P.bid[j]) * 100 : 0),
        },
        customdata: idx.map(j => [P.K[j], P.c[j] ? 'Call' : 'Put', ok(P.bid[j]) ? (P.bid[j] * 100).toFixed(2) + '%' : '—',
          ok(P.ask[j]) ? (P.ask[j] * 100).toFixed(2) + '%' : '—', P.oi[j].toLocaleString(), P.last[j] ? ' · last trade' : '']),
        hovertemplate: `<b>%{customdata[1]} %{customdata[0]}</b> · ${name}<br>Mid %{y:.2f}%%{customdata[5]}<br>Bid %{customdata[2]} · Ask %{customdata[3]}<br>OI %{customdata[4]}<extra></extra>`,
      });
    });
    const first = selected[0];
    if (first) {
      const atmX = mode === 'strike' ? first.F : mode === 'delta' ? 0.5 : first.F / SPOT;
      shapes.push(vline(atmX, t.baseline, 'dot'));
    }
    const xTitle = { moneyness: 'Moneyness K / S', strike: 'Strike', delta: 'Call delta (forward)' }[mode];
    draw(el, traces, layout(t, {
      showlegend: selected.length > 1, shapes,
      xaxis: { title: { text: xTitle }, autorange: mode === 'delta' ? 'reversed' : true, showgrid: false },
      yaxis: { ticksuffix: '%' },
      margin: { l: 8, r: 12, t: selected.length > 1 ? 26 : 6, b: 8 },
    }));
  }
  function renderSliceStats() {
    const e = E[smileOrder[0]];
    if (!e) { $('#slice-stats').innerHTML = ''; return; }
    const items = [
      ['Expiry', longDate(e.date)], ['Forward', `${num(e.F)} <span class="muted">${e.parity ? 'parity' : 'carry'}</span>`],
      ['ATM', pct(e.atm, 2)], ['25Δ RR', volPts(e.rr25, 2)], ['25Δ BF', volPts(e.bf25, 2)],
      ['SVI RMSE', e.rmse != null ? `${num(e.rmse * 100, 2)} pts` : 'no fit'], ['Quotes', e.n],
    ];
    $('#slice-stats').innerHTML = items.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  }
  function smileTable() {
    const e = E[smileOrder[0]];
    return {
      columns: ['Type', 'Strike', 'K/S', 'Bid IV', 'Mid IV', 'Ask IV', 'SVI IV', 'Open int.', 'Volume'],
      rows: POINTS_BY_EXPIRY[e.i].map(j => [P.c[j] ? 'Call' : 'Put', num(P.K[j]), num(P.K[j] / SPOT, 3),
        pct(P.bid[j], 2), pct(P.iv[j], 2) + (P.last[j] ? ' <span class="muted">(last)</span>' : ''), pct(P.ask[j], 2),
        pct(ivAt(e, P.k[j]), 2), P.oi[j].toLocaleString(), P.vol[j].toLocaleString()]),
    };
  }

  // ================================================================ pricer
  const pr = { e: null };
  function setupPricer() {
    const sel = $('#pr-expiry');
    sel.innerHTML = FITTED.map(e => `<option value="${e.i}">${longDate(e.date)} · ${e.dte}d</option>`).join('');
    pr.e = nearestFitted(30);
    sel.value = pr.e.i;
    sel.addEventListener('change', () => { pr.e = E[+sel.value]; configureStrike(true); renderPanel('pricer'); });
    ['#pr-strike', '#pr-ds', '#pr-dv', '#pr-h'].forEach(id => $(id).addEventListener('input', () => renderPanel('pricer')));
    configureStrike(false);
  }
  function configureStrike(keep) {
    const e = pr.e, s = $('#pr-strike'), h = $('#pr-h');
    const step = e.days > 180 ? 5 : 1;
    const lo = Math.ceil(e.F * Math.exp(e.k_lo) / step) * step, hi = Math.floor(e.F * Math.exp(e.k_hi) / step) * step;
    const prev = +s.value;
    s.min = lo; s.max = hi; s.step = step;
    s.value = keep && prev >= lo && prev <= hi ? prev : Math.min(hi, Math.max(lo, Math.round(SPOT / step) * step));
    h.max = Math.max(0, e.dte - 1);
    if (+h.value > +h.max) h.value = h.max;
  }
  function pricerModel() {
    const e = pr.e, isCall = state.pricerType === 'call', K = +$('#pr-strike').value;
    const ds = +$('#pr-ds').value / 100, dv = +$('#pr-dv').value / 100, hDays = +$('#pr-h').value;
    const fs = e.F / SPOT, r = M.rate;
    const fwd = (S, T) => S * fs ** (T / e.T);
    const iv0 = ivAt(e, Math.log(K / e.F));
    const p0 = black(e.F, K, e.T, iv0, isCall, e.D);
    const v = iv0 * Math.sqrt(e.T), d1 = (Math.log(e.F / K) + 0.5 * v * v) / v, d2 = d1 - v;
    const T1d = Math.max(e.T - 1 / 365, 0);
    const T1 = Math.max(e.T - hDays / 365, 0), S1 = SPOT * (1 + ds), iv1 = Math.max(iv0 + dv, 0.01);
    const p1 = black(fwd(S1, T1), K, T1, iv1, isCall, Math.exp(-r * T1));
    return {
      e, isCall, K, iv0, p0, iv1, p1, T1, S1, hDays, fwd,
      delta: e.D * fs * (isCall ? ncdf(d1) : ncdf(d1) - 1),
      gamma: e.D * fs * fs * npdf(d1) / (e.F * v),
      vega: e.D * e.F * npdf(d1) * Math.sqrt(e.T) / 100,
      theta: black(fwd(SPOT, T1d), K, T1d, iv0, isCall, Math.exp(-r * T1d)) - p0,
      pItm: isCall ? ncdf(d2) : ncdf(-d2),
      breakeven: isCall ? K + p0 : K - p0,
    };
  }
  function syncPricer() {
    const m = pricerModel();
    $('#pr-strike-out').textContent = `${num(m.K, m.K % 1 ? 1 : 0)} · ${num(m.K / SPOT, 3)} K/S`;
    $('#pr-ds-out').textContent = `${signed(+$('#pr-ds').value, 1)}% → ${num(m.S1)}`;
    $('#pr-dv-out').textContent = `${signed(+$('#pr-dv').value, 1)} pts`;
    $('#pr-h-out').textContent = m.hDays ? `T+${m.hDays}d` : 'Today';
    const pnl = (m.p1 - m.p0) * 100;
    const cells = [
      ['Model IV', pct(m.iv0, 2)], ['Premium', `${usd(m.p0)} <span class="muted small">${usd(m.p0 * 100, 0)}</span>`],
      ['Delta', num(m.delta, 3)], ['Gamma', num(m.gamma, 4)],
      ['Vega / pt', usd(m.vega, 3)], ['Theta / day', usd(m.theta, 3)],
      ['P(ITM)', pct(m.pItm, 1)], ['Breakeven', num(m.breakeven)],
      ['Scenario IV', pct(m.iv1, 2)], ['Scenario spot', num(m.S1)],
      ['Scenario value', usd(m.p1)], ['Scenario P&L', `<span class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : MINUS}$${num(Math.abs(pnl), 0)}</span>`, true],
    ];
    $('#pricer-out').innerHTML = cells.map(([k, v, hl]) => `<div${hl ? ' class="hl"' : ''}><span>${k}</span><b>${v}</b></div>`).join('');
  }
  function renderPricer(el) {
    const t = tokens(), m = pricerModel(), pnl = (m.p1 - m.p0) * 100;
    const width = Math.min(0.3, Math.max(0.04, 3 * m.iv0 * Math.sqrt(m.e.T)));
    const xs = linspace(SPOT * (1 - width), SPOT * (1 + width), 121);
    const atHorizon = xs.map(S => (black(m.fwd(S, m.T1), m.K, m.T1, m.iv1, m.isCall, Math.exp(-M.rate * m.T1)) - m.p0) * 100);
    const atExpiry = xs.map(S => (Math.max(m.isCall ? S - m.K : m.K - S, 0) - m.p0) * 100);
    draw(el, [
      lineTrace(xs, atExpiry, t.s[1], 'At expiry', { line: { color: t.s[1], width: 2 }, hovertemplate: 'Expiry %{y:$,.0f}<extra></extra>' }),
      lineTrace(xs, atHorizon, t.s[0], m.hDays ? `Scenario at T+${m.hDays}d` : 'Scenario today', { hovertemplate: 'Horizon %{y:$,.0f}<extra></extra>' }),
      { type: 'scatter', mode: 'markers', x: [m.S1], y: [pnl], marker: markers(t, t.s[0], 10), hoverinfo: 'skip', showlegend: false },
    ], layout(t, {
      showlegend: true, hovermode: 'x unified', shapes: [vline(SPOT, t.baseline, 'dot')],
      xaxis: { tickprefix: '', showgrid: false, hoverformat: '.2f' },
      yaxis: { tickprefix: '$', tickformat: ',.0f', zeroline: true, zerolinecolor: t.baseline, title: { text: 'P&L / contract' } },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  function pricerTable() {
    const m = pricerModel();
    const width = Math.min(0.3, Math.max(0.04, 3 * m.iv0 * Math.sqrt(m.e.T)));
    return {
      columns: ['Spot', 'P&L at horizon', 'P&L at expiry'],
      rows: linspace(SPOT * (1 - width), SPOT * (1 + width), 13).map(S => [num(S),
        usd((black(m.fwd(S, m.T1), m.K, m.T1, m.iv1, m.isCall, Math.exp(-M.rate * m.T1)) - m.p0) * 100, 0),
        usd((Math.max(m.isCall ? S - m.K : m.K - S, 0) - m.p0) * 100, 0)]),
    };
  }

  // ================================================================ GEX
  // Dollar gamma per 1% move: Gamma * S^2 * 1% * OI * 100 = OI * S * phi(d1) / (sigma * sqrt(T)).
  // G is null when the snapshot carried no open interest (Yahoo resets it outside US hours).
  const GN = G ? G.K.length : 0;
  const GSQRT = G ? Float64Array.from(G.T, (T, i) => G.iv[i] * Math.sqrt(T)) : new Float64Array(0);
  const NO_OI = 'Open interest is missing from this snapshot. Yahoo resets it outside US market hours, so gamma exposure returns with the next in-session build.';
  function gexContribution(i, S) {
    const v = GSQRT[i], d1 = (Math.log(S * G.fs[i] / G.K[i]) + 0.5 * v * v) / v;
    return (G.c[i] ? 1 : -1) * G.oi[i] * S * npdf(d1) / v;
  }
  function gexKeep(windowKey) {
    const lim = windowKey === 'all' ? Infinity : +windowKey;
    return i => G.dte[i] <= lim;
  }
  function gexAnalysis(windowKey) {
    const keep = gexKeep(windowKey);
    const byStrike = new Map();
    let net = 0;
    for (let i = 0; i < GN; i++) {
      if (!keep(i)) continue;
      const g = gexContribution(i, SPOT);
      net += g;
      const row = byStrike.get(G.K[i]) || { call: 0, put: 0 };
      if (G.c[i]) row.call += g; else row.put += g;
      byStrike.set(G.K[i], row);
    }
    const grid = linspace(SPOT * 0.88, SPOT * 1.12, 97);
    const profile = grid.map(S => { let s = 0; for (let i = 0; i < GN; i++) if (keep(i)) s += gexContribution(i, S); return s; });
    let flip = null, best = Infinity;
    for (let j = 1; j < grid.length; j++) {
      if (Math.sign(profile[j]) !== Math.sign(profile[j - 1])) {
        const x = grid[j - 1] + (grid[j] - grid[j - 1]) * profile[j - 1] / (profile[j - 1] - profile[j]);
        if (Math.abs(x - SPOT) < best) { best = Math.abs(x - SPOT); flip = x; }
      }
    }
    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    let callWall = null, putWall = null;
    strikes.forEach(k => {
      const r = byStrike.get(k);
      if (!callWall || r.call > byStrike.get(callWall).call) callWall = k;
      if (!putWall || r.put < byStrike.get(putWall).put) putWall = k;
    });
    return { net, flip, byStrike, strikes, grid, profile, callWall, putWall };
  }
  const gexCache = {};
  const gexFor = w => gexCache[w] || (gexCache[w] = gexAnalysis(w));

  function renderGex(el) {
    const t = tokens(), g = gexFor(state.gexWindow);
    const lo = SPOT * 0.92, hi = SPOT * 1.08;
    const ks = g.strikes.filter(k => k >= lo && k <= hi);
    const peak = Math.max(...ks.map(k => Math.max(Math.abs(g.byStrike.get(k).call), Math.abs(g.byStrike.get(k).put))), 1);
    const [unit, sfx] = peak >= 1e9 ? [1e9, 'bn'] : [1e6, 'm'];
    const calls = ks.map(k => g.byStrike.get(k).call / unit), puts = ks.map(k => g.byStrike.get(k).put / unit);
    const { shapes, annotations } = spotFlipMarks(t, g, lo, hi);
    draw(el, [
      { type: 'bar', x: ks, y: calls, name: 'Calls (+)', marker: { color: t.pos, cornerradius: 2 }, hovertemplate: `Strike %{x}<br>Calls $%{y:,.2f}${sfx}<extra></extra>` },
      { type: 'bar', x: ks, y: puts, name: 'Puts (−)', marker: { color: t.neg, cornerradius: 2 }, hovertemplate: `Strike %{x}<br>Puts $%{y:,.2f}${sfx}<extra></extra>` },
    ], layout(t, {
      barmode: 'relative', bargap: 0.18, showlegend: true, shapes, annotations,
      xaxis: { title: { text: 'Strike' }, showgrid: false },
      yaxis: { title: { text: `$${sfx} per 1% move` }, zeroline: true, zerolinecolor: t.baseline },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  const syncGex = () => {
    const g = gexFor(state.gexWindow), k = v => num(v, v % 1 ? 1 : 0);
    $('#gex-sub').textContent = `Net ${usdCompact(g.net)} per 1% at spot · call wall ${k(g.callWall)} · put wall ${k(g.putWall)}`;
  };
  // Spot and flip labels sit on opposite sides of their lines so they never overlap.
  function spotFlipMarks(t, g, lo = -Infinity, hi = Infinity) {
    const flipRight = g.flip && g.flip > SPOT;
    const shapes = [vline(SPOT, t.text2)];
    const annotations = [label(t, SPOT, 1, `Spot ${num(SPOT)}`, { yanchor: 'top', xanchor: flipRight ? 'right' : 'left', xshift: flipRight ? -4 : 4 })];
    if (g.flip && g.flip > lo && g.flip < hi) {
      shapes.push(vline(g.flip, t.muted, 'dash'));
      annotations.push(label(t, g.flip, 1, `Flip ${num(g.flip)}`, { yanchor: 'top', xanchor: flipRight ? 'left' : 'right', xshift: flipRight ? 4 : -4 }));
    }
    return { shapes, annotations };
  }
  function gexTable() {
    const g = gexFor(state.gexWindow);
    return {
      columns: ['Strike', 'Calls ($m)', 'Puts ($m)', 'Net ($m)'],
      rows: g.strikes.filter(k => k >= SPOT * 0.9 && k <= SPOT * 1.1).map(k => {
        const r = g.byStrike.get(k);
        return [num(k), num(r.call / 1e6, 1), num(r.put / 1e6, 1), num((r.call + r.put) / 1e6, 1)];
      }),
    };
  }
  function renderGexProfile(el) {
    const t = tokens(), g = gexFor(state.gexWindow);
    const y = g.profile.map(v => v / 1e9);
    const { shapes, annotations } = spotFlipMarks(t, g);
    draw(el, [
      { type: 'scatter', mode: 'lines', x: g.grid, y: y.map(v => Math.max(v, 0)), fill: 'tozeroy', fillcolor: alpha(t.pos, 0.18), line: { width: 0 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: g.grid, y: y.map(v => Math.min(v, 0)), fill: 'tozeroy', fillcolor: alpha(t.neg, 0.18), line: { width: 0 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: g.grid, y, line: { color: t.text2, width: 2 }, hovertemplate: 'Spot %{x:.2f}<br>Net $%{y:,.2f}bn<extra></extra>' },
    ], layout(t, {
      shapes, annotations,
      xaxis: { title: { text: 'Hypothetical spot' }, showgrid: false },
      yaxis: { title: { text: '$bn per 1% move' }, zeroline: true, zerolinecolor: t.baseline },
    }));
  }
  const gexProfileTable = () => {
    const g = gexFor(state.gexWindow);
    return { columns: ['Spot', 'Net GEX ($bn per 1%)'], rows: g.grid.filter((_, j) => j % 4 === 0).map((S, j) => [num(S), num(g.profile[j * 4] / 1e9, 3)]) };
  };

  // ================================================================ realised vs implied
  function rangeStart() {
    const n = H.date.length;
    return state.range === 'all' ? 0 : Math.max(0, n - +state.range);
  }
  function renderPrice(el) {
    const t = tokens(), s0 = rangeStart();
    const dates = H.date.slice(s0), close = H.close.slice(s0);
    const horizonDays = { 126: 45, 252: 90, 504: 150, all: 220 }[state.range];
    const cone = [{ date: H.date[H.date.length - 1], T: 0, iv: 0 }]
      .concat(FITTED.filter(e => e.days <= horizonDays).map(e => ({ date: e.date, T: e.T, iv: e.atm })));
    const band = n => cone.map(c => SPOT * Math.exp(n * c.iv * Math.sqrt(c.T)));
    const cx = cone.map(c => c.date);
    const bandTrace = (n, a) => [
      { type: 'scatter', mode: 'lines', x: cx, y: band(n), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x: cx, y: band(-n), line: { width: 0 }, fill: 'tonexty', fillcolor: alpha(t.s[1], a), hoverinfo: 'skip', name: `±${n}σ implied`, showlegend: true },
    ];
    const last = cone[cone.length - 1];
    const annotations = cone.length > 1 ? [1, -1].map(n => ({
      x: last.date, y: SPOT * Math.exp(n * last.iv * Math.sqrt(last.T)), xref: 'x', yref: 'y',
      text: `${n > 0 ? '+' : MINUS}1σ ${num(SPOT * Math.exp(n * last.iv * Math.sqrt(last.T)))}`, showarrow: false,
      xanchor: 'right', yanchor: n > 0 ? 'bottom' : 'top', font: { size: 10.5, color: t.text2 },
    })) : [];
    draw(el, [
      ...bandTrace(2, 0.08), ...bandTrace(1, 0.16),
      lineTrace(cx, cone.map(() => SPOT), alpha(t.s[1], 0.6), 'Spot carried', { line: { color: t.baseline, width: 1, dash: 'dot' }, hoverinfo: 'skip', showlegend: false }),
      lineTrace(dates, close, t.s[0], `${M.ticker} close`, { line: { color: t.s[0], width: 2 }, hovertemplate: '%{x|%b %d, %Y}<br>%{y:$.2f}<extra></extra>' }),
    ], layout(t, {
      showlegend: true, annotations, shapes: [vline(H.date[H.date.length - 1], t.baseline)],
      xaxis: { type: 'date', showgrid: false },
      yaxis: { tickprefix: '$' },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  const priceTable = () => ({
    columns: ['Expiry', 'DTE', 'ATM IV', '−2σ', '−1σ', '+1σ', '+2σ'],
    rows: FITTED.filter(e => e.days <= 365).map(e => {
      const m = n => num(SPOT * Math.exp(n * e.atm * Math.sqrt(e.T)));
      return [longDate(e.date), e.dte, pct(e.atm), m(-2), m(-1), m(1), m(2)];
    }),
  });

  function renderIvRv(el) {
    const t = tokens(), s0 = rangeStart();
    const dates = H.date.slice(s0), rv = H.rv[state.estimator].slice(s0).map(v => ok(v) ? v * 100 : null);
    const traces = [];
    if (H.vix) traces.push(lineTrace(dates, H.vix.slice(s0).map(v => ok(v) ? v * 100 : null), t.s[0], `${VIX_NAME} (30d implied)`, { line: { color: t.s[0], width: 2 }, hovertemplate: `${VIX_NAME} %{y:.1f}%<extra></extra>` }));
    traces.push(lineTrace(dates, rv, t.s[1], `21d realised · ${EST_NAME[state.estimator]}`, { line: { color: t.s[1], width: 2 }, hovertemplate: 'RV %{y:.1f}%<extra></extra>' }));
    draw(el, traces, layout(t, {
      showlegend: true, hovermode: 'x unified',
      xaxis: { type: 'date', showgrid: false, hoverformat: '%b %d, %Y' }, yaxis: { ticksuffix: '%' },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  function syncIvRv() {
    $('#ivrv-title').textContent = H.vix ? `${VIX_NAME} vs 21d realised` : '21d realised volatility';
    $('#ivrv-sub').textContent = `Annualised · realised via ${EST_NAME[state.estimator]}`;
  }
  function ivRvTable() {
    const s0 = rangeStart();
    const rows = [];
    for (let i = H.date.length - 1; i >= s0; i -= 5) rows.push([longDate(H.date[i]), H.vix ? pct(H.vix[i]) : '—', pct(H.rv[state.estimator][i]), H.vix ? volPts(H.vix[i] - H.rv[state.estimator][i]) : '—']);
    return { columns: ['Date', VIX_NAME || 'Implied', `RV21 ${EST_NAME[state.estimator]}`, 'Spread (pts)'], rows };
  }

  function vrpSeries() {
    const s0 = rangeStart(), dates = H.date.slice(s0);
    const vrp = dates.map((_, j) => {
      const i = s0 + j, a = H.vix[i], b = H.rv[state.estimator][i];
      return ok(a) && ok(b) ? (a - b) * 100 : null;
    });
    const valid = vrp.filter(ok);
    return { dates, vrp, mean: valid.reduce((s, v) => s + v, 0) / Math.max(valid.length, 1) };
  }
  const syncVrp = () => {
    $('#vrp-sub').textContent = `${VIX_NAME} minus 21d ${EST_NAME[state.estimator]} realised, vol pts · range average ${signed(vrpSeries().mean, 1)}`;
  };
  function renderVrp(el) {
    const t = tokens(), { dates, vrp, mean } = vrpSeries();
    draw(el, [
      { type: 'scatter', mode: 'lines', x: dates, y: vrp.map(v => v == null ? null : Math.max(v, 0)), fill: 'tozeroy', fillcolor: alpha(t.pos, 0.3), line: { width: 0 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: dates, y: vrp.map(v => v == null ? null : Math.min(v, 0)), fill: 'tozeroy', fillcolor: alpha(t.neg, 0.35), line: { width: 0 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: dates, y: vrp, line: { color: t.text2, width: 1.2 }, hovertemplate: '%{x|%b %d, %Y}<br>VRP %{y:+.1f} pts<extra></extra>' },
    ], layout(t, {
      hovermode: 'x', shapes: [hline(mean, t.muted, 'dot')],
      annotations: [{ x: 1, xref: 'paper', y: mean, yref: 'y', text: `avg ${signed(mean, 1)}`, showarrow: false, xanchor: 'right', yanchor: 'bottom', font: { size: 10.5, color: t.text2 } }],
      xaxis: { type: 'date', showgrid: false }, yaxis: { zeroline: true, zerolinecolor: t.baseline },
    }));
  }

  function renderCone(el) {
    const t = tokens(), C = D.cone;
    const x = C.h.map(h => `${h}d`);
    const pc = arr => arr.map(v => v * 100);
    const band = (lo, hi, a, name) => [
      { type: 'scatter', mode: 'lines', x, y: pc(C[hi]), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x, y: pc(C[lo]), line: { width: 0 }, fill: 'tonexty', fillcolor: alpha(t.muted, a), name, hoverinfo: 'skip', showlegend: false },
    ];
    const implied = C.h.map(h => atmAt(h * 365 / 252) * 100);
    draw(el, [
      ...band('min', 'max', 0.1, 'Min–max'), ...band('p10', 'p90', 0.16, '10–90th'), ...band('p25', 'p75', 0.24, '25–75th'),
      lineTrace(x, pc(C.p50), t.muted, 'Median realised', { line: { color: t.text2, width: 1.5, dash: 'dot' }, hovertemplate: 'Median %{y:.1f}%<extra></extra>' }),
      lineTrace(x, pc(C.current), t.s[1], 'Realised now', { mode: 'lines+markers', marker: markers(t, t.s[1], 7), hovertemplate: 'Realised now %{y:.1f}%<extra></extra>' }),
      lineTrace(x, implied, t.s[0], 'Implied ATM', { mode: 'lines+markers', marker: markers(t, t.s[0], 7), hovertemplate: 'Implied %{y:.1f}%<extra></extra>' }),
    ], layout(t, {
      showlegend: true, hovermode: 'x unified',
      xaxis: { type: 'category', title: { text: 'Window (trading days)' }, showgrid: false },
      yaxis: { ticksuffix: '%' },
      margin: { l: 8, r: 12, t: 26, b: 8 },
    }));
  }
  const coneTable = () => {
    const C = D.cone;
    return {
      columns: ['Window', 'Min', '10th', '25th', 'Median', '75th', '90th', 'Max', 'Now', 'Implied'],
      rows: C.h.map((h, j) => [`${h}d`, ...['min', 'p10', 'p25', 'p50', 'p75', 'p90', 'max', 'current'].map(q => pct(C[q][j])), pct(atmAt(h * 365 / 252))]),
    };
  };

  // ================================================================ SVI diagnostics
  function renderSvi() {
    const bad = FITTED.filter(e => e.min_g < -1e-6).length, cal = D.calendar.length;
    const okIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    const warnIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1L8 1.5z"/><path d="M8 6v3.5M8 11.5v.5"/></svg>';
    const chip = (good, text) => `<span class="status ${good ? 'good' : 'warn'}">${good ? okIcon : warnIcon}${text}</span>`;
    $('#arb-chips').innerHTML = chip(!bad, bad ? `Butterfly: ${bad} slice${bad > 1 ? 's' : ''}` : 'Butterfly: clean') +
      chip(!cal, cal ? `Calendar: ${cal} crossing${cal > 1 ? 's' : ''}` : 'Calendar: clean');
    const cols = ['Expiry', 'DTE', 'Forward', 'Quotes', 'ATM', '25Δ put', '25Δ call', 'RR', 'BF', 'a', 'b', 'ρ', 'm', 'σ', 'RMSE (pts)', 'min g(k)'];
    const rows = E.map(e => {
      const s = e.svi;
      return [longDate(e.date), e.dte, `${num(e.F)} <span class="muted">${e.parity ? 'parity' : 'carry'}</span>`, e.n,
        pct(e.atm, 2), pct(e.iv25p, 2), pct(e.iv25c, 2), volPts(e.rr25, 2), volPts(e.bf25, 2),
        ...(s ? [num(s.a, 5), num(s.b, 4), num(s.rho, 3), num(s.m, 4), num(s.sigma, 4), num(e.rmse * 100, 2),
          `<span class="${e.min_g < -1e-6 ? 'bad' : 'ok'}">${num(e.min_g, 3)}</span>`]
          : Array(7).fill('<span class="muted">—</span>'))];
    });
    $('#svi-table').innerHTML = tableHTML({ columns: cols, rows });
  }

  // ================================================================ controls
  function syncSeg(key) {
    $$(`.seg[data-control="${key}"] button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === state[key])));
  }
  const DEPENDENTS = {
    surfaceView: ['surface'], smileX: ['smile'], pricerType: ['pricer'], gexWindow: ['gex', 'gexprofile'],
    range: ['price', 'ivrv', 'vrp'], estimator: ['ivrv', 'vrp'], showQuotes: ['surface'],
  };
  function setToggle(key, on) {
    state[key] = on;
    $$(`[data-toggle="${key}"]`).forEach(b => b.setAttribute('aria-pressed', String(on)));
    if (key === 'orbit') { if (on && state.surfaceView === '3d' && HAS_PLOTLY) startOrbit(panels.surface.chart); else stopOrbit(); }
    else (DEPENDENTS[key] || []).forEach(renderPanel);
  }
  function bindControls() {
    $$('.seg[data-control]').forEach(seg => {
      const key = seg.dataset.control;
      syncSeg(key);
      seg.addEventListener('click', ev => {
        const b = ev.target.closest('button');
        if (!b || state[key] === b.dataset.value) return;
        state[key] = b.dataset.value;
        syncSeg(key);
        if (key === 'surfaceView') $('[data-toggle="orbit"]').disabled = state.surfaceView !== '3d';
        (DEPENDENTS[key] || []).forEach(renderPanel);
      });
    });
    $$('[data-toggle]').forEach(b => b.addEventListener('click', () => setToggle(b.dataset.toggle, !state[b.dataset.toggle])));
    $$('.table-toggle').forEach(btn => btn.addEventListener('click', () => {
      const name = btn.closest('[data-panel]').dataset.panel;
      state.tables[name] = !state.tables[name];
      btn.setAttribute('aria-pressed', String(state.tables[name]));
      btn.setAttribute('aria-label', state.tables[name] ? 'Show as chart' : 'Show as table');
      if (name === 'surface' && state.tables[name]) stopOrbit();
      renderPanel(name);
    }));
    $('#expiry-chips').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-i]');
      if (b && !b.disabled) toggleSmile(+b.dataset.i);
    });
    $('#theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('voldesk-theme', next); } catch (e) { /* storage unavailable */ }
      renderChips();
      renderAll();
    });
  }

  // ================================================================ boot
  function init() {
    if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = 'dark';
    const gexAll = gexFor('all');
    renderTopbar();
    renderKpis(gexAll);
    renderNotes(gexAll);
    renderSvi();

    const first = nearestFitted(30);
    smileSlots[0] = first.i;
    smileOrder.push(first.i);
    renderChips();
    setupPricer();

    panel('surface', 'chart-surface', renderSurface, surfaceTable);
    panel('term', 'chart-term', renderTerm, termTable);
    panel('skew', 'chart-skew', renderSkew, skewTable);
    panel('smile', 'chart-smile', renderSmile, smileTable, renderSliceStats);
    panel('pricer', 'chart-pricer', renderPricer, pricerTable, syncPricer);
    if (G) {
      panel('gex', 'chart-gex', renderGex, gexTable, syncGex);
      panel('gexprofile', 'chart-gexprofile', renderGexProfile, gexProfileTable);
    } else {
      ['gex', 'gexprofile'].forEach(n => {
        const root = $(`[data-panel="${n}"]`);
        $('.table-toggle', root).hidden = true;
        $('.chart', root).innerHTML = `<p class="empty-note">${NO_OI}</p>`;
      });
      $('#gex-sub').textContent = '$ gamma per 1% move · unavailable for this snapshot';
      $('[data-control="gexWindow"]').closest('.filters').hidden = true;
    }
    panel('price', 'chart-price', renderPrice, priceTable);
    panel('ivrv', 'chart-ivrv', renderIvRv, ivRvTable, syncIvRv);
    panel('vrp', 'chart-vrp', renderVrp, ivRvTable, syncVrp);
    panel('cone', 'chart-cone', renderCone, coneTable);
    if (!H.vix) panels.vrp.root.hidden = true;

    bindControls();
    renderAll();
    if (HAS_PLOTLY && 'ResizeObserver' in window) {
      const pending = new Set();
      const ro = new ResizeObserver(entries => {
        entries.forEach(en => pending.add(en.target));
        requestAnimationFrame(() => {
          pending.forEach(el => { if (el._fullLayout && !el.hidden) Plotly.Plots.resize(el); });
          pending.clear();
        });
      });
      Object.values(panels).forEach(p => ro.observe(p.chart));
    }
    // Scroll the chip row (not the page) so the default expiry is visible.
    const chips = $('#expiry-chips'), chip = $(`#expiry-chips button[data-i="${first.i}"]`);
    if (chip) chips.scrollLeft = chip.offsetLeft - chips.offsetLeft - chips.clientWidth / 2 + chip.clientWidth / 2;
  }
  init();
})();
