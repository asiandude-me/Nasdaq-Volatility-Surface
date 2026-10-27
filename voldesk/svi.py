"""Raw SVI smile fitting (Gatheral 2004) with a static-arbitrage diagnostic.

Total implied variance w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2)),
with k = ln(K / F). Fitted per expiry in implied-vol space, weighted by quote
quality, with a robust loss so a few stale prints cannot drag the smile.
"""

from dataclasses import dataclass, asdict

import numpy as np
from scipy.optimize import least_squares, minimize

MIN_POINTS = 6


@dataclass
class SVIParams:
    a: float
    b: float
    rho: float
    m: float
    sigma: float

    def w(self, k):
        k = np.asarray(k, dtype=float)
        return self.a + self.b * (self.rho * (k - self.m) + np.sqrt((k - self.m) ** 2 + self.sigma**2))

    def iv(self, k, T):
        return np.sqrt(np.maximum(self.w(k), 1e-12) / T)

    def durrleman_g(self, k):
        """Risk-neutral density is non-negative iff g(k) >= 0 (no butterfly arbitrage)."""
        k = np.asarray(k, dtype=float)
        x = k - self.m
        root = np.sqrt(x**2 + self.sigma**2)
        w = np.maximum(self.w(k), 1e-12)
        w1 = self.b * (self.rho + x / root)
        w2 = self.b * self.sigma**2 / root**3
        return (1 - k * w1 / (2 * w)) ** 2 - (w1**2 / 4) * (1 / w + 0.25) + w2 / 2

    def to_dict(self):
        return {key: round(float(v), 8) for key, v in asdict(self).items()}


@dataclass
class SVIFit:
    params: SVIParams
    rmse: float  # vol points (0.01 = 1 vol point), unweighted
    min_g: float


PENALTY = 10.0


def _residuals(p, k, iv, T, sqrt_wt):
    a, b, rho, m, sigma = p
    w = a + b * (rho * (k - m) + np.sqrt((k - m) ** 2 + sigma**2))
    model = np.sqrt(np.maximum(w, 1e-12) / T)
    # Penalise negative minimum variance, which would put the smile through zero.
    floor = a + b * sigma * np.sqrt(1 - rho**2)
    penalty = PENALTY * max(0.0, -floor) / max(T, 1e-4)
    return np.append((model - iv) * sqrt_wt, penalty)


def _jacobian(p, k, iv, T, sqrt_wt):
    a, b, rho, m, sigma = p
    x = k - m
    root = np.sqrt(x**2 + sigma**2)
    w = a + b * (rho * x + root)
    dw = np.column_stack([np.ones_like(k), rho * x + root, b * x, -b * (rho + x / root), b * sigma / root])
    scale = np.where(w > 1e-12, sqrt_wt / (2 * np.sqrt(np.maximum(w, 1e-12) * T)), 0.0)
    jac = dw * scale[:, None]
    s = np.sqrt(1 - rho**2)
    floor_row = np.zeros(5)
    if a + b * sigma * s < 0:
        floor_row = -PENALTY / max(T, 1e-4) * np.array([1.0, sigma * s, -b * sigma * rho / s, 0.0, b * s])
    return np.vstack([jac, floor_row])


def _quasi_explicit(k, w, wt, span):
    """Zeliade (2009): for fixed (m, sigma) SVI is linear in (a, b*rho*sigma, b*sigma)."""
    sw = np.sqrt(wt / wt.mean())

    def inner(m, sig):
        y = (k - m) / sig
        A = np.column_stack([np.ones_like(y), y, np.sqrt(y * y + 1)])
        coef = np.linalg.lstsq(A * sw[:, None], w * sw, rcond=None)[0]
        return coef, float(np.sum((sw * (A @ coef - w)) ** 2))

    best_p, best_cost = None, np.inf
    for m0, s0 in ((0.0, 0.1 * span), (float(k[np.argmin(w)]), 0.3 * span)):
        res = minimize(lambda p: inner(p[0], np.exp(p[1]))[1], [m0, np.log(max(s0, 1e-3))],
                       method="Nelder-Mead", options={"xatol": 1e-6, "fatol": 1e-16, "maxiter": 400})
        if res.fun < best_cost:
            best_p, best_cost = res.x, res.fun
    m, sig = best_p[0], float(np.exp(best_p[1]))
    a, d, c = inner(m, sig)[0]
    c = max(c, 1e-6)
    return [a, c / sig, float(np.clip(d / c, -0.99, 0.99)), m, sig]


def fit_svi(k, iv, T, weights=None):
    """Return an SVIFit, or None when the slice is too sparse to pin down five parameters."""
    k = np.asarray(k, dtype=float)
    iv = np.asarray(iv, dtype=float)
    if len(k) < MIN_POINTS or np.ptp(k) < 1e-3:
        return None
    wt = np.ones_like(k) if weights is None else np.asarray(weights, dtype=float)
    sqrt_wt = np.sqrt(wt / wt.mean())

    w_obs = iv**2 * T
    span = max(np.ptp(k), 0.02)
    lower = [-max(w_obs.max(), 1e-4), 1e-6, -0.999, k.min() - span, 1e-4]
    upper = [w_obs.max() * 2 + 1e-4, 4.0, 0.999, k.max() + span, 2.0]

    # Seed from the quasi-explicit fit (fast, total-variance space), plus one generic
    # start in case it lands somewhere odd; polish both in vol space with a robust loss.
    vega_wt = wt / (2 * T * iv) ** 2  # vol-space weights mapped to total-variance space
    seeds = [_quasi_explicit(k, w_obs, vega_wt, span), [float(np.min(w_obs)) * 0.9, 0.1, -0.5, 0.0, 0.2 * span]]
    best = None
    for x0 in seeds:
        x0 = np.clip(x0, np.add(lower, 1e-9), np.subtract(upper, 1e-9))
        try:
            res = least_squares(
                _residuals, x0, jac=_jacobian, args=(k, iv, T, sqrt_wt), bounds=(lower, upper),
                loss="soft_l1", f_scale=0.01, x_scale="jac", max_nfev=300,
            )
        except (ValueError, np.linalg.LinAlgError):
            continue
        if best is None or res.cost < best.cost:
            best = res
    if best is None:  # hitting max_nfev is fine; the caller judges fit quality by rmse
        return None

    params = SVIParams(*best.x)
    rmse = float(np.sqrt(np.mean((params.iv(k, T) - iv) ** 2)))
    grid = np.linspace(k.min(), k.max(), 201)
    return SVIFit(params=params, rmse=rmse, min_g=float(params.durrleman_g(grid).min()))
