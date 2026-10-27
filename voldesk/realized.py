"""Realised volatility estimators on daily OHLC, annualised with 252 trading days."""

import numpy as np
import pandas as pd

TRADING_DAYS = 252
CONE_HORIZONS = (10, 21, 42, 63, 126, 252)
CONE_QUANTILES = {"min": 0.0, "p10": 0.10, "p25": 0.25, "p50": 0.50, "p75": 0.75, "p90": 0.90, "max": 1.0}


def realized_vol(ohlc: pd.DataFrame, window: int, method: str = "c2c") -> pd.Series:
    o, h, l, c = (np.log(ohlc[col]) for col in ("open", "high", "low", "close"))
    if method == "c2c":
        var = c.diff().rolling(window).var()
    elif method == "parkinson":
        var = ((h - l) ** 2).rolling(window).mean() / (4 * np.log(2))
    elif method == "garman_klass":
        var = (0.5 * (h - l) ** 2 - (2 * np.log(2) - 1) * (c - o) ** 2).rolling(window).mean()
    elif method == "yang_zhang":
        overnight = o - c.shift(1)
        intraday = c - o
        rogers_satchell = (h - c) * (h - o) + (l - c) * (l - o)
        k = 0.34 / (1.34 + (window + 1) / (window - 1))
        var = (
            overnight.rolling(window).var()
            + k * intraday.rolling(window).var()
            + (1 - k) * rogers_satchell.rolling(window).mean()
        )
    else:
        raise ValueError(f"unknown estimator {method!r}")
    return np.sqrt(var * TRADING_DAYS)


def vol_cone(ohlc: pd.DataFrame) -> dict:
    """Distribution of close-to-close realised vol at each horizon over the full history."""
    cone = {"h": list(CONE_HORIZONS), "current": []}
    cone.update({name: [] for name in CONE_QUANTILES})
    for h in CONE_HORIZONS:
        rv = realized_vol(ohlc, h, "c2c").dropna()
        for name, q in CONE_QUANTILES.items():
            cone[name].append(float(rv.quantile(q)))
        cone["current"].append(float(rv.iloc[-1]))
    return cone
