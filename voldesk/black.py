"""Vectorised Black-76 pricing and implied-volatility inversion.

Everything is written against the forward F and discount factor D, so carry
(rates, dividends, borrow) is absorbed into F rather than assumed.
"""

import numpy as np
from scipy.special import ndtr

SIGMA_LO, SIGMA_HI = 1e-4, 5.0


def black76(F, K, T, sigma, is_call, D=1.0):
    F, K, T, sigma, is_call, D = np.broadcast_arrays(
        *(np.asarray(v, dtype=float) for v in (F, K, T, sigma, is_call, D))
    )
    sqrt_t = np.sqrt(np.maximum(T, 1e-12))
    vol = np.maximum(sigma, 1e-12) * sqrt_t
    d1 = (np.log(F / K) + 0.5 * vol**2) / vol
    d2 = d1 - vol
    call = D * (F * ndtr(d1) - K * ndtr(d2))
    put = D * (K * ndtr(-d2) - F * ndtr(-d1))
    return np.where(is_call.astype(bool), call, put)


def implied_vol(price, F, K, T, is_call, D=1.0, iters=60):
    """Bisection on [SIGMA_LO, SIGMA_HI]; NaN where the price is outside the no-arb band.

    Black price is monotone in sigma, so bisection is guaranteed to converge.
    60 halvings of a width-5 bracket is far below quote precision.
    """
    price, F, K, T, is_call, D = np.broadcast_arrays(
        *(np.asarray(v, dtype=float) for v in (price, F, K, T, is_call, D))
    )
    call = is_call.astype(bool)
    intrinsic = D * np.where(call, np.maximum(F - K, 0.0), np.maximum(K - F, 0.0))
    upper = D * np.where(call, F, K)
    valid = np.isfinite(price) & (price > intrinsic + 1e-10) & (price < upper) & (T > 0)

    lo = np.full(price.shape, SIGMA_LO)
    hi = np.full(price.shape, SIGMA_HI)
    valid &= black76(F, K, T, hi, call, D) >= price
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        too_high = black76(F, K, T, mid, call, D) > price
        hi = np.where(too_high, mid, hi)
        lo = np.where(too_high, lo, mid)
    return np.where(valid, 0.5 * (lo + hi), np.nan)


def forward_delta(k, w, is_call=True):
    """Undiscounted forward delta from log-moneyness k = ln(K/F) and total variance w."""
    sw = np.sqrt(np.maximum(w, 1e-12))
    d1 = -k / sw + 0.5 * sw
    return ndtr(d1) if is_call else ndtr(d1) - 1.0
