"""Assemble everything the front end needs into one JSON-serialisable dict.

Arrays are columnar and rounded so the payload stays small enough to inline.
"""

import numpy as np

from .realized import realized_vol, vol_cone

RV_METHODS = ("c2c", "parkinson", "garman_klass", "yang_zhang")
RV_WINDOW = 21


def _r(values, nd):
    """Round to nd decimals, mapping NaN/inf to None so the JSON stays valid."""
    arr = np.asarray(values, dtype=float)
    out = np.round(arr, nd).tolist()
    if isinstance(out, float):
        return out if np.isfinite(out) else None
    return [v if np.isfinite(v) else None for v in out]


def _constant_maturity(slices, days, attr):
    """Interpolate a slice metric to a fixed tenor: total variance for ATM, linear otherwise."""
    pts = [(s.T, getattr(s, attr)) for s in slices if s.fit is not None and np.isfinite(getattr(s, attr))]
    if not pts:
        return np.nan
    Ts, vals = map(np.array, zip(*pts))
    t = days / 365.0
    if attr == "atm_iv":
        return float(np.sqrt(np.interp(t, Ts, vals**2 * Ts) / t)) if Ts[0] <= t <= Ts[-1] \
            else float(vals[0] if t < Ts[0] else vals[-1])
    return float(np.interp(t, Ts, vals))


def _percentile(series, window=252):
    tail = series.dropna().iloc[-window:]
    cur = tail.iloc[-1]
    return {
        "percentile": float((tail < cur).mean()),
        "rank": float((cur - tail.min()) / (tail.max() - tail.min())) if tail.max() > tail.min() else np.nan,
        "low": float(tail.min()),
        "high": float(tail.max()),
    }


def build_payload(snap, surf, repo=None) -> dict:
    slices = surf.slices
    spot = snap.spot
    hist = snap.history

    rv = {m: realized_vol(hist, RV_WINDOW, m) for m in RV_METHODS}
    vix = snap.vol_index.reindex(hist.index).ffill() / 100.0 if snap.vol_index is not None else None

    iv30 = _constant_maturity(slices, 30, "atm_iv")
    nxt = next((s for s in slices if s.dte >= 1 and np.isfinite(s.atm_iv)), None)
    summary = {
        "iv30": iv30,
        "iv60": _constant_maturity(slices, 60, "atm_iv"),
        "iv90": _constant_maturity(slices, 90, "atm_iv"),
        "iv180": _constant_maturity(slices, 180, "atm_iv"),
        "rr25_30": _constant_maturity(slices, 30, "rr25"),
        "bf25_30": _constant_maturity(slices, 30, "bf25"),
        "rv21": {m: float(rv[m].iloc[-1]) for m in RV_METHODS},
        "vrp": iv30 - float(rv["yang_zhang"].iloc[-1]),
        "next_move": {
            "expiry": nxt.expiry.isoformat(), "dte": nxt.dte, "iv": nxt.atm_iv,
            "abs": spot * nxt.atm_iv * np.sqrt(nxt.T),
        } if nxt else None,
    }
    if vix is not None:
        v = snap.vol_index.dropna()
        summary["vol_index"] = {
            "name": snap.vol_index_name, "level": float(v.iloc[-1]) / 100,
            "change": float(v.iloc[-1] - v.iloc[-2]) / 100, **_percentile(v / 100),
        }

    fitted = [s for s in slices if s.fit is not None]
    expiries = [{
        "date": s.expiry.isoformat(),
        "dte": s.dte,
        "T": round(s.T, 6),
        "F": round(s.F, 4),
        "D": round(s.D, 6),
        "parity": s.parity_forward,
        "n": int(len(s.k)),
        "k_lo": _r(s.k[0], 5),
        "k_hi": _r(s.k[-1], 5),
        "atm": _r(s.atm_iv, 5),
        "iv25p": _r(s.iv25p, 5),
        "iv25c": _r(s.iv25c, 5),
        "rr25": _r(s.rr25, 5),
        "bf25": _r(s.bf25, 5),
        "svi": s.fit.params.to_dict() if s.fit else None,
        "rmse": _r(s.fit.rmse, 5) if s.fit else None,
        "min_g": _r(s.fit.min_g, 4) if s.fit else None,
    } for s in slices]
    index_of = {s.expiry: i for i, s in enumerate(slices)}

    pts = surf.points
    g = surf.gex
    grid = surf.grid

    return {
        "meta": {
            "ticker": snap.ticker,
            "generated": snap.asof.isoformat(timespec="seconds"),
            "demo": snap.demo,
            "repo": repo,
            "spot": spot,
            "prev_close": snap.prev_close,
            "rate": snap.rate,
            "n_quotes": int(len(pts)),
            "n_expiries": len(slices),
            "n_fitted": len(fitted),
            "last_session": hist.index[-1].date().isoformat(),
        },
        "summary": {k: (_r(v, 6) if isinstance(v, float) else v) for k, v in summary.items()},
        "expiries": expiries,
        "points": {
            "e": [index_of[e] for e in pts["expiry"]],
            "K": _r(pts["strike"], 2),
            "k": _r(pts["k"], 5),
            "c": pts["is_call"].astype(int).tolist(),
            "iv": _r(pts["iv"], 5),
            "bid": _r(pts["iv_bid"], 5),
            "ask": _r(pts["iv_ask"], 5),
            "oi": pts["open_interest"].astype(int).tolist(),
            "vol": pts["volume"].astype(int).tolist(),
            "last": (pts["source"] == "last").astype(int).tolist(),
        },
        "surface": {
            "x": _r(grid["x"], 4),
            "dte": _r(grid["dte"], 3),
            "iv": [_r(row, 5) for row in grid["iv"]],
            "fan_x": [_r(row, 5) for row in grid["fan_x"]],
            "fan_iv": [_r(row, 5) for row in grid["fan_iv"]],
        },
        "calendar": surf.calendar,
        "gex": {
            "K": _r(g["strike"], 2),
            "T": _r(g["T"], 6),
            "fs": _r(g["F"] / spot, 6),
            "c": g["is_call"].astype(int).tolist(),
            "oi": g["open_interest"].astype(int).tolist(),
            "iv": _r(g["iv"], 4),
            "dte": g["dte"].astype(int).tolist(),
        },
        "history": {
            "date": [d.date().isoformat() for d in hist.index],
            "close": _r(hist["close"], 3),
            "vix": _r(vix, 4) if vix is not None else None,
            "rv": {m: _r(rv[m], 4) for m in RV_METHODS},
        },
        "cone": {k: (_r(v, 4) if k != "h" else v) for k, v in vol_cone(hist).items()},
    }
