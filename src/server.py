"""ローカル専用のデモサーバー。127.0.0.1 以外では待ち受けない。"""

from __future__ import annotations

import json
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from src.agent import PROMPTS, StoreOpsAgent
from src.graph_store import knowledge_graph
from src.services import Evidence, morning_briefing
from src.settings import DEMO_DIR, HOST, PORT

STATIC = {
    "/": (DEMO_DIR / "index.html", "text/html; charset=utf-8"),
    "/index.html": (DEMO_DIR / "index.html", "text/html; charset=utf-8"),
    "/assets/styles.css": (DEMO_DIR / "styles.css", "text/css; charset=utf-8"),
    "/assets/app.js": (DEMO_DIR / "app.js", "text/javascript; charset=utf-8"),
}

_AGENT: StoreOpsAgent | None = None


def get_agent() -> StoreOpsAgent:
    global _AGENT
    if _AGENT is None:
        _AGENT = StoreOpsAgent()
        knowledge_graph()
    return _AGENT


def bootstrap() -> dict:
    briefing = morning_briefing(Evidence())
    briefing["disclaimer"] = "架空のサンプルです。指令は実機へ送りません。"
    briefing["tripleCount"] = knowledge_graph().triple_count()
    briefing["prompts"] = PROMPTS
    return briefing


class Handler(BaseHTTPRequestHandler):
    server_version = "cp-store-sample"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/bootstrap":
                self._json(200, bootstrap())
                return
            static = STATIC.get(path)
            if static is None:
                self._json(404, {"error": "見つかりません。"})
                return
            file_path, content_type = static
            body = file_path.read_bytes()
            self._bytes(200, body, content_type)
        except FileNotFoundError as exc:
            self._json(500, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            self._json(500, {"error": "処理に失敗しました。サーバーのログを確認してください。"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/api/ask":
            self._json(404, {"error": "見つかりません。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "リクエストが不正です。"})
            return
        if length <= 0 or length > 8000:
            self._json(400, {"error": "質問のサイズが不正です。"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "JSONとして読めません。"})
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("question", ""), str):
            self._json(400, {"error": "question に文字列を渡してください。"})
            return
        try:
            self._json(200, get_agent().ask(payload.get("question", "")))
        except FileNotFoundError as exc:
            self._json(500, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            self._json(500, {"error": "処理に失敗しました。サーバーのログを確認してください。"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._bytes(status, body, "application/json; charset=utf-8")

    def _bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def make_server(port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((HOST, port), Handler)


def main() -> None:
    get_agent()
    server = make_server(PORT)
    print(f"デモを起動しました: http://{HOST}:{PORT}")
    print("停止するには Ctrl+C を押します。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("停止しました。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
