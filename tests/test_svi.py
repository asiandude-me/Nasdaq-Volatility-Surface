import numpy as np

from voldesk.svi import SVIParams, fit_svi


def test_fit_recovers_a_known_smile():
    true = SVIParams(a=0.004, b=0.06, rho=-0.65, m=0.02, sigma=0.12)
    T = 0.25
    k = np.linspace(-0.35, 0.2, 40)
    iv = true.iv(k, T)
    fit = fit_svi(k, iv, T)
    assert fit is not None
    assert fit.rmse < 1e-4
    assert np.allclose(fit.params.iv(k, T), iv, atol=2e-4)


def test_fit_is_robust_to_a_bad_print():
    true = SVIParams(a=0.01, b=0.1, rho=-0.5, m=0.0, sigma=0.2)
    T = 0.5
    k = np.linspace(-0.4, 0.3, 30)
    iv = true.iv(k, T)
    iv_bad = iv.copy()
    iv_bad[5] += 0.15  # one stale quote 15 vol points off
    fit = fit_svi(k, iv_bad, T)
    clean = np.delete(np.arange(len(k)), 5)
    assert np.abs(fit.params.iv(k[clean], T) - iv[clean]).max() < 0.005


def test_too_few_points_returns_none():
    assert fit_svi(np.array([-0.1, 0.0, 0.1]), np.array([0.25, 0.2, 0.19]), 0.1) is None


def test_durrleman_flags_butterfly_arbitrage():
    clean = SVIParams(a=0.01, b=0.1, rho=-0.5, m=0.0, sigma=0.2)
    assert clean.durrleman_g(np.linspace(-1, 1, 201)).min() > 0
    # Very steep wings with tiny curvature imply a negative density somewhere.
    bad = SVIParams(a=-0.05, b=1.5, rho=-0.95, m=0.0, sigma=0.02)
    assert bad.durrleman_g(np.linspace(-1, 1, 201)).min() < 0
