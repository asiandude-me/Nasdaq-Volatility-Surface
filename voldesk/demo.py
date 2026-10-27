"""Synthetic market for offline development: same shape as market.load_live, clearly flagged.

Prices follow a stochastic-vol random walk with leverage; the option chain is priced
off a skewed smile with an upward-sloping term structure, then given realistic
bid/ask spreads, tick rounding and open interest clustered on round strikes.
"""

import datetime as dt

import numpy as np
import pandas as pd

from .black import black76
from .market import MarketSnapshot, CHAIN_COLUMNS
from .surface import year_fraction, NY

RATE, DIV_YIELD = 0.04, 0.006


def _history(rng, end: dt.date, n_days=756, s0=480.0, s_end=612.4):
    dates = pd.bdate_range(end=end, periods=n_days)
    steps = 26  # 15-minute bars for intraday high/low
    dt_step = 1 / (252 * steps)
    log_vol, log_s = np.log(0.2), np.log(s0)
    rows, vols = [], []
    for _ in dates:
        open_ = log_s + rng.normal(0, 0.25 * np.exp(log_vol) / np.sqrt(252))
        path = [open_]
        for _ in range(steps):
            z_v, z = rng.normal(size=2)
            z_s = -0.7 * z_v + np.sqrt(1 - 0.7**2) * z  # leverage: vol up, price down
            log_vol += 6.0 * (np.log(0.19) - log_vol) * dt_step + 1.1 * np.sqrt(dt_step) * z_v
            sigma = np.exp(log_vol)
            path.append(path[-1] + (0.10 - 0.5 * sigma**2) * dt_step + sigma * np.sqrt(dt_step) * z_s)
        log_s = path[-1]
        rows.append(np.exp([path[0], max(path), min(path), path[-1]]))
        vols.append(np.exp(log_vol))
    history = pd.DataFrame(rows, index=dates, columns=["open", "high", "low", "close"])
    return history * (s_end / history["close"].iloc[-1]), np.array(vols)


def _expiries(today: dt.date):
    days = [today + dt.timedelta(days=i) for i in range(1, 900)]
    weekdays = [d for d in days if d.weekday() < 5]
    out = set(weekdays[:10])  # dailies
    out |= {d for d in days if d.weekday() == 4 and d <= today + dt.timedelta(days=60)}  # weeklies
    monthly = [d for d in days if d.weekday() == 4 and 15 <= d.day <= 21]
    out |= {d for d in monthly if d <= today + dt.timedelta(days=370)}
    out |= {d for d in monthly if d.month in (3, 6, 12) or (d.month == 1 and d > today + dt.timedelta(days=370))}
    return sorted(out)


def _smile(k, T, atm):
    z = k / (atm * np.sqrt(T))
    return np.maximum(atm * (1 - 0.13 * z + 0.035 * z**2), 0.6 * atm)


def load_demo(ticker="QQQ", seed=7) -> MarketSnapshot:
    rng = np.random.default_rng(seed)
    asof = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = asof.astimezone(NY).date()
    history, latent_vol = _history(rng, today)
    spot = float(history["close"].iloc[-1])

    vol_index = pd.Series(
        100 * (1.08 * latent_vol + 0.012 + rng.normal(0, 0.006, len(latent_vol))), index=history.index
    ).rolling(3, min_periods=1).mean()

    front_atm = 1.05 * latent_vol[-1] + 0.01
    rows = []
    for expiry in _expiries(today):
        T = year_fraction(expiry, asof)
        F = spot * np.exp((RATE - DIV_YIELD) * T)
        atm = 0.215 + (front_atm - 0.215) * np.exp(-T / 0.25)
        width = max(0.12, 3.2 * atm * np.sqrt(T))
        step = 1.0 if T < 0.25 else 5.0
        strikes = np.arange(np.floor(spot * np.exp(-width)), np.ceil(spot * np.exp(0.6 * width)), step)
        strikes = np.unique(np.round(strikes / step) * step)
        k = np.log(strikes / F)
        iv = _smile(k, T, atm)
        monthly = 15 <= expiry.day <= 21 and expiry.weekday() == 4
        quarterly = monthly and expiry.month in (3, 6, 9, 12)
        for option_type, is_call in (("call", True), ("put", False)):
            fair = black76(F, strikes, T, iv, is_call, np.exp(-RATE * T))
            mid = fair * (1 + rng.normal(0, 0.004, len(strikes)))
            spread = 0.01 + 0.004 * mid + rng.uniform(0, 0.02, len(strikes))
            bid = np.round(mid - spread / 2, 2)
            ask = np.round(mid + spread / 2, 2)
            bid[bid < 0.01] = 0.0
            # OI builds up over a contract's life, peaks on monthlies/quarterlies and round
            # strikes, and sits mostly OTM: puts below spot, calls above.
            otm_side = np.where(is_call, k > 0, k < 0)
            life = 0.25 + min(T, 0.5) / 0.5
            oi = 1300 * life * np.exp(-0.5 * (k / (0.8 * atm * np.sqrt(T) + 0.04)) ** 2)
            oi *= np.where(otm_side, 1.0, 0.3) * (1.15 if not is_call else 1.0)
            oi *= (2.5 if monthly else 1.0) * (1.6 if quarterly else 1.0)
            oi *= 1 + 1.5 * (strikes % 25 == 0) + 0.6 * (strikes % 10 == 0) + 0.3 * (strikes % 5 == 0)
            oi = np.round(oi * rng.lognormal(0, 0.45, len(strikes)))
            volume = np.round(oi * rng.uniform(0.02, 0.4, len(strikes)))
            listed = ask >= 0.02
            rows.append(pd.DataFrame({
                "expiry": expiry, "type": option_type, "strike": strikes, "bid": bid, "ask": ask,
                "last": np.round(mid, 2), "volume": volume, "open_interest": oi,
                "last_trade": pd.Timestamp(asof),
            })[listed])

    return MarketSnapshot(
        ticker=ticker.upper(),
        asof=asof,
        spot=spot,
        prev_close=float(history["close"].iloc[-2]),
        rate=RATE,
        chain=pd.concat(rows, ignore_index=True)[CHAIN_COLUMNS],
        history=history,
        vol_index=vol_index,
        vol_index_name="^VXN",
        demo=True,
    )
