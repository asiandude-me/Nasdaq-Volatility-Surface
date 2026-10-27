"""End-to-end on the synthetic market: data -> surface -> payload -> rendered page."""

import json

import numpy as np
import pandas as pd
import pytest

from voldesk import demo, site
from voldesk.payload import build_payload
from voldesk.realized import realized_vol
from voldesk.surface import build_surface


@pytest.fixture(scope="module")
def built():
    snap = demo.load_demo(seed=3)
    surf = build_surface(snap)
    return snap, surf, build_payload(snap, surf, repo="owner/repo")


def test_parity_forwards_recover_the_carry(built):
    snap, surf, _ = built
    for s in surf.slices:
        if s.dte >= 2:
            expected = snap.spot * np.exp((demo.RATE - demo.DIV_YIELD) * s.T)
            assert s.parity_forward
            assert abs(s.F / expected - 1) < 2e-3


def test_smiles_fit_cleanly(built):
    _, surf, _ = built
    fitted = [s for s in surf.slices if s.fit is not None]
    assert len(fitted) >= 0.9 * len([s for s in surf.slices if s.dte >= 2])
    assert max(s.fit.rmse for s in fitted) < 0.005
    # Equity-style skew: puts over calls at every tenor.
    assert all(s.rr25 < 0 for s in fitted)


def test_payload_is_strict_json_and_self_consistent(built):
    snap, surf, payload = built
    text = json.dumps(payload, allow_nan=False)
    assert len(text) < 2_000_000
    assert payload["meta"]["demo"] is True
    assert len(payload["points"]["iv"]) == len(surf.points)
    grid = payload["surface"]
    assert len(grid["fan_iv"]) == len(grid["dte"]) and len(grid["fan_iv"][0]) == len(grid["x"])
    assert all(v is not None for row in grid["fan_iv"] for v in row)
    assert 0.05 < payload["summary"]["iv30"] < 0.6


def test_render_inlines_everything(built, tmp_path):
    *_, payload = built
    out = site.render(payload, tmp_path)
    html = out.read_text()
    for placeholder in ('href="styles.css"', 'src="data.js"', 'src="app.js"'):
        assert placeholder not in html
    assert "window.VOLDESK=" in html
    assert (tmp_path / "data.json").exists()


def test_realised_estimators_recover_a_known_vol():
    rng = np.random.default_rng(1)
    sigma, n, steps = 0.25, 2000, 390  # one-minute bars
    dt_step = 1 / (252 * steps)
    paths = np.cumsum(rng.normal(0, sigma * np.sqrt(dt_step), (n, steps)), axis=1)
    # Opens continue from the prior close (no overnight gap), so every estimator targets sigma.
    base = np.concatenate([[0.0], np.cumsum(paths[:-1, -1])])
    logp = base[:, None] + paths
    ohlc = pd.DataFrame({
        "open": np.exp(base), "high": np.exp(np.maximum(logp.max(1), base)),
        "low": np.exp(np.minimum(logp.min(1), base)), "close": np.exp(logp[:, -1]),
    })
    for method in ("c2c", "parkinson", "garman_klass", "yang_zhang"):
        est = realized_vol(ohlc, 252, method).dropna().mean()
        # Discrete sampling biases range estimators slightly low.
        assert abs(est - sigma) < 0.02, (method, est)
