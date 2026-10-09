# NQ Options Explorer

NQ Options Explorer is a static, single-page visualisation of **simulated** E-mini Nasdaq-100 (NQ) futures options. Its headline feature is a time slider (with Play) that moves the valuation date forward day by day: near-dated contracts expire and roll off, time to expiry shrinks for every option, the volatility surface reshapes, and prices and Greeks decay. It replaces an earlier script that built a QQQ implied-volatility surface from Yahoo Finance, because real NQ options data is not freely available.

## Quick start

Double-click `index.html`, or open it in any modern browser. The first time, you need an internet connection so the page can load Plotly 3.7.0 from the jsDelivr CDN. Nothing else needs installing.

To serve the folder instead:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

### URL parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `date` | today | Simulation start date (Day 0), e.g. `2026-10-09` |
| `f0` | `25000` | Starting NQ futures price |

Example: `index.html?date=2026-10-09&f0=26000`

## Controls

- **Time slider, Play/Pause, Reset:** runs from Day 0 to the day before the last listed expiry.
- **NQ futures price slider:** ±20% around the starting price. Listed strikes stay fixed, so moneyness changes as it would in a real market.
- **Vol shift:** parallel shift of the at-the-money (ATM) term structure, ±10 vol points.
- **Surface metric:** Implied volatility, Premium, Delta, Gamma, Theta or Vega.
- **Call / Put toggle:** switches between calls and puts.

## Panels

1. **3D surface:** strike × days to expiry × chosen metric, with listed contracts marked. Click a point to select that contract. The axes are fixed, so you can watch contracts slide toward expiry.
2. **Volatility smile by expiry:** implied volatility against strike, for every live expiry.
3. **Value vs futures price:** for the selected option, the payoff at expiry, the value at Day 0 and the value now. As time advances, "now" collapses onto the payoff.
4. **Contract card:** premium (points and $), implied volatility, Greeks, days to expiry, moneyness and decay since Day 0.
5. **Mini option chain:** the selected expiry's strikes. Click a row to select a strike.

## Key terms

- **Implied volatility (IV):** the volatility that makes the Black-76 price match the option's price.
- **Moneyness:** how far the strike is from the futures price. An out-of-the-money (OTM) call has a strike above the futures price; an OTM put has a strike below it.
- **Premium:** the option's price in index points. Each point is worth $20.
- **Intrinsic value:** what the option would pay if exercised now.
- **Greeks:** how the premium responds to changes in the futures price (Delta, Gamma), volatility (Vega) and time (Theta).

## How the model works

### Underlying and contracts

- One futures price, F, drives every contract. The multiplier is $20 per index point, so a 100-point premium is $2,000. The risk-free rate is 4%, used only for discounting.
- Expiries follow a CME-style calendar, with holidays ignored:
  - **Weekly:** the next four Fridays.
  - **Monthly:** the 3rd Friday of each of the next six months.
  - **Quarterly:** the 3rd Friday of March, June, September and December, out to about 15 months.
- Labels use CME month codes (H = Mar, M = Jun, U = Sep, Z = Dec) plus a year digit. For example, NQZ6 is the December 2026 contract.
- Strikes sit on a fixed grid every 250 points, from 60% to 140% of the starting price.

### Pricing: Black-76

Black-76 prices options on futures. Here F is the futures price, K the strike, T the time to expiry in years, r the risk-free rate, σ the volatility, N the standard normal CDF and n its density.

```text
d1 = [ ln(F/K) + σ²T/2 ] / (σ√T)
d2 = d1 − σ√T

Call = e^(−rT) · [ F·N(d1) − K·N(d2) ]
Put  = e^(−rT) · [ K·N(−d2) − F·N(−d1) ]
```

The Greeks:

```text
Delta (call)         = e^(−rT) · N(d1)
Delta (put)          = −e^(−rT) · N(−d1)
Gamma                = e^(−rT) · n(d1) / (F·σ·√T)
Vega (per vol point) = e^(−rT) · F · n(d1) · √T / 100
Theta (per day)      = [ r·V − e^(−rT) · F · n(d1) · σ / (2√T) ] / 365
```

V is the option's value. An expired option (T = 0) is worth its intrinsic value: max(F − K, 0) for a call, max(K − F, 0) for a put.

### Volatility surface: SSVI

Implied volatility comes from SSVI (Surface SVI, Gatheral & Jacquier, 2014). SSVI is free of static arbitrage when η(1 + |ρ|) ≤ 2 and 0 < γ ≤ ½. The parameters below satisfy both (here η(1 + |ρ|) = 1.87 and γ = 0.4).

```text
k        = ln(K / F)                             log-moneyness
σ_atm(T) = σ∞ + (σ0 − σ∞) · e^(−T/τ) + vol shift
θ(T)     = σ_atm(T)² · T                         ATM total variance
φ(θ)     = η / ( θ^γ · (1 + θ)^(1 − γ) )
w(k, θ)  = θ/2 · [ 1 + ρ·φ·k + √( (φ·k + ρ)² + 1 − ρ² ) ]
σ(K, T)  = √( w / T )
```

Parameters: σ0 = 18%, σ∞ = 22%, τ = 0.5 years (an upward-sloping term structure), ρ = −0.7, η = 1.1, γ = 0.4.

Note that w is total variance (σ²T), which is why calendar arbitrage is checked on it.

- **Negative ρ** gives the equity-index downside skew: OTM puts are richer (higher vol) than OTM calls.
- **The skew steepens** as expiry approaches.
- **Rough one-month reference values:** ATM ≈ 18.5%, 10% OTM put ≈ 25%, 5% OTM call ≈ 15%.

### Time decay and roll-down

The surface is time-homogeneous: an option's smile depends only on the time it has left. Moving the slider therefore makes each expiry "roll down" the term structure, while its premium and Greeks decay. The futures price and vol shift stay at their slider values, so only time changes.

## Simplifications and limitations

- **Simulated data**, not market quotes.
- **European exercise** via Black-76, so the early-exercise premium is ignored.
- **One futures price** for all expiries, so the carry spread between quarterly contracts is ignored.
- **Not modelled:** holidays, 0DTE and daily options, and bid/ask spreads.
- **Theta and vega** are model sensitivities at a fixed implied volatility.

## Project structure

```text
index.html           the page (open it directly in a browser)
css/styles.css       styles, light and dark theme
js/model.js          pricing and surface model, no DOM (exposed as NQModel)
js/app.js            UI, controls and Plotly charts
tests/model.test.js  unit tests (Node's built-in test runner)
package.json         npm test
```

## Running the tests

```bash
npm test
```

Requires Node 18 or later. There are no dependencies to install. The tests cover:

- Black-76 put–call parity.
- Greeks against finite differences.
- Expired options equal intrinsic value.
- ATM vol matches the term structure.
- No butterfly arbitrage: call prices convex and decreasing in strike.
- No calendar arbitrage: total variance non-decreasing in T.
- Expiry calendar: 3rd Fridays, CME codes, roll-off.
- Surface grids finite and within fixed axis ranges.

## Disclaimer

Educational project. The data is simulated and this is not investment advice.
