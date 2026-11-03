#!/usr/bin/env python3
"""Voice Mirror local server.

Serves the practice app at http://127.0.0.1:<port>/ and forwards
text-to-speech requests to ElevenLabs, so your API key stays in a
local .env file instead of the browser.

Standard library only. Python 3.8+.
Usage: python server.py [--no-browser]
"""
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
ENV_FILE = ROOT / ".env"
API = "https://api.elevenlabs.io/v1"
OUTPUT_FORMAT = "mp3_44100_128"
DEFAULT_PORT = 8765
MAX_BODY = 32 * 1024
TIMEOUT = 90
# App files served as-is (anything not listed here is never exposed, so .env stays private).
STATIC = {
    "/drive.js": "text/javascript; charset=utf-8",
    "/config.js": "text/javascript; charset=utf-8",
    "/sw.js": "text/javascript; charset=utf-8",
    "/manifest.webmanifest": "application/manifest+json",
    "/icons/icon-192.png": "image/png",
    "/icons/icon-512.png": "image/png",
}


def read_env():
    """Read .env next to this file; real environment variables win."""
    env = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "PORT"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def write_env(key, voice=""):
    ENV_FILE.write_text(
        f"ELEVENLABS_API_KEY={key}\nELEVENLABS_VOICE_ID={voice}\n", encoding="utf-8"
    )
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "VoiceMirror/1.0"

    # Only log API calls, and never log headers (they carry the key).
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _host_ok(self):
        # Blocks DNS-rebinding: only answer requests addressed to this machine.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost", "::1")

    def _send(self, status, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _api_key(self):
        return read_env().get("ELEVENLABS_API_KEY") or self.headers.get("xi-api-key", "").strip()

    def _upstream(self, method, path, body=None, accept="application/json"):
        key = self._api_key()
        if not key:
            return self._send(401, {"detail": "No ElevenLabs API key. Add ELEVENLABS_API_KEY to the .env file next to server.py and restart, or paste a key in Settings."})
        headers = {"xi-api-key": key, "Accept": accept}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = Request(API + path, data=body, headers=headers, method=method)
        try:
            with urlopen(req, timeout=TIMEOUT) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", accept))
        except HTTPError as e:
            data = e.read() or json.dumps({"detail": str(e.reason)}).encode("utf-8")
            self._send(e.code, data, e.headers.get("Content-Type") or "application/json")
        except URLError as e:
            self._send(502, {"detail": f"Could not reach ElevenLabs: {e.reason}"})
        except OSError as e:  # includes socket timeouts
            self._send(504, {"detail": f"ElevenLabs did not answer in time ({e})."})

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"detail": "Forbidden"})
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._send(200, INDEX.read_bytes(), "text/html; charset=utf-8")
        if path in STATIC:
            f = ROOT / path.lstrip("/")
            if f.is_file():
                return self._send(200, f.read_bytes(), STATIC[path])
        if path == "/api/config":
            env = read_env()
            return self._send(200, {
                "proxy": True,
                "hasKey": bool(env.get("ELEVENLABS_API_KEY")),
                "voiceId": env.get("ELEVENLABS_VOICE_ID", ""),
            })
        if path == "/api/voices":
            return self._upstream("GET", "/voices")
        self._send(404, {"detail": "Not found"})

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"detail": "Forbidden"})
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/tts/"):
            return self._send(404, {"detail": "Not found"})
        voice = unquote(path[len("/api/tts/"):])
        if not voice or "/" in voice:
            return self._send(400, {"detail": "Missing or invalid voice ID."})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._send(413 if n > MAX_BODY else 400, {"detail": "Request body is empty or too large."})
        body = self.rfile.read(n)
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict) or not str(payload.get("text", "")).strip():
                raise ValueError
        except ValueError:
            return self._send(400, {"detail": "Body must be JSON with a non-empty 'text'."})
        self._upstream(
            "POST",
            f"/text-to-speech/{quote(voice, safe='')}?output_format={OUTPUT_FORMAT}",
            body,
            accept="audio/mpeg",
        )


def first_run_setup(env):
    if env.get("ELEVENLABS_API_KEY") or not sys.stdin or not sys.stdin.isatty():
        return
    print("No ElevenLabs API key found.")
    key = input("Paste your API key (or press Enter to add it in the browser instead): ").strip()
    if not key:
        return
    voice = input("Voice ID of your clone (optional, press Enter to pick it in the app): ").strip()
    write_env(key, voice)
    print(f"Saved to {ENV_FILE}.\n")


def main():
    if not INDEX.exists():
        sys.exit(f"index.html not found next to {Path(__file__).name}.")
    env = read_env()
    first_run_setup(env)
    env = read_env()

    port = int(env.get("PORT") or DEFAULT_PORT)
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit(f"No free port between {port} and {port + 19}.")

    actual = httpd.server_address[1]
    url = f"http://127.0.0.1:{actual}/"
    print(f"Voice Mirror is running at {url}")
    if actual != port:
        print(f"(Port {port} was busy. Progress is saved per port, so close the other program to keep your history.)")
    print("Keep this window open while you practise. Press Ctrl+C to stop.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
