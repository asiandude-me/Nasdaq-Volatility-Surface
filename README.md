# VolDesk: Nasdaq-100 volatility dashboard

A static, interactive vol desk for QQQ (the listed proxy for NQ). A Python pipeline
pulls the option chain and price history, fits the surface, and writes one HTML page.
GitHub Actions rebuilds it on a schedule and publishes it with GitHub Pages.

**Live site:** https://asiandude-me.github.io/Nasdaq-Volatility-Surface/ (once Pages is enabled, see below)

## What's on it

| Section | Panels |
|---|---|
| Headline | Spot, 30d ATM IV, VXN level and 1y percentile, 21d realised vol, vol risk premium, 25Δ risk reversal, net dealer gamma, 1σ implied move. Auto-generated desk notes. |
| Surface | 3D SVI surface (or heatmap) with optional raw quotes. ATM/25Δ term structure. Risk reversal and butterfly by tenor. |
| Smile & pricing | Smile explorer with bid/ask IV bars and the SVI fit, up to 3 expiries, x-axis in K/S, strike or delta. Black-76 pricer with Greeks and a spot/vol/time scenario P&L. |
| Positioning | Gamma exposure by strike, the GEX profile across spot with the gamma flip, call/put walls, and expiry-window filters. |
| Realised vs implied | Price with the implied ±1σ/±2σ cone. VXN vs 21d realised with four estimators. Vol risk premium. Volatility cone. |
| Diagnostics | Per-expiry SVI parameters, fit RMSE, and butterfly (Durrleman) and calendar arbitrage checks. |

Every chart has a table view. There's a light/dark toggle, and the layout works on a phone.

## Make it a website (one-time)

1. Merge this into `main`.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to **Actions → Dashboard → Run workflow**.

After that the site rebuilds itself at 14:47, 17:47 and 20:47 UTC on weekdays, and on
every push to `main`. The **Run update** button on the page links to the workflow, so you
can refresh it any time. If a build fails (Yahoo hiccup, bad data), nothing is deployed
and the last good snapshot stays up.

> GitHub pauses scheduled workflows in a repo with no activity for 60 days. One click on
> "Enable workflow" in the Actions tab turns it back on.

## Run it locally

```bash
pip install -r requirements.txt
python build_dashboard.py               # live QQQ -> site/index.html
python build_dashboard.py SPY           # any optionable ticker (VIX history for SPY, RVX for IWM)
python build_dashboard.py --demo        # synthetic market, no network (clearly flagged on the page)
python build_dashboard.py --inline-plotly   # bundle Plotly so the file works fully offline
python -m pytest -q
```

Open `site/index.html` directly in a browser, no server needed. While you work on the
front end, `python build_dashboard.py --from-json site/data.json` re-renders the page
from the last payload in well under a second.

## Method

- **Forwards.** Implied per expiry from put–call parity on the strikes nearest the money,
  F = K + (C − P)/D. Dividends and borrow come from the market rather than an assumed
  yield. If parity can't be read, the build falls back to carry at the T-bill rate.
- **Implied vols.** Black-76 on the forward, inverted by vectorised bisection for bid, mid
  and ask. Only OTM quotes are used. Quotes under $0.05, or further than max(0.1, 1.5√T) from the
  money in log-moneyness, are dropped. Yahoo zeroes bid/ask out of hours, so a last trade from the previous 4 days
  stands in, drawn hollow on the smile.
- **SVI.** Raw SVI per expiry, seeded by the quasi-explicit method (Zeliade) and polished
  in vol space. The fit is weighted by inverse bid/ask IV spread and uses a soft-L1 loss,
  so one stale print can't bend the smile. A slice is rejected if its RMSE is over 5 vol pts.
- **Surface.** Total variance is interpolated linearly in T between slices. The plot only
  covers the strikes the market actually quotes, measured in standard deviations.
- **25Δ.** Strikes use undiscounted forward delta. RR = σ(25Δc) − σ(25Δp), and
  BF = ½(σ25c + σ25p) − σATM. 30/60/90d values interpolate total variance.
- **GEX.** Per contract: OI × S × φ(d1)/(σ√T), i.e. $ gamma per 1% move. Calls count as
  positive and puts as negative, the naive "dealers long calls, short puts" convention.
  Real dealer positioning isn't observable, so treat this as a map of where open
  interest concentrates gamma, not a forecast.
- **Realised vol.** Close-to-close, Parkinson, Garman–Klass and Yang–Zhang over 21 days,
  annualised on 252 days. The cone uses rolling close-to-close windows over 3 years.

## Data caveats

- Yahoo Finance quotes are delayed about 15 minutes.
- Outside US market hours Yahoo blanks bids, asks and open interest. An off-hours build
  still works, but it prices from last trades, flags "Market closed · last-trade prices"
  in the header, and skips GEX. The scheduled builds all run during the session.
- QQQ options are American-style. Using Black-76 on OTM quotes ignores a small
  early-exercise premium, which is negligible for OTM options.

## Layout

```
build_dashboard.py      CLI: data -> model -> site/
voldesk/
  market.py             yfinance loaders (chain, OHLC, VXN, T-bill rate)
  demo.py               synthetic market with the same shape, for offline work
  black.py              Black-76, vectorised IV solver, forward delta
  svi.py                SVI fit + Durrleman butterfly check
  surface.py            forwards, IVs, slices, term structure, grids, calendar check
  realized.py           realised-vol estimators and vol cone
  payload.py            everything the page needs, as compact JSON
  site.py               inlines web/ + data into one HTML file
web/                    index.html, styles.css, app.js (charts, GEX, pricer)
tests/                  pricing, SVI, estimators, end-to-end on the demo market
```
