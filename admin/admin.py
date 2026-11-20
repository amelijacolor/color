#!/usr/bin/env python3
"""
Private admin panel for the portfolio.

SAFETY MODEL
  * Listens on 127.0.0.1 only -> unreachable from the internet or other devices.
  * It is NOT part of the public site folder (`site/`), so it is never published.
  * Password is stored as a salted PBKDF2-SHA256 hash (never in plain text).
  * Login is rate-limited; sessions are random, HttpOnly, SameSite=Strict, and expire.
  * Every change request needs a CSRF token and a matching Origin/Host (blocks
    other websites and DNS-rebinding from driving your admin in the background).
  * Uploads: whitelisted types, file-signature checked, size-limited, renamed to
    random safe names, written only inside site/assets/.
  * content.json is validated before saving; a timestamped backup is kept on every save.
"""
import datetime
import hashlib
import hmac
import http.server
import json
import mimetypes
import os
import re
import secrets
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(BASE, "site")
ASSETS = os.path.join(SITE, "assets")
CONTENT_FILE = os.path.join(SITE, "content.json")
PRIVATE = os.path.join(BASE, "private")
AUTH_FILE = os.path.join(PRIVATE, "auth.json")
MESSAGES_FILE = os.path.join(PRIVATE, "messages.json")
BACKUPS = os.path.join(PRIVATE, "backups")
UI_DIR = os.path.join(SITE, "admin")

ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
PBKDF2_ITERATIONS = 600_000
SESSION_TTL = 8 * 3600
MIN_PASSWORD = 10
MAX_IMAGE = 30 * 1024 * 1024
MAX_VIDEO = 600 * 1024 * 1024
KEEP_BACKUPS = 40

LOCK = threading.RLock()
SESSIONS = {}                      # token -> {"csrf": str, "expires": float}
LOGIN_FAILS = {"count": 0, "locked_until": 0.0}

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PATH_RE = re.compile(r"^assets/(images|videos)/[A-Za-z0-9._-]{1,140}$")
EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$")
BACKUP_RE = re.compile(r"^content-\d{8}-\d{6}(?:-\d+)?\.json$")

MAGIC = {
    "png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    "jpg": lambda b: b.startswith(b"\xff\xd8\xff"),
    "jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    "webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
    "mp4": lambda b: b[4:8] == b"ftyp",
    "webm": lambda b: b.startswith(b"\x1a\x45\xdf\xa3"),
}
IMAGE_EXT = {"png", "jpg", "jpeg", "webp"}
VIDEO_EXT = {"mp4", "webm"}


# ------------------------------------------------------------------ helpers
def atomic_write(path, data_bytes, mode=None):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(data_bytes)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def hash_password(password, salt=None, iterations=PBKDF2_ITERATIONS):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {"salt": salt.hex(), "hash": digest.hex(), "iterations": iterations}


def verify_password(password, record):
    try:
        salt = bytes.fromhex(record["salt"])
        expected = bytes.fromhex(record["hash"])
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(record["iterations"]))
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def has_password():
    return os.path.exists(AUTH_FILE)


def new_session():
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    with LOCK:
        now = time.time()
        for t in [t for t, s in SESSIONS.items() if s["expires"] < now]:
            SESSIONS.pop(t, None)
        SESSIONS[token] = {"csrf": csrf, "expires": now + SESSION_TTL}
    return token, csrf


# --------------------------------------------------------------- validation
class Invalid(Exception):
    pass


