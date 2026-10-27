"""Market data loading. Live data comes from Yahoo Finance via yfinance.

QQQ stands in for NQ: Yahoo does not publish CME futures option chains, and
QQQ options are the most liquid listed Nasdaq-100 vol market anyway.
"""

import datetime as dt
from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

# Volatility index quoted on the same underlying index, for implied-vs-realised history.
VOL_INDEX = {"QQQ": "^VXN", "SPY": "^VIX", "IWM": "^RVX", "DIA": "^VXD"}
CHAIN_COLUMNS = ["expiry", "type", "strike", "bid", "ask", "last", "volume", "open_interest", "last_trade"]


@dataclass
class MarketSnapshot:
    ticker: str
    asof: dt.datetime  # UTC
    spot: float
    prev_close: float
    rate: float  # continuously-compounded proxy for discounting
    chain: pd.DataFrame  # CHAIN_COLUMNS; expiry is a date, type is "call"/"put"
    history: pd.DataFrame  # daily OHLC, DatetimeIndex
    vol_index: Optional[pd.Series]  # daily close of VOL_INDEX[ticker], in vol points
    vol_index_name: Optional[str]
    demo: bool = False


def _rate(yf):
    try:
        irx = yf.Ticker("^IRX").history(period="5d")["Close"].dropna()
        if len(irx):
            return float(irx.iloc[-1]) / 100.0
    except Exception:
        pass
    return 0.04


def _chain(tk):
    frames = []
    for expiry in tk.options:
        try:
            chain = tk.option_chain(expiry)
        except Exception:
            continue
        for option_type, df in (("call", chain.calls), ("put", chain.puts)):
            frames.append(pd.DataFrame({
                "expiry": pd.Timestamp(expiry).date(),
                "type": option_type,
                "strike": df["strike"].astype(float),
                "bid": df["bid"].astype(float),
                "ask": df["ask"].astype(float),
                "last": df["lastPrice"].astype(float),
                "volume": df["volume"].fillna(0).astype(float),
                "open_interest": df["openInterest"].fillna(0).astype(float),
                "last_trade": pd.to_datetime(df["lastTradeDate"], utc=True),
            }))
    if not frames:
        raise RuntimeError("No option chains returned — Yahoo may be rate-limiting this IP.")
    return pd.concat(frames, ignore_index=True)[CHAIN_COLUMNS]


def load_live(ticker: str) -> MarketSnapshot:
    import yfinance as yf

    tk = yf.Ticker(ticker)
    history = tk.history(period="3y", auto_adjust=True)[["Open", "High", "Low", "Close"]].dropna()
    history.columns = ["open", "high", "low", "close"]
    history.index = pd.DatetimeIndex(history.index.date)
    if len(history) < 300:
        raise RuntimeError(f"Only {len(history)} days of price history for {ticker}.")

    try:
        spot = float(tk.fast_info["lastPrice"])
        prev_close = float(tk.fast_info["previousClose"])
    except Exception:
        spot, prev_close = float(history["close"].iloc[-1]), float(history["close"].iloc[-2])

    vol_index, vol_index_name = None, VOL_INDEX.get(ticker.upper())
    if vol_index_name:
        try:
            vix = yf.Ticker(vol_index_name).history(period="3y")["Close"].dropna()
            vix.index = pd.DatetimeIndex(vix.index.date)
            vol_index = vix if len(vix) else None
        except Exception:
            vol_index = None

    return MarketSnapshot(
        ticker=ticker.upper(),
        asof=dt.datetime.now(dt.timezone.utc),
        spot=spot,
        prev_close=prev_close,
        rate=_rate(yf),
        chain=_chain(tk),
        history=history,
        vol_index=vol_index,
        vol_index_name=vol_index_name if vol_index is not None else None,
    )


def check_snapshot(snap: MarketSnapshot) -> None:
    if not np.isfinite(snap.spot) or snap.spot <= 0:
        raise RuntimeError(f"Bad spot price {snap.spot!r}")
    if snap.chain.empty:
        raise RuntimeError("Empty option chain")
