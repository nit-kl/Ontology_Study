"""発注計画（AI の提案であり、合格すると確定する更新の中身）。"""

from __future__ import annotations

from dataclasses import dataclass, field

from rdflib import RDF, Graph, Literal
from rdflib.namespace import XSD

from . import config as C
from .config import EX


@dataclass
class Line:
    product: str
    name: str
    quantity: int
    case_size: int
    recommended: int | None = None
    morning_stock: int = 0
    forecast: dict | None = None
    reference: str | None = None
    reason: str = ""
    approved_by: str | None = None
    approved_quantity: int | None = None
    status: str = "提案"
    history: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        d["ratio"] = round(self.quantity / self.recommended, 2) if self.recommended else None
        return d


@dataclass
class OrderPlan:
    id: str
    store: str
    delivery_date: str
    lines: dict[str, Line] = field(default_factory=dict)
    evidence: list = field(default_factory=list)   # 予測の元になった事実の IRI（イベント、予報）

    def line_iri(self, product: str):
        return C.LINE[f"{self.id}/{product}"]

    def to_graph(self, products: list[str] | None = None) -> Graph:
        """提案の明細を三つ組にする。SHACL の点検と SPARQL Update の両方に使う。"""
        g = Graph()
        plan = C.PLAN[self.id]
        g.add((plan, RDF.type, EX.OrderPlan))
        g.add((plan, EX.store, C.STORE[self.store]))
        g.add((plan, EX.deliveryDate, Literal(self.delivery_date, datatype=XSD.date)))
        for p in products if products is not None else self.lines:
            ln = self.lines[p]
            s = self.line_iri(p)
            g.add((s, RDF.type, EX.OrderLine))
            g.add((s, EX.plan, plan))
            g.add((s, EX.product, C.SKU[p]))
            g.add((s, EX.quantity, Literal(ln.quantity, datatype=XSD.integer)))
            g.add((s, EX.expectedMorningStock, Literal(ln.morning_stock, datatype=XSD.integer)))
            if ln.forecast:
                g.add((s, EX.forecastMean, Literal(ln.forecast["mean"], datatype=XSD.integer)))
                g.add((s, EX.forecastLower, Literal(ln.forecast["lower"], datatype=XSD.integer)))
                g.add((s, EX.forecastUpper, Literal(ln.forecast["upper"], datatype=XSD.integer)))
                g.add((s, EX.forecastModel, C.MODEL[ln.forecast["version"]]))
            if ln.reference:
                g.add((s, EX.referenceProduct, C.SKU[ln.reference]))
            if ln.approved_by:
                g.add((s, EX.approvedBy, C.PERSON[ln.approved_by]))
                g.add((s, EX.approvedQuantity, Literal(ln.approved_quantity, datatype=XSD.integer)))
        return g
