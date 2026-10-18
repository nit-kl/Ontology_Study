"""アクションの確定の窓口（レイヤー3 の SHACL と、レイヤー4 の SPARQL Update）。

承認が要らないアクションも、承認付きのアクションも、ここを通らないとストアに入らない。
  1. SHACL の点検（承認の点検を含む）
  2. 合格したら SPARQL Update で、合格した更新の Named Graph に書き込む（同じ主語の古い文は消す）
  3. Update が成功したら、レイヤー5 に監査イベントを渡し、KINETIC に確定イベント（CloudEvents）を出す
不合格や Update の失敗のときは、監査も確定イベントも出さない。
アクションの中身（発注の明細、設備の設定、店間移動、見切り）は問わない。三つ組で渡す。
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Callable

from rdflib import Graph, URIRef

from . import config as C
from .layer3_kg import KnowledgeGraph, ValidationResult
from .layer5_governance import AuditGraph


class ActionGate:
    def __init__(self, kg: KnowledgeGraph, audit: AuditGraph, day: date):
        self.kg = kg
        self.audit = audit
        self.day = day
        self.listeners: list[Callable[[dict], None]] = []
        self.last_update: str = ""

    def pre_validate(self, action: Graph) -> ValidationResult:
        """事前検証。承認の点検は入れない。何も書き換えない。"""
        return self.kg.validate(action)

    def needs_approval(self, action: Graph) -> dict[str, str]:
        """承認の点検だけをかけて、承認が要る主語（末尾の ID）とその理由を返す。"""
        return self.kg.needs_approval(action)

    def confirm(self, action: Graph, subjects: list[URIRef], time: str, agent: URIRef, label: str,
                used: list[URIRef] = (), rule: str | None = None,
                event_type: str = "example.action.confirmed", data: dict | None = None) -> ValidationResult:
        result = self.kg.validate(action, with_approval=True)
        if not result.conforms:
            return result
        self.kg.update(self._update_text(subjects, action))
        self.audit.record(time, label, agent, subjects, sorted(set(used)), rule)
        event = {
            "specversion": "1.0", "id": str(uuid.uuid4()), "source": "layer3/shacl",
            "type": event_type, "time": f"{self.day.isoformat()}T{time}:00", "data": data or {},
        }
        for fn in self.listeners:
            fn(event)
        return result

    def _update_text(self, subjects: list[URIRef], action: Graph) -> str:
        """合格したアクションを、合格した更新の Named Graph に入れる SPARQL Update。古い文は消す。"""
        deletes = "\n".join(f"DELETE WHERE {{ GRAPH <{C.G_PLANS}> {{ <{s}> ?p ?o }} }} ;" for s in subjects)
        body = action.serialize(format="nt")
        self.last_update = f"{deletes}\nINSERT DATA {{ GRAPH <{C.G_PLANS}> {{\n{body}}} }}"
        return self.last_update
