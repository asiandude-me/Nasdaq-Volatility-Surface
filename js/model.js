/*
 * NQ Options Explorer - pricing and volatility model.
 *
 * Pure maths, no DOM. Works two ways:
 *   - browser: <script src="js/model.js"></script>  -> window.NQModel
 *   - Node:    const M = require('./js/model.js');
 *
 * The finance in one paragraph:
 *   An option gives the right to buy (call) or sell (put) an asset at a fixed strike K.
 *   The contracts here are options on E-mini Nasdaq-100 FUTURES, so we use Black-76
 *   (the futures version of Black-Scholes). The futures price F already is the market's
 *   forward price, so the only discounting needed is e^(-rT). The one input we cannot
 *   observe in this simulation is volatility, so we build a volatility SURFACE that
 *   gives an implied vol for every strike and expiry. We use SSVI (Gatheral & Jacquier,
 *   2014), a parametrisation designed so that the surface cannot offer free money
 *   (no butterfly or calendar arbitrage).
 *
 * Conventions: dates are UTC-midnight Date objects. T (years) = dte / 365.
 * Vol shifts (volShift) are decimals: 0.05 means +5 vol points.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NQModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    F0: 25000,              // starting NQ futures price (the forward)
    r: 0.04,                // risk-free rate, annual, continuously compounded
    multiplier: 20,         // NQ contract value: $20 per index point
    strikeStep: 250,        // listed strikes are spaced 250 points apart
    strikeLo: 0.6,          // lowest listed strike, as a fraction of F0
    strikeHi: 1.4,          // highest listed strike, as a fraction of F0
    displayBand: [0.7, 1.3],// strikes shown on the chart, as fractions of F
    ssvi: { sigma0: 0.18, sigmaInf: 0.22, tau: 0.5, rho: -0.7, eta: 1.1, gamma: 0.4 }
  };

  const MS_PER_DAY = 86400000;
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------------------
  // 2. Date helpers (always UTC, so the local time zone never shifts a date)
  // ---------------------------------------------------------------------------

  // 'YYYY-MM-DD' -> Date at UTC midnight.
  function parseISODate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) throw new Error('Expected YYYY-MM-DD, got: ' + iso);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  // Date -> 'YYYY-MM-DD'.
  function toISODate(d) {
    const y = String(d.getUTCFullYear()).padStart(4, '0');
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addDays(d, n) {
    return new Date(d.getTime() + n * MS_PER_DAY);
  }

  // Whole calendar days from a to b (b minus a).
  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
  }

  // ---------------------------------------------------------------------------
  // 3. Normal distribution
  // ---------------------------------------------------------------------------

  // erf(z) for 0 <= z < 3, from a series whose terms are all positive (so no
  // cancellation): erf(z) = (2/sqrt(pi)) e^(-z^2) * sum_n z^(2n+1) 2^n / (1*3*...*(2n+1)).
  function erfSeries(z) {
    let term = z;
    let sum = z;
    for (let n = 1; n < 200; n++) {
      term *= 2 * z * z / (2 * n + 1);
      sum += term;
      if (term < 1e-17 * sum) break;
    }
    return 2 / Math.sqrt(Math.PI) * Math.exp(-z * z) * sum;
  }

  // erfc(z) for z >= 3, from a continued fraction (converges fast in the tail):
  // erfc(z) = e^(-z^2) / sqrt(pi) / (z + (1/2)/(z + 1/(z + (3/2)/(z + ...)))).
  function erfcTail(z) {
    let f = z;
    for (let n = 60; n >= 1; n--) f = z + (n / 2) / f;
    return Math.exp(-z * z) / (Math.sqrt(Math.PI) * f);
  }

  // Complementary error function, accurate to about 1e-15 in double precision.
  // Why not the textbook 1.2e-7 approximation? Finite differences of option prices
  // (gamma especially) amplify that error, so it is too coarse for the Greeks.
  // erfc(-x) = 2 - erfc(x), so N(x) + N(-x) = 1 holds exactly (put-call parity).
  function erfc(x) {
    if (x < 0) return 2 - erfc(-x);
    return x < 3 ? 1 - erfSeries(x) : erfcTail(x);
  }

  // Standard normal CDF, N(x) = P(Z <= x).
  function normCdf(x) {
    return 0.5 * erfc(-x / Math.SQRT2);
  }

  // Standard normal density, n(x) = exp(-x^2 / 2) / sqrt(2 pi). Used for the Greeks.
  function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  // ---------------------------------------------------------------------------
  // 4. Black-76 option pricing and Greeks
  // ---------------------------------------------------------------------------

  // F = futures price, K = strike, T = years to expiry, r = rate,
  // sigma = volatility (decimal), type = 'call' or 'put'.
  // Returns { price, delta, gamma, vega, theta } where
  //   vega  = change per 1 vol point (1% absolute change in sigma),
  //   theta = change per calendar day (time passing, so the value usually falls).
  function black76(F, K, T, r, sigma, type) {
    if (type !== 'call' && type !== 'put') throw new Error("type must be 'call' or 'put'");
    const isCall = type === 'call';
    const intrinsic = isCall ? Math.max(F - K, 0) : Math.max(K - F, 0);

    // At expiry (or with no volatility) there is no time value left: the price is
    // just the intrinsic value and the Greeks are degenerate.
    if (!(T > 0) || !(sigma > 0)) {
      return {
        price: intrinsic,
        delta: isCall ? (F > K ? 1 : 0) : (F < K ? -1 : 0),
        gamma: 0,
        vega: 0,
        theta: 0
      };
    }

    const sqrtT = Math.sqrt(T);
    const volT = sigma * sqrtT;                              // total "spread" of outcomes
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / volT;
    const d2 = d1 - volT;
    const D = Math.exp(-r * T);                              // discount factor
    const pdf1 = normPdf(d1);

    // Black-76: value = discounted expected payoff under the futures measure.
    let price, delta;
    if (isCall) {
      price = D * (F * normCdf(d1) - K * normCdf(d2));
      delta = D * normCdf(d1);
    } else {
      price = D * (K * normCdf(-d2) - F * normCdf(-d1));
      delta = -D * normCdf(-d1);
    }

    const gamma = D * pdf1 / (F * volT);                     // how fast delta changes
    const vega = D * F * pdf1 * sqrtT / 100;                 // per 1 vol point
    // Theta = r*price (the carry earned on the premium) minus the cost of the
    // option's curvature. Divide by 365 for one calendar day.
    const theta = (r * price - D * F * pdf1 * sigma / (2 * sqrtT)) / 365;

    return { price, delta, gamma, vega, theta };
  }

  // ---------------------------------------------------------------------------
  // 5. SSVI volatility surface
  // ---------------------------------------------------------------------------

  // ATM volatility for maturity T. Starts near sigma0 for short dates and drifts
  // towards sigmaInf for long dates (a term structure).
  function atmVol(T, volShift = 0) {
    const p = CONFIG.ssvi;
    return Math.max(0.01, p.sigmaInf + (p.sigma0 - p.sigmaInf) * Math.exp(-T / p.tau) + volShift);
  }

  // theta(T) = total ATM variance = sigma_ATM^2 * T. This is what gets "used up" as time passes.
  function atmVariance(T, volShift = 0) {
    const v = atmVol(T, volShift);
    return v * v * T;
  }

  // phi(theta) controls how quickly the smile (skew and curvature) reacts to log-moneyness.
  function phi(theta) {
    const p = CONFIG.ssvi;
    return p.eta / (Math.pow(theta, p.gamma) * Math.pow(1 + theta, 1 - p.gamma));
  }

  // Total implied variance w(k, T) = sigma_implied^2 * T, where k = ln(K/F) is log-moneyness.
  // Working in total variance (rather than vol) is what makes the no-arbitrage
  // checks simple.
  function totalVariance(k, T, volShift = 0) {
    if (!(T > 0)) return 0;
    const rho = CONFIG.ssvi.rho;
    const theta = atmVariance(T, volShift);
    const ph = phi(theta);
    return 0.5 * theta * (1 + rho * ph * k + Math.sqrt((ph * k + rho) * (ph * k + rho) + 1 - rho * rho));
  }

  // Black-76 needs a volatility per strike, so convert total variance back: sigma = sqrt(w / T).
  function impliedVol(K, F, T, volShift = 0) {
    if (!(T > 0)) return NaN;
    const k = Math.log(K / F);
    return Math.sqrt(totalVariance(k, T, volShift) / T);
  }

  // ---------------------------------------------------------------------------
  // 6. Expiry calendar (CME-style NQ options; exchange holidays ignored)
  // ---------------------------------------------------------------------------

  // CME quarterly month codes, keyed by 0-based month: Mar H, Jun M, Sep U, Dec Z.
  const QUARTER_CODE = { 2: 'H', 5: 'M', 8: 'U', 11: 'Z' };
  // When two rules pick the same date, the more important kind wins.
  const KIND_PRIORITY = { weekly: 1, monthly: 2, quarterly: 3 };

  // Third Friday of a month (0-based month). Monthly NQ options expire on these.
  function thirdFriday(year, month) {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (5 - first.getUTCDay() + 7) % 7;          // getUTCDay: 0 = Sun ... 5 = Fri
    return new Date(Date.UTC(year, month, 1 + offset + 14));
  }

  // Listed expiries strictly after startDate. Each has:
  //   { date, iso, kind, label, code, dteAtStart }
  // where dteAtStart = days from startDate to expiry.
  function buildExpiries(startDate) {
    const start = startDate;
    const candidates = new Map(); // iso -> { date, kind }

    // Keep the candidate with the highest-priority kind for each date.
    function add(date, kind) {
      const iso = toISODate(date);
      const current = candidates.get(iso);
      if (!current || KIND_PRIORITY[kind] > KIND_PRIORITY[current.kind]) {
        candidates.set(iso, { date, kind });
      }
    }

    // Weeklies: the next four Fridays.
    const toFriday = ((5 - start.getUTCDay() + 7) % 7) || 7;
    const firstFriday = addDays(start, toFriday);
    for (let i = 0; i < 4; i++) add(addDays(firstFriday, 7 * i), 'weekly');

    // Monthlies: 3rd Friday of each month, from startDate's month, first six after startDate.
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    let monthlyCount = 0;
    while (monthlyCount < 6) {
      const d = thirdFriday(year, month);
      if (daysBetween(start, d) > 0) {
        add(d, 'monthly');
        monthlyCount++;
      }
      month++;
      if (month > 11) { month = 0; year++; }
    }

    // Quarterlies (Mar/Jun/Sep/Dec 3rd Fridays) out to about 15 months.
    for (let y = start.getUTCFullYear(); y <= start.getUTCFullYear() + 2; y++) {
      for (const m of [2, 5, 8, 11]) {
        const d = thirdFriday(y, m);
        const dte = daysBetween(start, d);
        if (dte > 0 && dte <= 460) add(d, 'quarterly');
      }
    }

    const expiries = [];
    for (const { date, kind } of candidates.values()) {
      const m = date.getUTCMonth();
      const y = date.getUTCFullYear();
      const monthYear = MONTH_ABBR[m] + ' ' + y;
      let code = null;
      let label;
      if (kind === 'quarterly') {
        code = 'NQ' + QUARTER_CODE[m] + (y % 10);            // e.g. NQZ6
        label = code + ' · ' + monthYear;               // "NQZ6 · Dec 2026"
      } else if (kind === 'monthly') {
        label = 'Monthly · ' + monthYear;               // "Monthly · Nov 2026"
      } else {
        label = 'Weekly · ' + date.getUTCDate() + ' ' + monthYear; // "Weekly · 23 Oct 2026"
      }
      expiries.push({
        date,
        iso: toISODate(date),
        kind,
        label,
        code,
        dteAtStart: daysBetween(start, date)
      });
    }

    expiries.sort((a, b) => a.date.getTime() - b.date.getTime());
    return expiries;
  }

  // Listed strikes: multiples of strikeStep from strikeLo*F0 up to strikeHi*F0.
  function buildStrikes(F0) {
    const c = CONFIG;
    // The small epsilons stop floating-point noise (e.g. 139.99999999) from dropping an endpoint.
    const lo = Math.ceil(c.strikeLo * F0 / c.strikeStep - 1e-9);
    const hi = Math.floor(c.strikeHi * F0 / c.strikeStep + 1e-9);
    const strikes = [];
    for (let i = lo; i <= hi; i++) strikes.push(i * c.strikeStep);
    return strikes;
  }

  // Expiries still trading on a given day. Expiry is when dte reaches zero.
  function liveExpiries(expiries, day) {
    return expiries.filter(e => e.dteAtStart - day > 0);
  }

  // ---------------------------------------------------------------------------
  // 7. Contract state and grids for the charts
  // ---------------------------------------------------------------------------

  // Everything about one option (one expiry, one strike, one type) on a given day.
  function contractState({ expiry, K, type, day, F, volShift = 0 }) {
    const dte = expiry.dteAtStart - day;
    const T = dte / 365;
    const expired = dte <= 0;
    const iv = expired ? null : impliedVol(K, F, T, volShift);
    // With no vol (expired) black76 returns intrinsic value and zero Greeks.
    const g = black76(F, K, T, CONFIG.r, iv || 0, type);
    const intrinsic = type === 'call' ? Math.max(F - K, 0) : Math.max(K - F, 0);
    return {
      expired,
      T,
      dte,
      iv,
      price: g.price,
      delta: g.delta,
      gamma: g.gamma,
      vega: g.vega,
      theta: g.theta,
      intrinsic,
      moneyness: K / F
    };
  }

  // Strikes inside the chart's display band (e.g. 70% to 130% of F).
  function displayStrikes(strikes, F) {
    const [loFrac, hiFrac] = CONFIG.displayBand;
    const eps = 1e-9 * F;
    return strikes.filter(K => K >= loFrac * F - eps && K <= hiFrac * F + eps);
  }

  // Grid for one metric. z[i][j] is expiry i (live ones only) at strike j.
  function surfaceGrid({ metric, type, expiries, strikes, day = 0, F, volShift = 0 }) {
    const live = liveExpiries(expiries, day);
    const x = displayStrikes(strikes, F);
    const y = live.map(e => e.dteAtStart - day);
    const z = live.map(expiry =>
      x.map(K => contractState({ expiry, K, type, day, F, volShift })[metric]));
    return { x, y, z, expiries: live };
  }

  // A fixed [min, max] for the 3D z-axis across the whole time slider, so the axis
  // does not rescale while the animation runs. Sampled every 7 days and at maxDay.
  function zRange({ metric, type, expiries, strikes, F, volShift = 0, maxDay }) {
    const days = [];
    for (let d = 0; d < maxDay; d += 7) days.push(d);
    days.push(maxDay);

    let lo = Infinity;
    let hi = -Infinity;
    for (const day of days) {
      const { z } = surfaceGrid({ metric, type, expiries, strikes, day, F, volShift });
      for (const row of z) {
        for (const v of row) {
          if (Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }

    if (metric === 'delta') return type === 'call' ? [0, 1] : [-1, 0];
    // Theta is normally negative, but deep in-the-money options earn carry (r > 0)
    // and can have positive theta, so the range is widened to include that case.
    if (metric === 'theta') return [Math.min(0, lo * 1.05), Math.max(0, hi * 1.05)];
    // iv, price, gamma and vega are never negative.
    return [0, hi * 1.05];
  }

  // ---------------------------------------------------------------------------
  // 8. Display metadata
  // ---------------------------------------------------------------------------
  const METRICS = {
    iv:    { label: 'Implied volatility', unit: '%',         format: v => (v * 100).toFixed(1) + '%' },
    price: { label: 'Premium',            unit: 'pts',       format: v => v.toFixed(1) },
    delta: { label: 'Delta',              unit: '',          format: v => v.toFixed(3) },
    gamma: { label: 'Gamma',              unit: 'per pt',    format: v => v.toFixed(6) },
    theta: { label: 'Theta',              unit: 'pts/day',   format: v => v.toFixed(2) },
    vega:  { label: 'Vega',               unit: 'pts / vol pt', format: v => v.toFixed(2) }
  };

  return {
    CONFIG,
    parseISODate,
    toISODate,
    addDays,
    daysBetween,
    normCdf,
    normPdf,
    black76,
    atmVol,
    totalVariance,
    impliedVol,
    buildExpiries,
    buildStrikes,
    liveExpiries,
    contractState,
    surfaceGrid,
    zRange,
    METRICS
  };
});
