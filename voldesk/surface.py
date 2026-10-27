"""Option chain -> implied forwards -> OTM implied vols -> SVI slices -> surface.

Conventions: T is ACT/365 to the 16:00 New York close on expiry day,
k = ln(K / F) is log forward-moneyness, x = K / S is spot moneyness (for display).
"""

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .black import implied_vol, forward_delta
from .svi import fit_svi, SVIFit

NY = ZoneInfo("America/New_York")
YEAR_SECONDS = 365.0 * 86400

MIN_PRICE = 0.05  # below this, tick size dominates the quote and IV is noise
MIN_FIT_DAYS = 2  # shorter expiries are too pinned/noisy for a stable smile fit
MAX_FIT_RMSE = 0.05  # reject a slice whose SVI misses its quotes by > 5 vol points
STALE_LAST_DAYS = 4  # lastPrice fallback only if the contract traded recently
MONEYNESS_BAND = (0.6, 1.4)
IV_BAND = (0.01, 3.0)


@dataclass
class Slice:
    expiry: dt.date
    T: float
    dte: int
    F: float
    D: float
    parity_forward: bool  # F implied from put-call parity (else carry at the risk-free rate)
    k: np.ndarray  # observed OTM log-moneyness, sorted
    iv: np.ndarray  # observed mid IVs, aligned with k
    fit: Optional[SVIFit] = None
    atm_iv: float = np.nan
    iv25p: float = np.nan
    iv25c: float = np.nan

    @property
    def rr25(self):
        return self.iv25c - self.iv25p

    @property
    def bf25(self):
        return 0.5 * (self.iv25c + self.iv25p) - self.atm_iv

    def iv_at(self, k):
        """Model vol where fitted (vol held flat beyond the quoted range), else linear in k."""
        k = np.asarray(k, dtype=float)
        if self.fit is not None:
            return self.fit.params.iv(np.clip(k, self.k[0] - 0.05, self.k[-1] + 0.05), self.T)
        return np.interp(k, self.k, self.iv)


@dataclass
class SurfaceResult:
    slices: list
    points: pd.DataFrame
    gex: pd.DataFrame
    grid: dict
    calendar: list = field(default_factory=list)


def year_fraction(expiry: dt.date, asof: dt.datetime) -> float:
    close = dt.datetime.combine(expiry, dt.time(16, 0), tzinfo=NY)
    return (close - asof).total_seconds() / YEAR_SECONDS


def _quote_prices(chain, asof):
    two_sided = (chain["bid"] > 0) & (chain["ask"] > 0) & (chain["ask"] >= chain["bid"])
    # Yahoo often zeroes bid/ask outside market hours; a fresh trade print is the next best thing.
    recent = chain["last_trade"] >= pd.Timestamp(asof) - pd.Timedelta(days=STALE_LAST_DAYS)
    traded = (chain["last"] > 0) & (chain["volume"] > 0) & recent  # NaT compares False
    mid = 0.5 * (chain["bid"] + chain["ask"])
    price = np.where(two_sided, mid, np.where(traded, chain["last"], np.nan))
    source = np.where(two_sided, "quote", np.where(traded, "last", "none"))
    return price, source


def _forward(calls, puts, spot, T, D):
    """Median parity forward F = K + (C - P) / D over the strikes nearest the money."""
    both = calls.merge(puts, on="strike", suffixes=("_c", "_p"))
    both = both[(both["source_c"] == "quote") & (both["source_p"] == "quote")]
    both = both[(both["strike"] / spot - 1).abs() <= 0.05]
    if len(both) >= 2:
        nearest = both.assign(gap=(both["price_c"] - both["price_p"]).abs()).nsmallest(6, "gap")
        F = float(np.median(nearest["strike"] + (nearest["price_c"] - nearest["price_p"]) / D))
        if abs(F / spot - 1) < 0.02 + 0.1 * T:
            return F, True
    return spot / D, False


def _delta_vol(slice_, call_delta):
    """Vol at the strike whose forward call delta equals call_delta (0.75 = 25-delta put)."""
    p, T = slice_.fit.params, slice_.T
    scale = max(np.sqrt(max(slice_.atm_iv**2 * T, 1e-8)), 0.01)
    kk = np.linspace(-6 * scale, 6 * scale, 4001)
    delta = forward_delta(kk, p.w(kk), is_call=True)
    crossing = np.nonzero(np.diff(np.sign(delta - call_delta)))[0]
    if not len(crossing):
        return np.nan
    i = crossing[0]
    k_star = np.interp(call_delta, [delta[i + 1], delta[i]], [kk[i + 1], kk[i]])
    return float(p.iv(k_star, T))


