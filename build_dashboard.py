"""
Build the VolDesk dashboard: a static site with the full QQQ vol picture.

Pipeline: option chain + 3y OHLC + VXN via yfinance -> parity-implied forwards ->
Black-76 implied vols (bid/mid/ask) on OTM quotes -> SVI fit per expiry ->
term structure, 25-delta skew, arbitrage checks, realised-vol estimators and
vol cone -> one JSON payload inlined into site/index.html. GEX, the option
pricer and every chart are computed in the browser from that payload.

Usage:
  python build_dashboard.py [TICKER]            live data (default QQQ)
  python build_dashboard.py --demo              synthetic market, no network needed
  python build_dashboard.py --inline-plotly     bundle Plotly so the page works offline
  python build_dashboard.py --from-json site/data.json   re-render the page only
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from voldesk import site


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ticker", nargs="?", default="QQQ")
    ap.add_argument("--demo", action="store_true", help="use a synthetic market instead of Yahoo Finance")
    ap.add_argument("--out", default="site", help="output directory (default: site)")
    ap.add_argument("--inline-plotly", nargs="?", const="", metavar="PATH",
                    help="inline plotly.min.js (from PATH, or downloaded from the CDN)")
    ap.add_argument("--from-json", metavar="PATH", help="skip data/model steps and re-render from a payload")
    args = ap.parse_args(argv)

    started = time.time()
    if args.from_json:
        payload = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
    else:
        from voldesk.market import load_live, check_snapshot
        from voldesk.demo import load_demo
        from voldesk.surface import build_surface
        from voldesk.payload import build_payload

        print(f"Loading {'demo' if args.demo else 'live'} market for {args.ticker.upper()}...")
        snap = load_demo(args.ticker) if args.demo else load_live(args.ticker)
        check_snapshot(snap)
        print(f"  spot {snap.spot:.2f} | rate {snap.rate:.2%} | {len(snap.chain)} contracts, "
              f"{snap.chain['expiry'].nunique()} expiries | {len(snap.history)} days of history")
        surf = build_surface(snap)
        fitted = sum(s.fit is not None for s in surf.slices)
        print(f"  {len(surf.points)} OTM implied vols | SVI fitted on {fitted}/{len(surf.slices)} expiries "
              f"| {len(surf.calendar)} calendar-arb crossings | {len(surf.gex)} contracts for GEX")
        payload = build_payload(snap, surf, repo=os.environ.get("GITHUB_REPOSITORY"))

    plotly_js = site.load_plotly(args.inline_plotly or None) if args.inline_plotly is not None else None
    target = site.render(payload, Path(args.out), plotly_js)
    print(f"Wrote {target} ({target.stat().st_size / 1e3:.0f} kB) in {time.time() - started:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
