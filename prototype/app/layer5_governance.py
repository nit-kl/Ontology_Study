"""レイヤー5 ガバナンス。承認と自動の確定の来歴を、PROV-O で監査グラフに残す。

監査グラフはレイヤー3 のストアとは別のまとまり。事実はストア、来歴はここ、と置き場を分ける。
"""

from __future__ import annotations

from itertools import count

from rdflib import RDF, RDFS, Graph, Literal, URIRef
from rdflib.namespace import XSD

from . import config as C
from .config import EX, PROV


class AuditGraph:
    def __init__(self, day):
        self.day = day
        self.g = Graph()
        for prefix, ns in [("prov", PROV), ("ex", EX), ("audit", C.AUDIT), ("line", C.LINE),
                           ("person", C.PERSON), ("model", C.MODEL), ("event", C.EVENT),
                           ("setting", C.SETTING), ("transfer", C.TRANSFER)]:
            self.g.bind(prefix, ns)
        self._ids = count(1)
        self.entries: list[dict] = []

    def record(self, time: str, label: str, agent: URIRef, generated: list[URIRef],
               used: list[URIRef], rule: str | None = None) -> URIRef:
        act = C.AUDIT[f"act-{next(self._ids)}"]
        self.g.add((act, RDF.type, PROV.Activity))
        self.g.add((act, RDFS.label, Literal(label)))
        self.g.add((act, PROV.startedAtTime,
                    Literal(f"{self.day.isoformat()}T{time}:00", datatype=XSD.dateTime)))
        self.g.add((act, PROV.wasAssociatedWith, agent))
        for u in used:
            self.g.add((act, PROV.used, u))
        for e in generated:
            self.g.add((e, PROV.wasGeneratedBy, act))
        if rule:
            self.g.add((act, EX.decidedByRule, Literal(rule)))
        self.entries.append({"time": time, "label": label, "agent": C.local(agent), "rule": rule,
                             "generated": [C.local(x) for x in generated],
                             "used": [C.local(x) for x in used]})
        return act

    def turtle(self) -> str:
        return self.g.serialize(format="turtle")