def text(value, limit, field, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise Invalid(f"{field}: must be text")
    value = "".join(ch for ch in value if ch == "\n" or ch >= " ").strip()
    if required and not value:
        raise Invalid(f"{field}: can't be empty")
    if len(value) > limit:
        raise Invalid(f"{field}: too long (max {limit} characters)")
    return value


def media_path(value, field, required=False):
    value = text(value, 200, field, required)
    if value and (not PATH_RE.match(value) or ".." in value):
        raise Invalid(f"{field}: invalid file path")
    return value


def validate_content(data):
    if not isinstance(data, dict):
        raise Invalid("Content must be an object")

    about = text(data.get("about"), 3000, "About text")
    about_image = media_path(data.get("about_image"), "About photo")

    links_in = data.get("links") or {}
    email = text(links_in.get("email"), 254, "Email", required=True)
    if not EMAIL_RE.match(email):
        raise Invalid("Email: not a valid email address")
    instagram = text(links_in.get("instagram"), 300, "Instagram link")
    if instagram and not instagram.startswith("https://"):
        raise Invalid("Instagram link: must start with https://")

    ba_in = data.get("before_after")
    if not isinstance(ba_in, list) or not (1 <= len(ba_in) <= 6):
        raise Invalid("Before & After: add between 1 and 6 films")
    before_after = []
    for i, item in enumerate(ba_in, 1):
        f = f"Before & After #{i}"
        before_after.append({
            "title": text(item.get("title"), 120, f"{f} title", True),
            "camera": text(item.get("camera"), 120, f"{f} camera"),
            "before": media_path(item.get("before"), f"{f} Log image", True),
            "after": media_path(item.get("after"), f"{f} graded image", True),
        })

    pr_in = data.get("projects")
    if not isinstance(pr_in, list) or not (1 <= len(pr_in) <= 60):
        raise Invalid("Films: add between 1 and 60 films")
    projects, seen = [], set()
    for i, p in enumerate(pr_in, 1):
        title = text(p.get("title"), 120, f"Film #{i} title", True)
        f = f"Film “{title}”"
        slug = text(p.get("slug"), 80, f"{f} slug", True)
        if not SLUG_RE.match(slug):
            raise Invalid(f"{f}: invalid slug")
        if slug in seen:
            raise Invalid(f"{f}: duplicate slug")
        seen.add(slug)

        roles_in = p.get("roles") or []
        if not isinstance(roles_in, list) or len(roles_in) > 6:
            raise Invalid(f"{f}: roles must be a short list")
        roles = [text(r, 60, f"{f} role") for r in roles_in if str(r).strip()]

        laurels_in = p.get("laurels") or []
        if not isinstance(laurels_in, list) or len(laurels_in) > 20:
            raise Invalid(f"{f}: up to 20 festivals")
        laurels = []
        for l in laurels_in:
            festival = text(l.get("festival"), 120, f"{f} festival name")
            if not festival:
                continue
            laurels.append({
                "festival": festival,
                "distinction": text(l.get("distinction"), 80, f"{f} festival award/distinction"),
                "year": text(l.get("year"), 12, f"{f} festival year"),
                "qualifying": text(l.get("qualifying"), 80, f"{f} qualifying note"),
                "won": bool(l.get("won", False)),
            })

        try:
            festivals_won = int(p.get("festivals_won", 0) or 0)
        except Exception:
            festivals_won = 0
        festivals_won = max(0, min(99, festivals_won))

        clips_in = p.get("clips") or []
        if not isinstance(clips_in, list) or len(clips_in) > 8:
            raise Invalid(f"{f}: up to 8 clips")
        clips = [media_path(c, f"{f} clip") for c in clips_in if str(c).strip()]

        projects.append({
            "slug": slug,
            "title": title,
            "format": text(p.get("format"), 80, f"{f} format"),
            "camera": text(p.get("camera"), 120, f"{f} camera"),
            "roles": roles,
            "poster": media_path(p.get("poster"), f"{f} cover image", True),
            "preview": media_path(p.get("preview"), f"{f} hover preview video"),
            "notes": text(p.get("notes"), 2000, f"{f} notes"),
            "festivals_won": festivals_won,
            "laurels": laurels,
            "clips": clips,
        })

    hero_in = data.get("hero_slides") or []
    if not isinstance(hero_in, list) or len(hero_in) > 30:
        raise Invalid("Opening Reel: up to 30 images")
    hero_slides = []
    for i, s in enumerate(hero_in, 1):
        img = media_path(s.get("image"), f"Opening Reel #{i} image")
        if not img:
            continue
        hero_slides.append({
            "image": img,
            "label": text(s.get("label"), 120, f"Opening Reel #{i} caption"),
        })

    return {
        "about": about,
        "about_image": about_image,
        "links": {"email": email, "instagram": instagram},
        "hero_slides": hero_slides,
        "before_after": before_after,
        "projects": projects,
    }


def save_content(content):
    with LOCK:
        os.makedirs(BACKUPS, exist_ok=True)
        if os.path.exists(CONTENT_FILE):
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            target = os.path.join(BACKUPS, f"content-{stamp}.json")
            n = 1
            while os.path.exists(target):
                target = os.path.join(BACKUPS, f"content-{stamp}-{n}.json")
                n += 1
            with open(CONTENT_FILE, "rb") as src:
                atomic_write(target, src.read(), 0o600)
        atomic_write(CONTENT_FILE, json.dumps(content, indent=2, ensure_ascii=False).encode("utf-8"))
        backups = sorted(f for f in os.listdir(BACKUPS) if BACKUP_RE.match(f))
        for old in backups[:-KEEP_BACKUPS]:
            try:
                os.remove(os.path.join(BACKUPS, old))
            except OSError:
                pass


# ------------------------------------------------------------------- server
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "AdminPanel"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---- plumbing
    def _security_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; "
            "form-action 'self'; base-uri 'none'",
        )

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload, extra=None):
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json", extra)

    def _host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return False
        return origin in {f"http://{h}" for h in ALLOWED_HOSTS}

    def _session(self):
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "ameli_admin":
                with LOCK:
                    s = SESSIONS.get(v)
                    if s and s["expires"] > time.time():
                        s["expires"] = time.time() + SESSION_TTL
                        return v, s
        return None, None

    def _require_auth(self, write=False):
        token, session = self._session()
        if not session:
            self._json(401, {"error": "Please sign in"})
            return None
        if write:
            if not self._origin_ok() or not hmac.compare_digest(
                self.headers.get("X-CSRF-Token", ""), session["csrf"]
            ):
                self._json(403, {"error": "Blocked: security check failed. Reload the page."})
                return None
        return token, session

    def _body_json(self, limit=2_000_000):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > limit:
            raise Invalid("Request too large or empty")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            raise Invalid("Bad request")
        if not isinstance(data, dict):
            raise Invalid("Bad request")
        return data

    def _cookie(self, token):
        return ("Set-Cookie", f"ameli_admin={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}")

    # ---- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b"Forbidden", "text/plain")
        url = urlparse(self.path)
        path = url.path

        if path in ("/", "/index.html"):
            return self._serve_ui("index.html")
        if path in ("/admin.css", "/admin.js"):
            return self._serve_ui(path[1:])

        if path == "/api/state":
            _, session = self._session()
            return self._json(200, {
                "setup_needed": not has_password(),
                "authed": bool(session),
                "csrf": session["csrf"] if session else None,
            })

        if path.startswith("/media/"):
            if not self._require_auth():
                return
            return self._serve_media(path[len("/media/"):])

        if path == "/api/content":
            if not self._require_auth():
                return
            return self._json(200, read_json(CONTENT_FILE, {}))

        if path == "/api/messages":
            if not self._require_auth():
                return
            return self._json(200, {"messages": read_json(MESSAGES_FILE, [])})

        if path == "/api/backups":
            if not self._require_auth():
                return
            files = sorted((f for f in os.listdir(BACKUPS) if BACKUP_RE.match(f)), reverse=True) if os.path.isdir(BACKUPS) else []
            return self._json(200, {"backups": files})

        if path == "/api/git-status":
            if not self._require_auth():
                return
            return self._git_status()

        self._send(404, b"Not found", "text/plain")

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, b"Forbidden", "text/plain")
        path = urlparse(self.path).path
        try:
            if path == "/api/setup":
                return self._setup()
            if path == "/api/login":
                return self._login()
            if path == "/api/logout":
                return self._logout()
            if path == "/api/content":
                return self._save()
            if path == "/api/upload":
                return self._upload()
            if path == "/api/messages":
                return self._messages_action()
            if path == "/api/password":
                return self._change_password()
            if path == "/api/restore":
                return self._restore()
            if path == "/api/publish":
                return self._publish()
        except Invalid as e:
            return self._json(400, {"error": str(e)})
        except Exception:
            return self._json(500, {"error": "Something went wrong. Nothing was changed."})
        self._send(404, b"Not found", "text/plain")

    # ---- static admin UI
    def _serve_ui(self, name):
        full = os.path.join(UI_DIR, name)
        if not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        with open(full, "rb") as f:
            data = f.read()
        ctype = {"html": "text/html; charset=utf-8", "css": "text/css", "js": "application/javascript"}[name.rsplit(".", 1)[1]]
        self._send(200, data, ctype)

    # ---- media (read-only, only inside site/assets, signed-in only)
    def _serve_media(self, rel):
        rel = rel.replace("\\", "/")
        full = os.path.realpath(os.path.join(SITE, rel))
        if not full.startswith(os.path.realpath(ASSETS) + os.sep) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        size = os.path.getsize(full)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range", "")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                return self._send(416, b"", "text/plain", [("Content-Range", f"bytes */{size}")])
            code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self._security_headers()
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    # ---- auth
    def _setup(self):
        if not self._origin_ok():
            raise Invalid("Blocked")
        if has_password():
            raise Invalid("A password is already set")
        data = self._body_json(10_000)
        password = str(data.get("password", ""))
        if len(password) < MIN_PASSWORD:
            raise Invalid(f"Use at least {MIN_PASSWORD} characters")
        atomic_write(AUTH_FILE, json.dumps(hash_password(password)).encode(), 0o600)
        token, csrf = new_session()
        self._json(200, {"ok": True, "csrf": csrf}, [self._cookie(token)])

    def _login(self):
        if not self._origin_ok():
            raise Invalid("Blocked")
        with LOCK:
            wait = LOGIN_FAILS["locked_until"] - time.time()
        if wait > 0:
            return self._json(429, {"error": f"Too many attempts. Try again in {int(wait) + 1}s."})
        data = self._body_json(10_000)
        record = read_json(AUTH_FILE, None)
        ok = bool(record) and verify_password(str(data.get("password", "")), record)
        with LOCK:
            if ok:
                LOGIN_FAILS.update(count=0, locked_until=0.0)
            else:
                LOGIN_FAILS["count"] += 1
                if LOGIN_FAILS["count"] >= 5:
                    LOGIN_FAILS.update(count=0, locked_until=time.time() + 300)
        if not ok:
            time.sleep(1)
            return self._json(401, {"error": "Wrong password"})
        token, csrf = new_session()
        self._json(200, {"ok": True, "csrf": csrf}, [self._cookie(token)])

    def _logout(self):
        auth = self._require_auth(write=True)
        if not auth:
            return
        with LOCK:
            SESSIONS.pop(auth[0], None)
        self._json(200, {"ok": True}, [("Set-Cookie", "ameli_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")])

    def _change_password(self):
        if not self._require_auth(write=True):
            return
        data = self._body_json(10_000)
        record = read_json(AUTH_FILE, None)
        if not record or not verify_password(str(data.get("current", "")), record):
            raise Invalid("Current password is wrong")
        new = str(data.get("new", ""))
        if len(new) < MIN_PASSWORD:
            raise Invalid(f"Use at least {MIN_PASSWORD} characters")
        atomic_write(AUTH_FILE, json.dumps(hash_password(new)).encode(), 0o600)
        self._json(200, {"ok": True})

    # ---- content
    def _save(self):
        if not self._require_auth(write=True):
            return
        content = validate_content(self._body_json())
        save_content(content)
        self._json(200, {"ok": True, "content": content})

    def _restore(self):
        if not self._require_auth(write=True):
            return
        name = str(self._body_json(10_000).get("name", ""))
        if not BACKUP_RE.match(name):
            raise Invalid("Invalid backup")
        data = read_json(os.path.join(BACKUPS, name), None)
        content = validate_content(data)
        save_content(content)          # current version is backed up first, so this is undoable
        self._json(200, {"ok": True, "content": content})

    # ---- uploads
    def _upload(self):
        if not self._require_auth(write=True):
            return
        q = parse_qs(urlparse(self.path).query)
        kind = (q.get("kind") or [""])[0]
        original = (q.get("name") or [""])[0]
        slug = re.sub(r"[^a-z0-9-]+", "-", (q.get("slug") or ["site"])[0].lower()).strip("-")[:60] or "site"
        purpose = re.sub(r"[^a-z0-9-]+", "-", (q.get("purpose") or ["file"])[0].lower()).strip("-")[:20] or "file"
        ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""

        if kind == "image" and ext in IMAGE_EXT:
            folder, limit = "images", MAX_IMAGE
        elif kind == "video" and ext in VIDEO_EXT:
            folder, limit = "videos", MAX_VIDEO
        else:
            raise Invalid("Unsupported file. Images: PNG, JPG, WEBP. Videos: MP4 (H.264) or WEBM.")

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise Invalid("Empty file")
        if length > limit:
            raise Invalid(f"File too large (max {limit // (1024 * 1024)} MB)")

        dest_dir = os.path.join(ASSETS, folder)
        os.makedirs(dest_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=dest_dir, suffix=".upload")
        remaining, head = length, b""
        try:
            with os.fdopen(fd, "wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise Invalid("Upload interrupted")
                    if len(head) < 16:
                        head += chunk[: 16 - len(head)]
                    out.write(chunk)
                    remaining -= len(chunk)
            if not MAGIC[ext](head):
                raise Invalid("That file doesn't look like a real ." + ext + " file")
            name = f"{slug}-{purpose}-{secrets.token_hex(4)}.{ext}"
            os.replace(tmp, os.path.join(dest_dir, name))
            os.chmod(os.path.join(dest_dir, name), 0o644)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        self._json(200, {"ok": True, "path": f"assets/{folder}/{name}"})

    # ---- messages
    def _messages_action(self):
        if not self._require_auth(write=True):
            return
        data = self._body_json(10_000)
        action, stamp = data.get("action"), str(data.get("received_at", ""))
        with LOCK:
            items = read_json(MESSAGES_FILE, [])
            if action == "delete":
                items = [m for m in items if m.get("received_at") != stamp]
            elif action == "read":
                for m in items:
                    if m.get("received_at") == stamp:
                        m["read"] = True
            else:
                raise Invalid("Unknown action")
            atomic_write(MESSAGES_FILE, json.dumps(items, indent=2, ensure_ascii=False).encode(), 0o600)
        self._json(200, {"ok": True, "messages": items})

    # ---- git publish helper (local admin only)
    def _run_git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=BASE,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def _git_status(self):
        if not os.path.isdir(os.path.join(BASE, ".git")):
            return self._json(200, {"has_remote": False, "remote": "", "branch": "", "changes": ""})
        rem = self._run_git("remote", "get-url", "origin")
        br = self._run_git("rev-parse", "--abbrev-ref", "HEAD")
        st = self._run_git("status", "--short", "site/")
        self._json(200, {
            "has_remote": rem.returncode == 0 and bool(rem.stdout.strip()),
            "remote": rem.stdout.strip(),
            "branch": br.stdout.strip() or "main",
            "changes": st.stdout.strip(),
        })

    def _publish(self):
        if not self._require_auth(write=True):
            return
        if not os.path.isdir(os.path.join(BASE, ".git")):
            raise Invalid("Initialize git and add your GitHub repo remote first.")
        rem = self._run_git("remote", "get-url", "origin")
        if rem.returncode != 0:
            raise Invalid("No GitHub remote ('origin') configured yet.")
        self._run_git("add", "site/")
        st = self._run_git("status", "--short", "site/")
        if not st.stdout.strip():
            return self._json(200, {"ok": True, "message": "Already up to date on GitHub."})
        cm = self._run_git("commit", "-m", "Update portfolio site")
        if cm.returncode != 0:
            raise Invalid(cm.stderr.strip() or cm.stdout.strip() or "Git commit failed")
        push = self._run_git("push")
        if push.returncode != 0:
            raise Invalid(push.stderr.strip() or push.stdout.strip() or "Git push failed")
        self._json(200, {"ok": True, "message": "Pushed to GitHub ✓ Live site updates in ~30–60s."})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    os.makedirs(PRIVATE, exist_ok=True)
    os.makedirs(BACKUPS, exist_ok=True)
    try:
        os.chmod(PRIVATE, 0o700)
    except OSError:
        pass
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Admin panel:   http://127.0.0.1:{PORT}   (private — only on this computer)")
        httpd.serve_forever()