def build_surface(snap) -> SurfaceResult:
    chain = snap.chain.copy()
    spot, asof = snap.spot, snap.asof
    expiry_T = {e: year_fraction(e, asof) for e in chain["expiry"].unique()}
    chain["T"] = chain["expiry"].map(expiry_T)
    chain = chain[chain["T"] > 1 / (365 * 24)].copy()  # drop anything within an hour of expiry
    chain["price"], chain["source"] = _quote_prices(chain, asof)
    chain["dte"] = chain["expiry"].map(lambda e: (e - asof.astimezone(NY).date()).days)

    forwards = {}
    for expiry, grp in chain.groupby("expiry"):
        T = grp["T"].iloc[0]
        D = float(np.exp(-snap.rate * T))
        calls = grp[grp["type"] == "call"][["strike", "price", "source"]]
        puts = grp[grp["type"] == "put"][["strike", "price", "source"]]
        F, parity = _forward(calls, puts, spot, T, D)
        forwards[expiry] = (F, D, parity)
    chain["F"] = chain["expiry"].map(lambda e: forwards[e][0])
    chain["D"] = chain["expiry"].map(lambda e: forwards[e][1])
    chain["k"] = np.log(chain["strike"] / chain["F"])
    chain["x"] = chain["strike"] / spot
    chain["is_call"] = chain["type"] == "call"

    # --- OTM implied vols (OTM relative to the forward, where quotes are cleanest) ---
    otm = chain[(chain["is_call"] & (chain["k"] >= 0)) | (~chain["is_call"] & (chain["k"] < 0))]
    otm = otm[otm["price"] >= MIN_PRICE]
    otm = otm[otm["x"].between(*MONEYNESS_BAND)]
    otm = otm[otm["k"].abs() <= np.maximum(0.1, 1.5 * np.sqrt(otm["T"]))]
    args = (otm["F"], otm["strike"], otm["T"], otm["is_call"], otm["D"])
    otm = otm.assign(
        iv=implied_vol(otm["price"], *args),
        iv_bid=implied_vol(otm["bid"].where(otm["source"] == "quote"), *args),
        iv_ask=implied_vol(otm["ask"].where(otm["source"] == "quote"), *args),
    )
    points = otm[otm["iv"].between(*IV_BAND)].sort_values(["expiry", "k"]).reset_index(drop=True)
    if len(points) < 20:
        raise RuntimeError(f"Only {len(points)} usable implied vols — chain looks empty or stale.")

    # --- per-expiry slices with SVI fits ---
    slices = []
    for expiry, grp in points.groupby("expiry"):
        if len(grp) < 2:
            continue
        F, D, parity = forwards[expiry]
        s = Slice(
            expiry=expiry, T=float(grp["T"].iloc[0]), dte=int(grp["dte"].iloc[0]), F=F, D=D,
            parity_forward=parity, k=grp["k"].to_numpy(), iv=grp["iv"].to_numpy(),
        )
        if s.dte >= MIN_FIT_DAYS:
            spread = (grp["iv_ask"] - grp["iv_bid"]).clip(0.003, 0.2)
            weight = 1.0 / spread
            weight = weight.fillna(0.3 * weight.median() if weight.notna().any() else 1.0)
            fit = fit_svi(s.k, s.iv, s.T, weight.to_numpy())
            s.fit = fit if fit is not None and fit.rmse <= MAX_FIT_RMSE else None
        if s.fit is not None:
            s.atm_iv = float(s.fit.params.iv(0.0, s.T))
            s.iv25c, s.iv25p = _delta_vol(s, 0.25), _delta_vol(s, 0.75)
        elif s.k[0] <= 0 <= s.k[-1]:
            s.atm_iv = float(np.interp(0.0, s.k, s.iv))
        slices.append(s)

    fitted = [s for s in slices if s.fit is not None]
    if len(fitted) < 3:
        raise RuntimeError(f"Only {len(fitted)} expiries produced a usable smile fit.")

    return SurfaceResult(
        slices=slices,
        points=points,
        gex=_gex_contracts(chain, slices),
        grid=_grid(fitted, points, spot),
        calendar=_calendar_violations(fitted),
    )


