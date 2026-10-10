"""TTLをローカルのグラフとして読み、定義済みSPARQLを実行する。

このクラスがグラフDBとの境目です。いまは rdflib のメモリグラフですが、
同じクエリファイルを Apache Jena Fuseki などのSPARQLエンドポイントへ送る実装に
差し替えられます。TTLが正本なので、載せ替え先でもデータは同じです。
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from decimal import Decimal

from rdflib import Graph

from src.settings import ONTOLOGY_PATH, QUERY_DIR, STORE_CODE


def _python_term(term):
    if term is None:
        return None
    value = term.toPython() if hasattr(term, "toPython") else str(term)
    if isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _rows(result) -> list[dict]:
    variables = [str(name) for name in result.vars]
    rows = []
    for binding in result:
        rows.append({name: _python_term(binding[name]) for name in variables})
    return rows


class KnowledgeGraph:
    def __init__(self, path=ONTOLOGY_PATH):
        self.graph = Graph()
        self.graph.parse(path, format="turtle")
        self._lock = threading.Lock()

    def triple_count(self) -> int:
        return len(self.graph)

    def query_file(self, name: str) -> tuple[list[dict], str]:
        text = (QUERY_DIR / name).read_text(encoding="utf-8")
        text = text.replace("{{STORE_CODE}}", STORE_CODE)
        return self.query_text(text), text

    def query_text(self, sparql: str) -> list[dict]:
        with self._lock:
            return _rows(self.graph.query(sparql))


_GRAPH: KnowledgeGraph | None = None


def knowledge_graph() -> KnowledgeGraph:
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = KnowledgeGraph()
    return _GRAPH
