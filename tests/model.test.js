'use strict';

// Run with: npm test   (uses only the built-in node:test runner)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

const { CONFIG, black76, atmVol, totalVariance, impliedVol, buildExpiries, buildStrikes,
        liveExpiries, contractState, surfaceGrid, zRange, METRICS, parseISODate } = M;

const START = parseISODate('2026-10-09');
const F0 = CONFIG.F0;
const R = CONFIG.r;
const EPS = 1e-9;

// |actual - expected| <= max(absFloor, relTol * |expected|)
function assertClose(actual, expected, relTol, absFloor, message) {
  const tol = Math.max(absFloor, relTol * Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol,
    `${message}: actual ${actual}, expected ${expected}, tolerance ${tol}`);
}

// ---------------------------------------------------------------------------
// 1. Put-call parity
// ---------------------------------------------------------------------------
test('Black-76 put-call parity: C - P = e^(-rT) (F - K)', () => {
  for (const F of [15000, 25000, 33000]) {
    for (const K of [17500, 25000, 30000]) {
      for (const T of [7 / 365, 0.25, 2]) {
        for (const sigma of [0.12, 0.25, 0.6]) {
          const c = black76(F, K, T, R, sigma, 'call').price;
          const p = black76(F, K, T, R, sigma, 'put').price;
          const expected = Math.exp(-R * T) * (F - K);
          assert.ok(Math.abs((c - p) - expected) < 1e-6,
            `parity failed F=${F} K=${K} T=${T} sigma=${sigma}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Greeks against central finite differences
// ---------------------------------------------------------------------------
test('Greeks match central finite differences', () => {
  const cases = [
    { F: 25000, K: 25000, T: 30 / 365, sigma: 0.185 },
    { F: 25000, K: 24000, T: 0.25, sigma: 0.22 },
    { F: 25000, K: 27000, T: 0.5, sigma: 0.20 },
    { F: 25000, K: 21000, T: 1.2, sigma: 0.25 }
  ];
  for (const c of cases) {
    for (const type of ['call', 'put']) {
      const hF = c.F * 1e-4;
      const hS = 1e-4;
      const hT = 1e-5;
      const price = (F, sigma, T) => black76(F, c.K, T, R, sigma, type).price;
      const g = black76(c.F, c.K, c.T, R, c.sigma, type);
      const tag = `${type} K=${c.K} T=${c.T} sigma=${c.sigma}`;

      // delta = dV/dF
      const fdDelta = (price(c.F + hF, c.sigma, c.T) - price(c.F - hF, c.sigma, c.T)) / (2 * hF);
      assertClose(g.delta, fdDelta, 1e-3, 1e-7, `delta ${tag}`);

      // gamma = d2V/dF2
      const fdGamma = (price(c.F + hF, c.sigma, c.T) - 2 * price(c.F, c.sigma, c.T)
        + price(c.F - hF, c.sigma, c.T)) / (hF * hF);
      assertClose(g.gamma, fdGamma, 1e-3, 1e-10, `gamma ${tag}`);

      // vega = (dV/dsigma) / 100, per vol point
      const fdVega = (price(c.F, c.sigma + hS, c.T) - price(c.F, c.sigma - hS, c.T)) / (2 * hS) / 100;
      assertClose(g.vega, fdVega, 1e-3, 1e-6, `vega ${tag}`);

      // theta = -(dV/dT) / 365, per calendar day (T is time to expiry)
      const fdTheta = -(price(c.F, c.sigma, c.T + hT) - price(c.F, c.sigma, c.T - hT)) / (2 * hT) / 365;
      assertClose(g.theta, fdTheta, 1e-3, 1e-6, `theta ${tag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Expiry handling
// ---------------------------------------------------------------------------
test('black76 at T <= 0 returns intrinsic value and zero Greeks', () => {
  for (const T of [0, -0.01]) {
    const call = black76(25000, 24000, T, R, 0.2, 'call');
    assert.equal(call.price, 1000);
    assert.equal(call.delta, 1);
    assert.equal(call.gamma, 0);
    assert.equal(call.vega, 0);
    assert.equal(call.theta, 0);

    const put = black76(25000, 26000, T, R, 0.2, 'put');
    assert.equal(put.price, 1000);
    assert.equal(put.delta, -1);

    const otm = black76(25000, 26000, T, R, 0.2, 'call');
    assert.equal(otm.price, 0);
    assert.equal(otm.delta, 0);
  }
});

test('contractState on or after expiry is expired and priced at intrinsic', () => {
  const expiry = buildExpiries(START)[0]; // 2026-10-16, dteAtStart 7
  for (const day of [expiry.dteAtStart, expiry.dteAtStart + 5]) {
    for (const K of [24000, 25000, 26000]) {
      for (const type of ['call', 'put']) {
        const s = contractState({ expiry, K, type, day, F: 25000 });
        assert.equal(s.expired, true);
        assert.equal(s.iv, null);
        assert.equal(s.price, s.intrinsic, `${type} K=${K} day=${day}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. SSVI smile
// ---------------------------------------------------------------------------
test('SSVI: implied vol at K = F equals atmVol(T)', () => {
  for (const T of [1 / 365, 7 / 365, 30 / 365, 0.25, 1, 2]) {
    assert.ok(Math.abs(impliedVol(F0, F0, T) - atmVol(T)) < 1e-12, `T=${T}`);
  }
});

test('SSVI: sanity values for a one-month option (within 1.5 vol points)', () => {
  const T = 30 / 365;
  const cases = [
    { ratio: 1.0, expectedPct: 18.5 },
    { ratio: 0.9, expectedPct: 25 },
    { ratio: 1.05, expectedPct: 15 }
  ];
  for (const c of cases) {
    const iv = impliedVol(c.ratio * F0, F0, T) * 100;
    assert.ok(Math.abs(iv - c.expectedPct) <= 1.5,
      `K/F=${c.ratio}: got ${iv.toFixed(2)}%, expected about ${c.expectedPct}%`);
  }
  assert.ok(Number.isNaN(impliedVol(F0, F0, 0)));
});

// ---------------------------------------------------------------------------
// 5. No butterfly arbitrage
// ---------------------------------------------------------------------------
test('no butterfly arbitrage: call prices fall and are convex in strike', () => {
  const expiries = buildExpiries(START);
  const maturities = expiries.map(e => e.dteAtStart / 365).concat([1 / 365, 7 / 365]);
  // Strikes 0.5F to 1.5F in steps of 25 points, built from integers to avoid float drift.
  const strikes = [];
  for (let i = 0; i <= 1000; i++) strikes.push(0.5 * F0 + 25 * i);

  for (const T of maturities) {
    const C = strikes.map(K => black76(F0, K, T, R, impliedVol(K, F0, T), 'call').price);
    for (let i = 1; i < C.length; i++) {
      assert.ok(C[i] - C[i - 1] <= EPS, `not decreasing at K=${strikes[i]}, T=${T}`);
    }
    for (let i = 1; i < C.length - 1; i++) {
      const secondDiff = C[i + 1] - 2 * C[i] + C[i - 1];
      assert.ok(secondDiff >= -EPS, `not convex at K=${strikes[i]}, T=${T}: ${secondDiff}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 6. No calendar arbitrage
// ---------------------------------------------------------------------------
test('no calendar arbitrage: total variance non-decreasing in T', () => {
  for (let i = -10; i <= 10; i++) {
    const k = i * 0.05;
    let prev = -Infinity;
    for (let d = 1; d <= 730; d++) { // daily grid from 1/365 to 2 years
      const w = totalVariance(k, d / 365);
      assert.ok(w >= prev - 1e-12, `decreasing at k=${k}, d=${d}`);
      prev = w;
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Expiry calendar
// ---------------------------------------------------------------------------
test('buildExpiries from 2026-10-09 gives the 12 expected NQ expiries', () => {
  const exps = buildExpiries(START);
  const expected = [
    ['2026-10-16', 'monthly', null],
    ['2026-10-23', 'weekly', null],
    ['2026-10-30', 'weekly', null],
    ['2026-11-06', 'weekly', null],
    ['2026-11-20', 'monthly', null],
    ['2026-12-18', 'quarterly', 'NQZ6'],
    ['2027-01-15', 'monthly', null],
    ['2027-02-19', 'monthly', null],
    ['2027-03-19', 'quarterly', 'NQH7'],
    ['2027-06-18', 'quarterly', 'NQM7'],
    ['2027-09-17', 'quarterly', 'NQU7'],
    ['2027-12-17', 'quarterly', 'NQZ7']
  ];
  assert.equal(exps.length, expected.length);
  exps.forEach((e, i) => {
    assert.equal(e.iso, expected[i][0], `iso at ${i}`);
    assert.equal(e.kind, expected[i][1], `kind at ${i}`);
    assert.equal(e.code, expected[i][2], `code at ${i}`);
    assert.equal(e.date.getUTCHours(), 0);
  });
  for (let i = 1; i < exps.length; i++) {
    assert.ok(exps[i].date.getTime() > exps[i - 1].date.getTime(), 'sorted and unique');
  }
  assert.equal(exps[1].label, 'Weekly · 23 Oct 2026');
  assert.equal(exps[4].label, 'Monthly · Nov 2026');
  assert.equal(exps[5].label, 'NQZ6 · Dec 2026');
  assert.equal(exps[11].dteAtStart, 434);
});

// ---------------------------------------------------------------------------
// 8. Expiries roll off
// ---------------------------------------------------------------------------
test('liveExpiries drops an expiry once its dte reaches zero', () => {
  const exps = buildExpiries(START);
  const day6 = liveExpiries(exps, 6);
  const day7 = liveExpiries(exps, 7);
  assert.ok(day6.some(e => e.iso === '2026-10-16'), 'still live at day 6');
  assert.ok(!day7.some(e => e.iso === '2026-10-16'), 'gone at day 7');
});

// ---------------------------------------------------------------------------
// 9. Strikes
// ---------------------------------------------------------------------------
test('buildStrikes(25000) gives 81 strikes from 15000 to 35000', () => {
  const strikes = buildStrikes(25000);
  assert.equal(strikes.length, 81);
  assert.equal(strikes[0], 15000);
  assert.equal(strikes[strikes.length - 1], 35000);
  for (let i = 1; i < strikes.length; i++) assert.equal(strikes[i] - strikes[i - 1], 250);
});

// ---------------------------------------------------------------------------
// 10. Surface grids
// ---------------------------------------------------------------------------
test('surfaceGrid values are finite, inside zRange, with correct axes', () => {
  const expiries = buildExpiries(START);
  const strikes = buildStrikes(F0);
  const F = F0;
  const maxDay = 433;

  for (const metric of Object.keys(METRICS)) {
    for (const type of ['call', 'put']) {
      const [zMin, zMax] = zRange({ metric, type, expiries, strikes, F, maxDay });
      for (const day of [0, 100, 200, 300, 433]) {
        const g = surfaceGrid({ metric, type, expiries, strikes, day, F });
        const live = expiries.filter(e => e.dteAtStart - day > 0);
        const tag = `${metric} ${type} day=${day}`;

        assert.deepEqual(g.y, live.map(e => e.dteAtStart - day), `y axis ${tag}`);
        assert.equal(g.z.length, live.length, `z rows ${tag}`);
        for (const K of g.x) {
          assert.ok(K >= 0.7 * F - 1e-6 && K <= 1.3 * F + 1e-6, `x outside band ${tag}`);
        }
        for (const row of g.z) {
          assert.equal(row.length, g.x.length, `z columns ${tag}`);
          for (const v of row) {
            assert.ok(Number.isFinite(v), `non-finite z ${tag}`);
            assert.ok(v >= zMin - EPS && v <= zMax + EPS,
              `z=${v} outside [${zMin}, ${zMax}] ${tag}`);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 11. Display formatting
// ---------------------------------------------------------------------------
test('METRICS formatters produce the expected strings', () => {
  assert.equal(METRICS.iv.format(0.1834), '18.3%');
  assert.equal(METRICS.price.format(12.345), '12.3');
  assert.equal(METRICS.delta.format(-0.5), '-0.500');
  assert.equal(METRICS.gamma.format(0.0001234), '0.000123');
  assert.equal(METRICS.theta.format(-3.14159), '-3.14');
  assert.equal(METRICS.vega.format(12.5), '12.50');
});
