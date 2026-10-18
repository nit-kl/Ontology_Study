"""レイヤー5 業務画面のサーバー（FastAPI）。デモの操作と、各層の状態を返す。

起動: .venv/Scripts/python -m uvicorn app.server:app --port 8000
"""

from __future__ import annotations

import threading

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config as C
from .demo import Demo

app = FastAPI(title="Ontology Study デモ: UC1〜UC3")
_lock = threading.Lock()
_demo = Demo()

GRAPHS = {"ontology": C.G_ONTOLOGY, "master": C.G_MASTER, "state": C.G_STATE,
          "plans": C.G_PLANS, "policy": C.G_POLICY, "cdc": C.G_CDC}


def _run(action):
    with _lock:
        try:
            action()
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return _demo.state()


@app.get("/api/revision")
def revision():
    """画面が数秒ごとに聞く軽い窓口。変わっていたら /api/state を取り直す。"""
    with _lock:
        return {"instance": id(_demo), "scenario": _demo.scenario, "revision": len(_demo.log_entries),
                "state": _demo.workflow.state}


@app.get("/api/state")
def state():
    with _lock:
        return _demo.state()


@app.post("/api/reset")
def reset():
    """今のシナリオを最初からやり直す。"""
    global _demo
    with _lock:
        _demo = Demo(_demo.scenario)
        return _demo.state()


@app.post("/api/scenario/{scenario}")
def scenario(scenario: str):
    """シナリオ（uc1 / uc2 / uc3）を切り替え、その日付と元データで最初から始める。"""
    global _demo
    with _lock:
        try:
            _demo = Demo(scenario)
        except ValueError as e:
            raise HTTPException(404, str(e))
        return _demo.state()


@app.post("/api/action/{action}")
def action(action: str):
    """ワークフローの操作（start / approve / advance）。今の状態で受け付けないときは 409。"""
    return _run(lambda: _demo.do(action))


# 以前の URL（UC1 の画面とテストが使う）
@app.post("/api/start")
def start():
    return _run(lambda: _demo.do("start"))


@app.post("/api/approve")
def approve():
    return _run(lambda: _demo.do("approve"))


@app.post("/api/advance")
def advance():
    return _run(lambda: _demo.do("advance"))


class SparqlRequest(BaseModel):
    query: str
    inferred: bool = True


@app.post("/api/sparql")
def sparql(req: SparqlRequest):
    with _lock:
        try:
            return {"rows": _demo.sparql(req.query, req.inferred)}
        except Exception as e:  # 構文の誤りなどは、そのまま画面に返す
            raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.get("/api/graph/{name}", response_class=PlainTextResponse)
def graph(name: str):
    if name not in GRAPHS:
        raise HTTPException(404, f"{name} という Named Graph はない")
    with _lock:
        return _demo.kg.turtle(GRAPHS[name])


@app.get("/api/shapes", response_class=PlainTextResponse)
def shapes():
    return ((C.KNOWLEDGE_DIR / "shapes.ttl").read_text(encoding="utf-8") + "\n\n"
            + (C.KNOWLEDGE_DIR / "approval_shapes.ttl").read_text(encoding="utf-8"))


# 画面（web/ を Vite でビルドしたもの）。API より後に登録して、/api を優先する
_DIST = C.ROOT / "web" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")
else:
    @app.get("/", response_class=PlainTextResponse)
    def not_built():
        return "画面がまだビルドされていません。prototype/web で npm install と npm run build を実行してください。"
