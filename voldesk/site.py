"""Render the static site: web/ sources with the data payload inlined into one HTML file."""

import json
import urllib.request
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
PLOTLY_URL = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@3.7.0/plotly.min.js"


def _script_safe(text: str) -> str:
    # A literal "</script" inside inline JS/JSON would end the tag early.
    return text.replace("</", "<\\/")


def render(payload: dict, out_dir: Path, plotly_js: str | None = None) -> Path:
    """Write out_dir/index.html (self-contained apart from Plotly unless plotly_js is given)."""
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    css = (WEB_DIR / "styles.css").read_text(encoding="utf-8")
    js = (WEB_DIR / "app.js").read_text(encoding="utf-8")
    data = json.dumps(payload, separators=(",", ":"), allow_nan=False)

    replacements = {
        '<link rel="stylesheet" href="styles.css">': f"<style>\n{css}</style>",
        '<script src="data.js"></script>': f"<script>window.VOLDESK={_script_safe(data)};</script>",
        '<script src="app.js"></script>': f"<script>\n{_script_safe(js)}</script>",
    }
    if plotly_js is not None:
        replacements[f'<script src="{PLOTLY_URL}"></script>'] = f"<script>{_script_safe(plotly_js)}</script>"
    for needle, value in replacements.items():
        if needle not in html:
            raise RuntimeError(f"web/index.html is missing the placeholder {needle!r}")
        html = html.replace(needle, value)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "data.json").write_text(data, encoding="utf-8")
    target = out_dir / "index.html"
    target.write_text(html, encoding="utf-8")
    return target


def load_plotly(path: str | None) -> str:
    if path:
        return Path(path).read_text(encoding="utf-8")
    with urllib.request.urlopen(PLOTLY_URL, timeout=60) as resp:
        return resp.read().decode("utf-8")
