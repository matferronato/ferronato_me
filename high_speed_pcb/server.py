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


def microstrip_z0(w_mm: float, h_mm: float, t_mm: float, er: float) -> float:
    w = max(w_mm, 1e-6)
    h = max(h_mm, 1e-6)
    t = max(t_mm, 1e-6)
    we = w + t / math.pi * (
        1 + math.log(4 * math.e / math.sqrt((t / h) ** 2 + (1 / math.pi / (w / t + 1.1)) ** 2))
    )
    u = we / h
    ee = (er + 1) / 2 + (er - 1) / 2 / math.sqrt(1 + 12 / u)
    if u < 1:
        ee += 0.04 * (1 - u) ** 2
        return (60 / math.sqrt(ee)) * math.log(8 / u + 0.25 * u)
    return 120 * math.pi / (math.sqrt(ee) * (u + 1.393 + 0.667 * math.log(u + 1.444)))


def reflection(z0: float, zl: float) -> dict:
    gamma = -1.0 if zl == 0 else (zl - z0) / (zl + z0)
    rl = math.inf if abs(gamma) < 1e-15 else -20 * math.log10(abs(gamma))
    vswr = math.inf if abs(gamma) >= 1 else (1 + abs(gamma)) / (1 - abs(gamma))
    return {"gamma": gamma, "return_loss_db": rl, "vswr": vswr}


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
                    z0 = microstrip_z0(
                        float(q.get("w", [0.15])[0]),
                        float(q.get("h", [0.12])[0]),
                        float(q.get("t", [0.035])[0]),
                        float(q.get("er", [4.1])[0]),
                    )
                    return self._json({"z0_ohm": z0})
                return self._json({"error": "unknown endpoint"}, 404)
            except (ValueError, OverflowError) as exc:
                return self._json({"error": str(exc)}, 400)
        return super().do_GET()

    def _json(self, obj: dict, code: int = 200):
        body = json.dumps(obj, allow_nan=True).encode()
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
