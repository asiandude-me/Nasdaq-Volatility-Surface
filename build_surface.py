"""
Build an implied volatility surface for QQQ (Nasdaq-100 ETF, used as a proxy
for NQ since Yahoo Finance does not publish CME futures options chains).

Pipeline: fetch the full option chain via yfinance -> clean/filter to liquid
OTM quotes -> solve for implied vol per contract with Black-Scholes + Brent's
method -> interpolate onto a regular (moneyness, days-to-expiry) grid ->
render an interactive Plotly 3D surface as a self-contained HTML file.

Usage: python build_surface.py [TICKER]
"""

import sys
import datetime as dt

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import norm
from scipy.optimize import brentq
from scipy.interpolate import griddata
import plotly.graph_objects as go
import plotly.io as pio

TICKER = sys.argv[1] if len(sys.argv) > 1 else "QQQ"
OUTPUT_HTML = "surface.html"

MIN_DTE_DAYS = 3
MONEYNESS_BAND = (0.6, 1.4)  # keep strikes within 60%-140% of spot
SIGMA_BOUNDS = (1e-4, 5.0)


def bs_price(S, K, T, r, sigma, option_type):
    if T <= 0 or sigma <= 0:
        return max(0.0, (S - K) if option_type == "call" else (K - S))
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    if option_type == "call":
        return S * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2)
    return K * np.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def implied_vol(price, S, K, T, r, option_type):
    intrinsic = max(0.0, (S - K) if option_type == "call" else (K - S))
    if price <= intrinsic + 1e-8:
        return np.nan

    def objective(sigma):
        return bs_price(S, K, T, r, sigma, option_type) - price

    lo, hi = SIGMA_BOUNDS
    try:
        if objective(lo) * objective(hi) > 0:
            return np.nan
        return brentq(objective, lo, hi, xtol=1e-6, maxiter=200)
    except (ValueError, RuntimeError):
        return np.nan


def fetch_risk_free_rate():
    try:
        irx = yf.Ticker("^IRX").history(period="5d")["Close"].dropna()
        if len(irx):
            return float(irx.iloc[-1]) / 100.0
    except Exception:
        pass
    return 0.04  # fallback approximation


def fetch_spot(tk):
    try:
        price = tk.fast_info["lastPrice"]
        if price:
            return float(price)
    except Exception:
        pass
    hist = tk.history(period="1d")
    return float(hist["Close"].iloc[-1])


def fetch_chain(tk):
    rows = []
    today = pd.Timestamp(dt.date.today())
    for expiry in tk.options:
        try:
            chain = tk.option_chain(expiry)
        except Exception:
            continue
        expiry_ts = pd.Timestamp(expiry)
        for option_type, df in (("call", chain.calls), ("put", chain.puts)):
            d = df.copy()
            d["type"] = option_type
            d["expiry"] = expiry_ts
            rows.append(d)
    full = pd.concat(rows, ignore_index=True)
    full["dte"] = (full["expiry"] - today).dt.days
    return full


def main():
    print(f"Fetching option chain for {TICKER}...")
    tk = yf.Ticker(TICKER)
    spot = fetch_spot(tk)
    r = fetch_risk_free_rate()
    print(f"Spot price: {spot:.2f}  |  risk-free rate: {r:.4%}")

    raw = fetch_chain(tk)
    print(f"Fetched {len(raw)} raw contracts across {raw['expiry'].nunique()} expiries")

    df = raw.copy()
    has_quote = (df["bid"] > 0) & (df["ask"] > 0) & (df["bid"] <= df["ask"])
    mid = (df["bid"] + df["ask"]) / 2.0
    # Bid/ask are frequently zeroed out in yfinance snapshots (stale/no quote).
    # Fall back to lastPrice when there was an actual recent trade (volume > 0).
    df["mid"] = np.where(has_quote, mid, np.where(df["volume"].fillna(0) > 0, df["lastPrice"], np.nan))
    df = df.dropna(subset=["mid"])
    df = df[df["mid"] > 0]
    df = df[df["dte"] >= MIN_DTE_DAYS]
    df = df[(df["volume"].fillna(0) > 0) | (df["openInterest"].fillna(0) > 0)]

    df["moneyness"] = df["strike"] / spot
    df = df[(df["moneyness"] >= MONEYNESS_BAND[0]) & (df["moneyness"] <= MONEYNESS_BAND[1])]

    # Keep OTM-only quotes (more reliable/liquid): calls above spot, puts below spot
    otm_calls = df[(df["type"] == "call") & (df["strike"] >= spot)]
    otm_puts = df[(df["type"] == "put") & (df["strike"] < spot)]
    df = pd.concat([otm_calls, otm_puts], ignore_index=True)
    print(f"{len(df)} contracts remain after liquidity/moneyness/OTM filtering")

    df["T"] = df["dte"] / 365.0
    df["iv"] = df.apply(
        lambda row: implied_vol(row["mid"], spot, row["strike"], row["T"], r, row["type"]),
        axis=1,
    )
    df = df.dropna(subset=["iv"])
    df = df[(df["iv"] > 0.01) & (df["iv"] < 3.0)]
    print(f"{len(df)} contracts with a valid solved implied vol")

    if len(df) < 10:
        raise SystemExit("Too few valid IV points to build a surface — check data availability.")

    # Interpolate scattered (moneyness, dte) -> iv onto a regular grid
    grid_m = np.linspace(df["moneyness"].min(), df["moneyness"].max(), 60)
    grid_d = np.linspace(df["dte"].min(), df["dte"].max(), 60)
    grid_M, grid_D = np.meshgrid(grid_m, grid_d)

    points = df[["moneyness", "dte"]].to_numpy()
    values = df["iv"].to_numpy()
    grid_iv = griddata(points, values, (grid_M, grid_D), method="linear")
    grid_iv_nearest = griddata(points, values, (grid_M, grid_D), method="nearest")
    grid_iv = np.where(np.isnan(grid_iv), grid_iv_nearest, grid_iv)

    fig = go.Figure()
    fig.add_trace(
        go.Surface(
            x=grid_M,
            y=grid_D,
            z=grid_iv,
            colorscale="Viridis",
            colorbar=dict(title="Implied Vol"),
            opacity=0.95,
            name="Interpolated surface",
        )
    )
    fig.add_trace(
        go.Scatter3d(
            x=df["moneyness"],
            y=df["dte"],
            z=df["iv"],
            mode="markers",
            marker=dict(size=2.5, color="black"),
            name="Solved IV points",
        )
    )
    fig.update_layout(
        title=f"{TICKER} Implied Volatility Surface — spot {spot:.2f}, "
        f"generated {dt.date.today().isoformat()}",
        scene=dict(
            xaxis_title="Moneyness (K / Spot)",
            yaxis_title="Days to Expiry",
            zaxis_title="Implied Volatility",
        ),
        margin=dict(l=0, r=0, t=60, b=0),
        height=800,
    )

    plot_div = pio.to_html(fig, include_plotlyjs="inline", full_html=False)

    caption = (
        f"<p style='font-family:sans-serif;color:#666;font-size:0.9em;'>"
        f"Underlying: {TICKER} (proxy for NQ — CME futures options are not "
        f"available via Yahoo Finance) &middot; Spot: {spot:.2f} &middot; "
        f"Risk-free rate: {r:.2%} &middot; {len(df)} solved OTM contracts "
        f"&middot; Generated {dt.datetime.now().isoformat(timespec='seconds')}"
        f"</p>"
    )

    html = f"<h2 style='font-family:sans-serif;'>{TICKER} Implied Volatility Surface</h2>{caption}{plot_div}"
    with open(OUTPUT_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
