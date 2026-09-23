"""Verify the actual Caddy ingress against a disposable local echo server."""

import argparse
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]


class EchoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "ip": self.headers.get("X-Forwarded-For"),
            "proto": self.headers.get("X-Forwarded-Proto"),
            "forwarded": self.headers.get("Forwarded"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def check(caddy, upstream_port, trusted):
    port = free_port()
    source = (ROOT / "deploy/Caddyfile").read_text()
    # 只替换测试端口与上游；路由、信任链和 header_up 使用实际配置。
    source = source.replace("{\n", "{\n    admin off\n", 1)
    source = source.replace("api:8000", f"127.0.0.1:{upstream_port}")
    with tempfile.TemporaryDirectory(prefix="atlas-caddy-check-") as directory:
        root = Path(directory)
        config = root / "Caddyfile"
        config.write_text(source)
        env = {**os.environ, "SITE_ADDRESS": f"http://127.0.0.1:{port}",
               "CADDY_TRUSTED_PROXY_CIDRS": trusted,
               "XDG_DATA_HOME": str(root / "data"), "XDG_CONFIG_HOME": str(root / "config")}
        opener = build_opener(ProxyHandler({}))
        with (root / "caddy.log").open("w+") as log:
            process = subprocess.Popen([caddy, "run", "--config", str(config), "--adapter", "caddyfile"],
                                       env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with opener.open(f"http://127.0.0.1:{port}/api/ready/", timeout=1):
                            break
                    except URLError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Caddy did not become ready") from None
                        time.sleep(0.05)

                is_trusted = trusted.startswith("127.0.0.1/32")
                cases = [
                    (None, "127.0.0.1"),
                    ("198.51.100.17, 203.0.113.24", "203.0.113.24" if is_trusted else "127.0.0.1"),
                    ("198.51.100.17, 2001:db8::24", "2001:db8::24" if is_trusted else "127.0.0.1"),
                    ("not-an-ip", "127.0.0.1"),
                ]
                for path in ("/api/ready/", "/api/feedback/", "/admin/login/"):
                    for forwarded, expected in cases:
                        headers = {"CF-Connecting-IP": "192.0.2.99", "X-Forwarded-Proto": "https",
                                   "Forwarded": "for=192.0.2.99;proto=https"}
                        if forwarded is not None:
                            headers["X-Forwarded-For"] = forwarded
                        with opener.open(Request(f"http://127.0.0.1:{port}{path}", headers=headers), timeout=3) as response:
                            result = json.load(response)
                            assert result == {"ip": expected, "proto": "http", "forwarded": None}, (trusted, path, result)
                            assert response.headers["Cache-Control"] == "no-store"
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy", default="caddy", help="Path to a Caddy executable (2.8 or newer)")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler) as upstream:
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            for trusted in ("", "192.0.2.0/24", "127.0.0.1/32 ::1/128"):
                check(args.caddy, upstream.server_address[1], trusted)
        finally:
            upstream.shutdown()
            thread.join()
    print("Caddy ingress: 36 checks passed (direct, untrusted proxy, trusted proxy; IPv4/IPv6 and spoofed headers)")


if __name__ == "__main__":
    main()
