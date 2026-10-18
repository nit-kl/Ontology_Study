"""レイヤー4 AI エージェント（Amazon Bedrock + LangGraph の代役）。

デモでは生成 AI を呼ばず、決まった手順で動く。手順は本物のエージェントと同じで、
ナレッジグラフへの SPARQL、POS の在庫 API、需要予測モデルを順に呼び、発注の方針で案を作る。
不合格なら、SHACL が返した理由を見て案を直す。
生成 AI に置き換えるときは、plan_tomorrow と fix の中の判断を、ツール呼び出しつきのモデルに任せる。
"""

from __future__ import annotations

from datetime import date
from typing import Callable

from rdflib import URIRef

from . import config as C
from .forecast import DemandModel
from .layer1 import POS
from .layer3_kg import KnowledgeGraph, ValidationResult
from .plan import Line, OrderPlan

Log = Callable[..., None]


def case_round(x: float, case: int) -> int:
    """予測に近いケースの倍数（四捨五入）。"""
    return int(x / case + 0.5) * case


def case_floor(x: float, case: int) -> int:
    return int(x // case) * case


class OrderAgent:
    def __init__(self, kg: KnowledgeGraph, pos: POS, model: DemandModel, log: Log):
        self.kg, self.pos, self.model, self.log = kg, pos, model, log
        self.context: dict = {}

    # ---- 調べる ----------------------------------------------------------

    def gather_context(self, store: str, day: date) -> dict:
        d = f'"{day.isoformat()}"^^xsd:date'
        st = f"store:{store}"
        events = self.kg.query(f"""
            SELECT ?event ?label ?type ?typeLabel ?attendance ?km WHERE {{
                ?event a ex:Event ; ex:date {d} ; rdfs:label ?label ; ex:eventType ?type ;
                       ex:attendance ?attendance ; geo:hasGeometry/geo:asWKT ?ew .
                OPTIONAL {{ ?type rdfs:label ?typeLabel }}
                {st} geo:hasGeometry/geo:asWKT ?sw .
                BIND (geof:distance(?sw, ?ew, uom:kilometre) AS ?km)
            }} ORDER BY ?km""")
        policy = self.kg.query("""
            SELECT ?r ?min ?th ?ratio WHERE {
                ex:OrderPolicy ex:nearbyRadiusKm ?r ; ex:minAttendance ?min ;
                               ex:hotDayThreshold ?th ; ex:approvalRatio ?ratio . }""")[0]
        boosted = self.kg.query(f"""
            SELECT DISTINCT ?product ?event WHERE {{
                ex:OrderPolicy ex:nearbyRadiusKm ?r ; ex:minAttendance ?min .
                ?slot a ex:PlanogramSlot ; ex:store {st} ; ex:product ?product .
                ?product ex:boostedByEvent ?event .
                ?event ex:date {d} ; ex:attendance ?a ; geo:hasGeometry/geo:asWKT ?ew .
                {st} geo:hasGeometry/geo:asWKT ?sw .
                FILTER (?a >= ?min && geof:distance(?sw, ?ew, uom:kilometre) <= ?r)
            }}""")
        weather = self.kg.query(f"""
            SELECT ?t ?forecast WHERE {{
                {st} ex:area ?area .
                ?forecast a ex:WeatherForecast ; ex:area ?area ; ex:date {d} ; ex:maxCelsius ?t . }}""")
        hot = self.kg.query(f"""
            SELECT DISTINCT ?product WHERE {{
                ex:OrderPolicy ex:hotDayThreshold ?th .
                {st} ex:area ?area .
                ?f a ex:WeatherForecast ; ex:area ?area ; ex:date {d} ; ex:maxCelsius ?t .
                FILTER (?t >= ?th)
                ?slot a ex:PlanogramSlot ; ex:store {st} ; ex:product ?product .
                ?product ex:sensitiveTo ex:HotDay .
            }}""")
        launches = self.kg.query(f"""
            SELECT ?product WHERE {{
                ?slot a ex:PlanogramSlot ; ex:store {st} ; ex:product ?product .
                ?product ex:launchDate {d} . }}""")
        products = self.kg.query(f"""
            SELECT ?product ?label ?case ?rec WHERE {{
                ?slot a ex:PlanogramSlot ; ex:store {st} ; ex:product ?product .
                ?product rdfs:label ?label ; ex:caseSize ?case .
                OPTIONAL {{ ?r a ex:Recommendation ; ex:store {st} ; ex:product ?product ;
                               ex:date {d} ; ex:quantity ?rec . }}
            }} ORDER BY ?product""")

        nearby = [e for e in events
                  if float(e["km"]) <= float(policy["r"]) and int(e["attendance"]) >= int(policy["min"])]
        ctx = {
            "store": store, "day": day.isoformat(),
            "policy": {k: float(v) for k, v in policy.items()},
            "events": [{"id": C.local(e["event"]), "label": str(e["label"]),
                        "type": C.local(e["type"]),
                        "type_label": str(e["typeLabel"]) if e.get("typeLabel") else "（オントロジーに定義なし）",
                        "attendance": int(e["attendance"]),
                        "km": round(float(e["km"]), 2),
                        "nearby": e in nearby} for e in events],
            "max_temp": int(weather[0]["t"]) if weather else None,
            "evidence": [str(e["event"]) for e in nearby] + [str(w["forecast"]) for w in weather],
            "products": {C.local(p["product"]): {
                "name": str(p["label"]), "case": int(p["case"]),
                "rec": int(p["rec"]) if p.get("rec") is not None else None,
                "reasons": []} for p in products},
        }
        for b in boosted:
            ev = next(e for e in ctx["events"] if e["id"] == C.local(b["event"]))
            ctx["products"][C.local(b["product"])]["reasons"].append(f"近くのイベント {ev['id']}")
        for h in hot:
            ctx["products"][C.local(h["product"])]["reasons"].append(f"暑い日（予報 {ctx['max_temp']}℃）")
        for n in launches:
            ctx["products"][C.local(n["product"])]["reasons"].append("明日発売")
        ctx["event_type"] = next((e["type"] for e in ctx["events"] if e["nearby"]), None)
        for p, info in ctx["products"].items():
            if "明日発売" in info["reasons"]:
                sim = self.kg.query(f"""
                    SELECT ?ref ?rp ?pp WHERE {{
                        ex:OrderPolicy ex:similarPriceDiff ?lim .
                        sku:{p} ex:category ?c ; ex:tempZone ?z ; ex:price ?pp .
                        ?ref ex:category ?c ; ex:tempZone ?z ; ex:price ?rp ; ex:hasSalesHistory true .
                        FILTER (?ref != sku:{p} && ABS(?pp - ?rp) <= ?lim)
                    }} ORDER BY ABS(?pp - ?rp)""")
                info["similar"] = C.local(sim[0]["ref"]) if sim else None
        self.context = ctx

        self.log("L4", "AI", "ナレッジグラフに明日の事情を問い合わせ（SPARQL / GeoSPARQL）",
                 {"events": ctx["events"], "max_temp": ctx["max_temp"]})
        affected = {p: i for p, i in ctx["products"].items() if i["reasons"]}
        self.log("L3", "OWL", "推論: 明日の事情に関わる商品",
                 {p: i["reasons"] + ([f"似た商品 {i['similar']}"] if i.get("similar") else [])
                  for p, i in affected.items()})
        return ctx

    # ---- 案を作る ----------------------------------------------------------

    def plan_tomorrow(self, store: str, day: date, plan_id: str) -> OrderPlan:
        ctx = self.gather_context(store, day)
        plan = OrderPlan(plan_id, store, day.isoformat(), evidence=[URIRef(x) for x in ctx["evidence"]])
        affected = [p for p, i in ctx["products"].items() if i["reasons"]]

        stock = self.pos.stock_api(store, list(ctx["products"]))
        self.log("L4", "AI", "POS に店頭在庫と今日の販売数を確認（MCP）",
                 {p: {"stock": s["stock"], "sold_today": s["sold_today"]} for p, s in stock.items()})

        for p, info in ctx["products"].items():
            s = stock[p]
            rate = s["sold_today"] / s["hours_open"]
            morning = max(0, s["stock"] - round(rate * s["hours_left"]))
            line = Line(p, info["name"], 0, info["case"], info["rec"], morning)
            if p in affected:
                fc = self.model.predict(p, day, ctx["max_temp"], ctx["event_type"], info.get("similar"))
                line.forecast = fc.as_dict()
                line.reference = info.get("similar")
                line.quantity = case_round(fc.mean, info["case"])
                line.reason = "、".join(info["reasons"])
            elif info["rec"] is not None:
                line.quantity = info["rec"]
                line.reason = "明日の事情に関わらないので推奨数のまま"
            else:
                continue
            line.history.append(f"案 {line.quantity}")
            plan.lines[p] = line

        self.log("L4", "需要予測モデル", f"明日の販売数を予測（{self.model.version}）",
                 {p: plan.lines[p].forecast for p in affected})
        self.log("L4", "AI", "発注の方針で案を作成",
                 {p: {"quantity": ln.quantity, "recommended": ln.recommended, "reason": ln.reason}
                  for p, ln in plan.lines.items()})
        return plan

    # ---- 直す ------------------------------------------------------------

    def fix(self, plan: OrderPlan, result: ValidationResult) -> bool:
        """不合格の理由を見て案を直す。直せたら True。"""
        changed = False
        for r in result.results:
            p = r["focus"].rsplit("/", 1)[-1]
            ln = plan.lines.get(p)
            if not ln:
                continue
            before = ln.quantity
            if r["check"] == "置き場の容量":
                cap = int(self.kg.query(f"""
                    SELECT ?cap WHERE {{ ?s a ex:PlanogramSlot ; ex:store store:{plan.store} ;
                                         ex:product sku:{p} ; ex:capacity ?cap . }}""")[0]["cap"])
                ln.quantity = case_floor(cap - ln.morning_stock, ln.case_size)
            elif r["check"] == "予測の範囲":
                ln.quantity = case_floor(ln.forecast["upper"], ln.case_size)
            elif r["check"] == "発注の単位":
                ln.quantity = case_round(ln.quantity, ln.case_size)
            if ln.quantity != before:
                ln.history.append(f"{r['check']}で {before} → {ln.quantity}")
                changed = True
        return changed

    def reduce_to_available(self, plan: OrderPlan, product: str, available: int) -> int:
        ln = plan.lines[product]
        before = ln.quantity
        ln.quantity = case_floor(available, ln.case_size)
        ln.history.append(f"DC の在庫 {available} に合わせて {before} → {ln.quantity}")
        return ln.quantity