def _grid(fitted, points, spot, n_x=81, n_t=48):
    """IV on a (DTE, K/S) grid, interpolating total variance linearly in T between SVI slices.

    Coverage is limited to the strikes the market actually quotes, measured in standard
    deviations (z = k / (atm * sqrt(T))) and taken as the median across slices, so the
    covered region is a smooth fan that narrows towards short expiries.

    Returns two layouts of the same model: a rectangular grid masked with NaN outside
    the fan (for the heatmap), and a "fan" grid whose K/S columns are spaced across each
    row's covered range (for the 3D surface, where NaN masking renders as a sawtooth edge).
    """
    lo, hi = np.quantile(points["x"], [0.01, 0.99])
    x_min, x_max = max(lo, 0.7), min(hi, 1.3)
    Ts = np.array([s.T for s in fitted])
    Fs = np.array([s.F for s in fitted])
    atms = np.array([s.atm_iv for s in fitted])
    z_lo = np.median([s.k[0] / (s.atm_iv * np.sqrt(s.T)) for s in fitted])
    z_hi = np.median([s.k[-1] / (s.atm_iv * np.sqrt(s.T)) for s in fitted])
    t_grid = np.geomspace(Ts[0], Ts[-1], n_t)

    def row_iv(t, xs):
        j = min(np.searchsorted(Ts, t, side="right") - 1, len(Ts) - 2)
        lam = np.clip((t - Ts[j]) / (Ts[j + 1] - Ts[j]), 0.0, 1.0)
        w = (1 - lam) * fitted[j].fit.params.w(np.log(xs * spot / Fs[j])) \
            + lam * fitted[j + 1].fit.params.w(np.log(xs * spot / Fs[j + 1]))
        return np.sqrt(np.maximum(w, 1e-12) / t)

    def fan_edges(t):
        F, scale = np.interp(t, Ts, Fs), np.interp(t, Ts, atms) * np.sqrt(t)
        return F / spot * np.exp(z_lo * scale), F / spot * np.exp(z_hi * scale)

    xs = np.linspace(x_min, x_max, n_x)
    rect = np.empty((n_t, n_x))
    fan_x = np.empty((n_t, n_x))
    fan_iv = np.empty((n_t, n_x))
    for i, t in enumerate(t_grid):
        a, b = fan_edges(t)
        rect[i] = row_iv(t, xs)
        rect[i, (xs < a) | (xs > b)] = np.nan
        fan_x[i] = np.linspace(max(a, x_min), min(b, x_max), n_x)
        fan_iv[i] = row_iv(t, fan_x[i])
    for arr in (rect, fan_iv):
        arr[(arr > IV_BAND[1]) | ~np.isfinite(arr)] = np.nan
    return {"x": xs, "dte": t_grid * 365.0, "iv": rect, "fan_x": fan_x, "fan_iv": fan_iv}


def _calendar_violations(fitted, tol=1e-5):
    """Total variance must be non-decreasing in T at fixed k; report slice pairs that cross."""
    out = []
    for a, b in zip(fitted, fitted[1:]):
        lo, hi = max(a.k[0], b.k[0]), min(a.k[-1], b.k[-1])
        if hi <= lo:
            continue
        kk = np.linspace(lo, hi, 101)
        bad = b.fit.params.w(kk) < a.fit.params.w(kk) - tol
        if bad.any():
            out.append({"near": a.expiry.isoformat(), "far": b.expiry.isoformat(), "share": float(bad.mean())})
    return out


def _gex_contracts(chain, slices, max_dte=400):
    """Every contract with open interest, valued off the smile so ITM strikes get sane vols."""
    by_expiry = {s.expiry: s for s in slices}
    g = chain[(chain["open_interest"] > 0) & chain["x"].between(0.5, 1.5) & (chain["dte"] <= max_dte)]
    g = g[g["expiry"].isin(by_expiry.keys())].copy()
    if g.empty:
        return g.assign(iv=[])[["strike", "T", "F", "is_call", "open_interest", "iv", "dte"]]
    g["iv"] = pd.concat(
        [pd.Series(by_expiry[e].iv_at(grp["k"]), index=grp.index) for e, grp in g.groupby("expiry")]
    )
    return g[["strike", "T", "F", "is_call", "open_interest", "iv", "dte"]].dropna().reset_index(drop=True)
