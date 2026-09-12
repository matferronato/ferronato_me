#!/usr/bin/env python3
"""Static file server for ScopeLab. Standard library only."""

import argparse
import errno
import mimetypes
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TITLE = "ScopeLab"
DEFAULT_PORT = 8781

# ES modules must arrive with a JavaScript media type or the browser refuses them.
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Edit a file, hit reload, see the edit.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/favicon"):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))


def bind(host, port, tries=20):
    """Take the requested port, or the next free one after it."""
    for candidate in range(port, port + tries):
        try:
            return ThreadingHTTPServer((host, candidate), Handler), candidate
        except OSError as err:
            if err.errno != errno.EADDRINUSE:
                raise
            print("port %d busy, trying %d" % (candidate, candidate + 1))
    raise SystemExit("No free port in %d..%d" % (port, port + tries - 1))


def main():
    ap = argparse.ArgumentParser(description="Serve %s locally." % TITLE)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true", help="open a browser window")
    args = ap.parse_args()

    os.chdir(ROOT)
    server, port = bind(args.host, args.port)
    url = "http://%s:%d" % (args.host, port)
    print("%s on %s   (ctrl-c to stop)" % (TITLE, url))
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
