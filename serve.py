#!/usr/bin/env python3
"""
Public site server (preview).

Serves ONLY the `site/` folder — nothing else on disk is reachable from here.
The admin panel, password file, backups and messages live outside `site/`.
Also receives contact-form messages at POST /api/contact and stores them in
private/messages.json (read them from the admin panel).
"""
import datetime
import http.server
import json
import os
import re
import socketserver
import sys
import tempfile
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site")
PRIVATE = os.path.join(ROOT, "private")
MESSAGES = os.path.join(PRIVATE, "messages.json")
LOCK = threading.Lock()
RECENT = {}                       # ip -> [timestamps] (simple rate limit)
EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$")


def clean(value, limit):
    value = str(value or "")
    value = "".join(ch for ch in value if ch == "\n" or ch >= " ")
    return value.strip()[:limit]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/contact":
            return self._json(404, {"ok": False})

        ip = self.client_address[0]
        now = time.time()
        with LOCK:
            hits = [t for t in RECENT.get(ip, []) if now - t < 600]
            if len(hits) >= 5:
                return self._json(429, {"ok": False, "error": "too many messages"})
            RECENT[ip] = hits + [now]

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20_000:
                return self._json(413, {"ok": False})
            payload = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except Exception:
            return self._json(400, {"ok": False})

        name = clean(payload.get("name"), 120)
        email = clean(payload.get("email"), 254)
        message = clean(payload.get("message"), 5000)
        if not name or not message or not EMAIL_RE.match(email):
            return self._json(400, {"ok": False})

        entry = {
            "received_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "name": name,
            "email": email,
            "message": message,
            "read": False,
        }
        os.makedirs(PRIVATE, exist_ok=True)
        with LOCK:
            try:
                with open(MESSAGES, "r", encoding="utf-8") as f:
                    items = json.load(f)
                if not isinstance(items, list):
                    items = []
            except Exception:
                items = []
            items.append(entry)
            fd, tmp = tempfile.mkstemp(dir=PRIVATE, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(items, f, indent=2, ensure_ascii=False)
            os.replace(tmp, MESSAGES)
            os.chmod(MESSAGES, 0o600)
        self._json(200, {"ok": True})

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Site preview:  http://127.0.0.1:{PORT}")
        httpd.serve_forever()
