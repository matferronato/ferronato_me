#!/usr/bin/env python3
"""Tiny zero-dependency server for the Signal Integrity Visual Lab.

Serves the static website and exposes a few JSON endpoints so you can reuse the
same first-order calculations in your own scripts.
"""
from __future__ import annotations

import json
import math
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))


def microstrip_model(w: float, h: float, t: float, er: float) -> dict:
    if not all(math.isfinite(v) for v in (w, h, t, er)) or w <= 0 or h <= 0 or t < 0 or er < 1:
        raise ValueError("Invalid microstrip dimensions or dielectric constant")
    u, tau = w / h, t / h
    du1 = 0 if tau == 0 else tau / math.pi * math.log1p(4 * math.e * math.tanh(math.sqrt(6.517 * u)) ** 2 / tau)
    dur = du1 / 2 * (1 + 1 / math.cosh(math.sqrt(er - 1)))
    u1, ur = u + du1, u + dur
    def air(v):
        fu = 6 + (2 * math.pi - 6) * math.exp(-((30.666 / v) ** .7528))
        return 376.730313668 / (2 * math.pi) * math.log(fu / v + math.sqrt(1 + 4 / v ** 2))
    a = 1 + math.log((ur ** 4 + (ur / 52) ** 2) / (ur ** 4 + .432)) / 49 + math.log1p((ur / 18.1) ** 3) / 18.7
    b = .564 * ((er - .9) / (er + 3)) ** .053
    er0 = (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / ur) ** (-a * b)
    z0 = air(ur) / math.sqrt(er0)
    ee = er0 * (air(u1) / air(ur)) ** 2
    return {"z0_ohm": z0, "epsilon_eff": ee, "vp_mm_ns": 299.792458 / math.sqrt(ee), "model": "Hammerstad-Jensen quasi-static"}


def microstrip_z0(w_mm: float, h_mm: float, t_mm: float, er: float) -> float:
    return microstrip_model(w_mm, h_mm, t_mm, er)["z0_ohm"]


def reflection(z0: float, zl: float) -> dict:
    if not math.isfinite(z0) or z0 <= 0 or math.isnan(zl) or zl < 0:
        raise ValueError("Require finite Z0 > 0 and ZL >= 0")
    gamma = 1.0 if math.isinf(zl) else (zl - z0) / (zl + z0)
    matched = gamma == 0
    total = abs(gamma) == 1
    return {"gamma": gamma,
            "return_loss_db": None if matched else -20 * math.log10(abs(gamma)),
            "return_loss_infinite": matched,
            "vswr": None if total else (1 + abs(gamma)) / (1 - abs(gamma)),
            "vswr_infinite": total}


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        clean = urlparse(path).path.lstrip("/") or "index.html"
        return os.path.join(ROOT, clean)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            try:
                q = parse_qs(u.query)
                if u.path == "/api/health":
                    return self._json({"ok": True, "engine": "python"})
                if u.path == "/api/reflection":
                    return self._json(reflection(float(q.get("z0", [50])[0]), float(q.get("zl", [50])[0])))
                if u.path == "/api/microstrip":
                    result = microstrip_model(
                        float(q.get("w", [0.15])[0]),
                        float(q.get("h", [0.12])[0]),
                        float(q.get("t", [0.035])[0]),
                        float(q.get("er", [4.1])[0]),
                    )
                    return self._json(result)
                return self._json({"error": "unknown endpoint"}, 404)
            except (ValueError, OverflowError) as exc:
                return self._json({"error": str(exc)}, 400)
        return super().do_GET()

    def _json(self, obj: dict, code: int = 200):
        body = json.dumps(obj, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    os.chdir(ROOT)
    port = int(os.environ.get("PORT", "8421"))
    print(f"SI Studio: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
