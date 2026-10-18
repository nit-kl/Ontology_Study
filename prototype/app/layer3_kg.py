"""レイヤー3 ナレッジグラフ（GraphDB / Stardog / Neptune の代わりに rdflib）。

- RDF トリプルストア: rdflib の Dataset。Named Graph に分けて置く
- OWL 推論: owlrl（OWL 2 RL）。問い合わせのたびに、ストアのコピーの上で推論する。推論の結果はストアに足さない
- GeoSPARQL: geof:distance を SPARQL の関数として登録する（点と点の距離だけ）
- SHACL: pySHACL。事前検証と、承認を足した再検証
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import owlrl
from pyshacl import validate
from rdflib import Dataset, Graph, Literal, URIRef
from rdflib.namespace import SH, XSD
from rdflib.plugins.sparql.operators import register_custom_function

from . import config as C


# ---- GeoSPARQL の距離（点と点、点と線。単位はメートルかキロメートル） -----------------------

_COORDS = re.compile(r"([-\d.]+)\s+([-\d.]+)")


def _parse_wkt(lit) -> list[tuple[float, float]]:
    """POINT か LINESTRING の WKT を、(経度, 緯度) の並びにする。"""
    return [(float(a), float(b)) for a, b in _COORDS.findall(str(lit).split("(", 1)[1])]


def _haversine(p1, p2) -> float:
    (lon1, lat1), (lon2, lat2) = p1, p2
    r = 6_371_000
    a, b = math.radians(lat1), math.radians(lat2)
    h = math.sin((b - a) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _point_to_segment(p, a, b) -> float:
    """点と線分の距離。数 km の範囲なので、点のまわりを平面とみなして射影する。"""
    k = math.cos(math.radians(p[1]))
    ax, ay, bx, by = (a[0] - p[0]) * k, a[1] - p[1], (b[0] - p[0]) * k, b[1] - p[1]
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    nearest = (p[0] + (ax + t * dx) / k, p[1] + ay + t * dy)
    return _haversine(p, nearest)


def _geof_distance(a, b, uom=None):
    pa, pb = _parse_wkt(a), _parse_wkt(b)
    if len(pa) > 1 and len(pb) == 1:
        pa, pb = pb, pa
    if len(pb) == 1:
        meters = _haversine(pa[0], pb[0])
    else:
        meters = min(_point_to_segment(pa[0], pb[i], pb[i + 1]) for i in range(len(pb) - 1))
    value = meters / 1000 if uom is not None and str(uom).endswith("kilometre") else meters
    return Literal(round(value, 3), datatype=XSD.double)


try:
    register_custom_function(C.GEOF.distance, _geof_distance)
except ValueError:
    pass  # すでに登録済み（テストで何度も読み込むとき）


@dataclass
class ValidationResult:
    conforms: bool
    results: list[dict] = field(default_factory=list)
    shapes: str = "事前検証"


class KnowledgeGraph:
    def __init__(self):
        self.ds = Dataset(default_union=True)
        self.ds.graph(C.G_ONTOLOGY).parse(C.KNOWLEDGE_DIR / "ontology.ttl")
        self.ds.graph(C.G_POLICY).parse(C.KNOWLEDGE_DIR / "policy.ttl")
        # SHACL の定義もストアに置く文だが、推論とデータの問い合わせからは外しておく
        self.shapes = Graph()
        for f in ("shapes.ttl", "equipment_shapes.ttl", "transfer_shapes.ttl"):
            self.shapes.parse(C.KNOWLEDGE_DIR / f)
        self.approval_shapes = Graph().parse(C.KNOWLEDGE_DIR / "approval_shapes.ttl")
        self.monitor_shapes = Graph().parse(C.KNOWLEDGE_DIR / "monitor_shapes.ttl")
        self._version = 0
        self._inferred: tuple[int, Graph] | None = None

    # ---- 書き込み ---------------------------------------------------------

    def add_triples(self, graph: URIRef, triples) -> None:
        g = self.ds.graph(graph)
        for t in triples:
            g.add(t)
        self._version += 1

    def replace_value(self, graph: URIRef, s, p, o, extra=()) -> None:
        g = self.ds.graph(graph)
        g.set((s, p, o))
        for pp, oo in extra:
            g.set((s, pp, oo))
        self._version += 1

    def update(self, sparql_update: str) -> None:
        """レイヤー4 の SPARQL Update の窓口。合格した変更だけがここを通る。"""
        self.ds.update(C.PREFIXES + sparql_update)
        self._version += 1

    # ---- 読み取り ---------------------------------------------------------

    def asserted(self) -> Graph:
        g = Graph()
        for s, p, o, _ in self.ds.quads((None, None, None, None)):
            g.add((s, p, o))
        return g

    def inferred(self) -> Graph:
        """ストアのコピーに OWL 2 RL の推論をかけたもの。ストア自体は変えない。"""
        if self._inferred and self._inferred[0] == self._version:
            return self._inferred[1]
        g = self.asserted()
        owlrl.DeductiveClosure(owlrl.OWLRL_Semantics, axiomatic_triples=False,
                               datatype_axioms=False).expand(g)
        self._inferred = (self._version, g)
        return g

    def query(self, sparql: str, inferred: bool = True) -> list[dict]:
        """inferred=True は推論済みのコピーに、False はストアそのもの（Named Graph を指定できる）に問い合わせる。"""
        g = self.inferred() if inferred else self.ds
        res = g.query(C.PREFIXES + sparql)
        return [{str(k): v for k, v in row.asdict().items()} for row in res]

    def count_inferred_only(self) -> int:
        return len(self.inferred()) - len(self.asserted())

    def stats(self) -> list[dict]:
        names = {C.G_ONTOLOGY: "オントロジーの定義", C.G_MASTER: "マスタ・台帳・棚割・イベント",
                 C.G_STATE: "最新の状態", C.G_PLANS: "合格した更新（発注計画）",
                 C.G_POLICY: "権限（ODRL）", C.G_CDC: "CDC で戻った SAP の伝票"}
        return [{"graph": str(gid), "name": n, "triples": len(self.ds.graph(gid))}
                for gid, n in names.items()]

    def turtle(self, graph: URIRef) -> str:
        g = self.ds.graph(graph)
        out = Graph()
        for t in g:
            out.add(t)
        for prefix, ns in [("ex", C.EX), ("sku", C.SKU), ("store", C.STORE), ("plan", C.PLAN),
                           ("line", C.LINE), ("model", C.MODEL), ("person", C.PERSON),
                           ("rec", C.REC), ("event", C.EVENT), ("cat", C.CAT), ("equip", C.EQUIP),
                           ("zone", C.ZONE), ("sensor", C.SENSOR), ("vehicle", C.VEHICLE),
                           ("setting", C.SETTING), ("transfer", C.TRANSFER)]:
            out.bind(prefix, ns)
        return out.serialize(format="turtle")

    # ---- SHACL ------------------------------------------------------------

    def validate(self, action: Graph, with_approval: bool = False) -> ValidationResult:
        """アクション（提案の三つ組）を、推論済みのストアに重ねて点検する。何も書き換えない。"""
        data = self._overlay(action)
        shapes = Graph()
        for t in self.shapes:
            shapes.add(t)
        if with_approval:
            for t in self.approval_shapes:
                shapes.add(t)
        conforms, report, _ = validate(data, shacl_graph=shapes, inference="none",
                                       allow_warnings=True)
        return ValidationResult(conforms, self._results(report, shapes),
                                "確定（承認の点検を含む）" if with_approval else "事前検証")

    def monitor(self) -> ValidationResult:
        """実行中の見張り。ストアにある最新の観測を、見張りの規則で点検する。"""
        conforms, report, _ = validate(self.inferred(), shacl_graph=self.monitor_shapes, inference="none")
        return ValidationResult(conforms, self._results(report, self.monitor_shapes), "見張り")

    def needs_approval(self, action: Graph) -> dict[str, str]:
        """承認の点検だけをかけて、承認が要る明細とその理由を返す。"""
        data = self._overlay(action)
        _, report, _ = validate(data, shacl_graph=self.approval_shapes, inference="none")
        return {r["focus"]: r["message"] for r in self._results(report, self.approval_shapes)}

    def _overlay(self, action: Graph) -> Graph:
        """推論済みのストアのコピーに、アクションを重ねる。アクションが言い直す主語の古い文は外す。"""
        data = Graph()
        for t in self.inferred():
            data.add(t)
        for s in set(action.subjects()):
            data.remove((s, None, None))
        for t in action:
            data.add(t)
        return data

    @staticmethod
    def _results(report: Graph, shapes: Graph) -> list[dict]:
        out = []
        for r in report.subjects(SH.resultSeverity, None):
            constraint = report.value(r, SH.sourceConstraint) or report.value(r, SH.sourceShape)
            name = shapes.value(constraint, SH.name) if constraint is not None else None
            if name is None:
                path = report.value(r, SH.resultPath)
                prop = next(shapes.subjects(SH.path, path), None) if path is not None else None
                name = shapes.value(prop, SH.name) if prop is not None else None
            out.append({"focus": C.local(report.value(r, SH.focusNode)),
                        "check": str(name or "形"),
                        "message": str(report.value(r, SH.resultMessage) or "")})
        return sorted(out, key=lambda x: (x["focus"], x["check"]))
