import numpy as np

from voldesk.black import black76, implied_vol, forward_delta


def test_implied_vol_round_trips_across_strikes_and_tenors():
    rng = np.random.default_rng(0)
    n = 500
    F = rng.uniform(50, 800, n)
    K = F * np.exp(rng.uniform(-0.4, 0.4, n))
    T = rng.uniform(2 / 365, 2.5, n)
    sigma = rng.uniform(0.08, 0.9, n)
    is_call = rng.random(n) < 0.5
    D = np.exp(-0.04 * T)
    price = black76(F, K, T, sigma, is_call, D)
    # Skip prices too small to carry information (deep OTM, short-dated).
    meaningful = price > 1e-6 * F
    solved = implied_vol(price, F, K, T, is_call, D)
    assert np.allclose(solved[meaningful], sigma[meaningful], atol=1e-6)


def test_put_call_parity():
    F, K, T, sigma, D = 100.0, np.array([80.0, 100.0, 125.0]), 0.5, 0.3, 0.98
    c = black76(F, K, T, sigma, True, D)
    p = black76(F, K, T, sigma, False, D)
    assert np.allclose(c - p, D * (F - K))


def test_prices_outside_no_arbitrage_band_are_nan():
    # Below intrinsic, and above the forward for a call: no vol can produce these.
    iv = implied_vol(np.array([5.0, 120.0]), 110.0, 100.0, 0.25, True, 1.0)
    assert np.isnan(iv).all()


def test_forward_delta_is_half_at_the_money_for_vanishing_variance():
    assert abs(forward_delta(0.0, 1e-10) - 0.5) < 1e-4
    assert abs(forward_delta(0.0, 0.04) - forward_delta(0.0, 0.04, is_call=False) - 1.0) < 1e-12
