"""レイヤー4 UC3 夕方の在庫融通と見切り（AI エージェントの代役と、KINETIC のワークフロー）。

AI は、ナレッジグラフから近くの店（GeoSPARQL）、期限の短い商品（SKOS の区分を OWL でたどる）、
今夜の帰り便のルートを聞き、3店の POS に店頭在庫と今日の販売数を聞いて、閉店までに余る数と足りない数を見積もる。
余る店から足りない店へ、帰り便のルートが受け入れる店の近くを通る車で移す。期限が今日の商品は移さず見切りにする。
KINETIC は、承認と時刻（17:05 の取り出し、17:50・18:10 の受け入れ、19:00・20:30 の値引き）を待つ。

状態: 待機 → 承認待ち → 実行中 → 完了
"""

from __future__ import annotations

from dataclasses import dataclass, field

from rdflib import RDF, Graph, Literal
from rdflib.namespace import XSD

from . import config as C
from .config import EX
from .layer2_etl import sync_cdc
from .workflow import Context, Workflow

PLAN_ID = "TP-1023"
STORES = ["ST-014", "ST-031", "ST-040"]
TIMELINE = ["17:05", "17:50", "18:10", "19:00", "20:30", "22:00"]


@dataclass
class Transfer:
    id: str
    product: str
    name: str
    quantity: int
    source: str
    dest: str
    vehicle: str
    eta: str
    expiry: str
    source_stock: int
    source_reserved: int
    price: int
    status: str = "提案"
    approved_by: str | None = None
    approved_quantity: int | None = None
    history: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        d["amount"] = self.quantity * self.price
        return d


@dataclass
class Markdown:
    id: str
    product: str
    name: str
    store: str
    expiry: str
    surplus: int
    steps: list[tuple[float, int]]
    status: str = "提案"
    applied: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return self.__dict__.copy()


class TransferAgent:
    def __init__(self, kg, pos, log, day: str):
        self.kg, self.pos, self.log, self.day = kg, pos, log, day
        self.context: dict = {}

    def plan(self) -> tuple[list[Transfer], list[Markdown]]:
        pol = self.kg.query("""SELECT ?near ?radius ?maxd ?before WHERE {
            ex:TransferPolicy ex:nearbyStoreKm ?near ; ex:routeRadiusKm ?radius .
            ex:MarkdownPolicy ex:maxDiscount ?maxd ; ex:hoursBeforeClose ?before . }""")[0]
        pairs = self.kg.query(f"""SELECT ?a ?b ?km WHERE {{
            ?a a ex:Store ; geo:hasGeometry/geo:asWKT ?wa . ?b a ex:Store ; geo:hasGeometry/geo:asWKT ?wb .
            FILTER (?a != ?b) BIND (geof:distance(?wa, ?wb, uom:kilometre) AS ?km) FILTER (?km <= {pol['near']}) }}""")
        products = self.kg.query("""SELECT DISTINCT ?p ?label ?cat ?price ?zone WHERE {
            ?p ex:inCategoryTree ?c ; rdfs:label ?label ; ex:price ?price ; ex:tempZone ?zone ; ex:category ?cc .
            ?cc skos:prefLabel ?cat .
            FILTER (?c IN (cat:daily, cat:deli)) }""")
        routes = self.kg.query(f"""SELECT ?v ?home ?store ?km ?eta ?free ?label WHERE {{
            ?v a ex:Vehicle ; ex:home ?home ; ex:etaReceiving ?eta ; ex:freeUnits ?free ; ex:routeLabel ?label ;
               geo:hasGeometry/geo:asWKT ?route .
            ?store a ex:Store ; geo:hasGeometry/geo:asWKT ?pt .
            FILTER (?store != ?home)
            BIND (geof:distance(?pt, ?route, uom:kilometre) AS ?km) FILTER (?km <= {pol['radius']}) }}""")
        close = {C.local(r["s"]): int(r["h"]) for r in self.kg.query("SELECT ?s ?h WHERE { ?s ex:closeHour ?h }")}

        info = {C.local(r["p"]): {"name": str(r["label"]), "category": str(r["cat"]), "price": int(r["price"])}
                for r in products}
        stock = {s: self.pos.stock_api(s) for s in STORES}
        estimates = []
        for s in STORES:
            for p, v in stock[s].items():
                if p not in info:
                    continue
                rest = round(v["sold_today"] / v["hours_open"] * v["hours_left"])
                estimates.append({"store": s, "product": p, "name": info[p]["name"], "stock": v["stock"],
                                  "sold_today": v["sold_today"], "rest": rest, "balance": v["stock"] - rest,
                                  "expiry": v["expiry"], "reserved": v.get("reserved_online", 0),
                                  "runout": None if v["stock"] >= rest else round(16 + v["stock"] / (v["sold_today"] / v["hours_open"]), 1)})
        self.context = {
            "day": self.day, "policy": {k: float(v) for k, v in pol.items()},
            "nearby": [{"a": C.local(r["a"]), "b": C.local(r["b"]), "km": round(float(r["km"]), 2)} for r in pairs],
            "routes": [{"vehicle": C.local(r["v"]), "home": C.local(r["home"]), "store": C.local(r["store"]),
                        "km": round(float(r["km"]), 2), "eta": str(r["eta"]), "free": int(r["free"]),
                        "label": str(r["label"])} for r in routes],
            "estimates": estimates,
        }
        self.log("L4", "AI", "ナレッジグラフに近くの店・期限の短い商品・今夜のルートを問い合わせ（SPARQL / GeoSPARQL）",
                 {"近くの店": self.context["nearby"], "期限の短い商品": list(info)})
        self.log("L4", "AI", "3店の POS に店頭在庫（期限ごと）と今日の販売数を確認（MCP）",
                 {f"{e['store']} {e['product']}": f"在庫 {e['stock']}・今日 {e['sold_today']}・期限 {e['expiry']}" for e in estimates})
        self.log("L4", "AI", "閉店までの売れ行きを見積もる",
                 {f"{e['store']} {e['name']}": f"{'余る' if e['balance'] > 0 else '足りない'} {abs(e['balance'])}" for e in estimates if e["balance"]})

        transfers, markdowns = [], []
        n = 1601
        # 見積もり（estimates）は画面にそのまま出すので書き換えず、割り当てたあとの余りは別に持つ
        left = {(e["store"], e["product"]): e["balance"] for e in estimates}
        for short in sorted((e for e in estimates if e["balance"] < 0), key=lambda e: (e["product"], e["store"])):
            need = -short["balance"]
            sources = sorted((e for e in estimates if e["product"] == short["product"] and left[(e["store"], e["product"])] > 0
                              and e["expiry"] > self.day), key=lambda e: -left[(e["store"], e["product"])])
            for src in sources:
                route = next((r for r in self.context["routes"] if r["home"] == src["store"] and r["store"] == short["store"]), None)
                if not route:
                    continue
                q = min(need, left[(src["store"], src["product"])])
                transfers.append(Transfer(f"T-{n}", short["product"], short["name"], q, src["store"], short["store"],
                                          route["vehicle"], route["eta"], src["expiry"], src["stock"], src["reserved"],
                                          info[short["product"]]["price"]))
                n += 1
                left[(src["store"], src["product"])] -= q
                break
        for e in estimates:
            if left[(e["store"], e["product"])] > 0 and e["expiry"] == self.day:
                h = close[e["store"]] - float(pol["before"])
                markdowns.append(Markdown(f"M-{n}", e["product"], e["name"], e["store"], e["expiry"], left[(e["store"], e["product"])],
                                          [(h, 30), (h + 1.5, int(float(pol["maxd"])))]))
                n += 1
        self.log("L3", "OWL", "推論と GeoSPARQL: 帰り便が立ち寄れる店",
                 [f"{r['vehicle']}（{r['home']}）は {r['store']} から {r['km']}km を通る" for r in self.context["routes"]])
        self.log("L4", "AI", "在庫融通の方針で案を作成",
                 [f"{t.id} {t.name} {t.quantity}: {t.source} → {t.dest}（{t.vehicle} {t.eta}）" for t in transfers] +
                 [f"{m.id} {m.store} の{m.name}: " + "、".join(f"{int(h)}:{int(h % 1 * 60):02d} から{d}%引き" for h, d in m.steps) for m in markdowns])
        return transfers, markdowns

    def reduce(self, t: Transfer, actual: int) -> None:
        t.history.append(f"取り出しで {actual} しか見つからず {t.quantity} → {actual}")
        t.quantity = actual


def plan_graph(day: str, transfers: list[Transfer], markdowns: list[Markdown]) -> Graph:
    g = Graph()
    plan = C.PLAN[PLAN_ID]
    g.add((plan, RDF.type, EX.TransferPlan))
    g.add((plan, EX.date, Literal(day, datatype=XSD.date)))
    for t in transfers:
        n = C.TRANSFER[t.id]
        g.add((n, RDF.type, EX.Transfer))
        g.add((n, EX.plan, plan))
        g.add((n, EX.product, C.SKU[t.product]))
        g.add((n, EX.quantity, Literal(t.quantity, datatype=XSD.integer)))
        g.add((n, EX["from"], C.STORE[t.source]))
        g.add((n, EX.to, C.STORE[t.dest]))
        g.add((n, EX.vehicle, C.VEHICLE[t.vehicle]))
        g.add((n, EX.eta, Literal(t.eta)))
        g.add((n, EX.transferDate, Literal(day, datatype=XSD.date)))
        g.add((n, EX.expiry, Literal(t.expiry, datatype=XSD.date)))
        g.add((n, EX.sourceStock, Literal(t.source_stock, datatype=XSD.integer)))
        g.add((n, EX.sourceReserved, Literal(t.source_reserved, datatype=XSD.integer)))
        if t.approved_by:
            g.add((n, EX.approvedBy, C.PERSON[t.approved_by]))
            g.add((n, EX.approvedQuantity, Literal(t.approved_quantity, datatype=XSD.integer)))
    for m in markdowns:
        n = C.TRANSFER[m.id]
        g.add((n, RDF.type, EX.Markdown))
        g.add((n, EX.plan, plan))
        g.add((n, EX.product, C.SKU[m.product]))
        g.add((n, EX.store, C.STORE[m.store]))
        g.add((n, EX.date, Literal(day, datatype=XSD.date)))
        g.add((n, EX.expiry, Literal(m.expiry, datatype=XSD.date)))
        for i, (h, pct) in enumerate(m.steps, 1):
            st = C.TRANSFER[f"{m.id}/{i}"]
            g.add((st, RDF.type, EX.MarkdownStep))
            g.add((st, EX.markdown, n))
            g.add((st, EX.fromHour, Literal(h, datatype=XSD.decimal)))
            g.add((st, EX.discount, Literal(pct, datatype=XSD.integer)))
    return g


def subjects(transfers: list[Transfer], markdowns: list[Markdown]) -> list:
    out = [C.TRANSFER[t.id] for t in transfers]
    for m in markdowns:
        out += [C.TRANSFER[m.id]] + [C.TRANSFER[f"{m.id}/{i}"] for i in range(1, len(m.steps) + 1)]
    return out


def hm(h: float) -> str:
    return f"{int(h):02d}:{round(h % 1 * 60):02d}"


class EveningWorkflow(Workflow):
    title = C.SCENARIOS["uc3"]["title"]

    def __init__(self, ctx: Context):
        super().__init__(ctx)
        self.day = C.SCENARIOS["uc3"]["day"].isoformat()
        self.agent = TransferAgent(self.kg, self.l1.pos, self.log, self.day)
        self.transfers: dict[str, Transfer] = {}
        self.markdowns: dict[str, Markdown] = {}
        self.cursor = 0
        self.pending: tuple[list[Transfer], list[Markdown]] = ([], [])

    def next_time(self) -> str | None:
        return TIMELINE[self.cursor] if self.cursor < len(TIMELINE) else None

    def actions(self) -> list[dict]:
        nt = self.next_time()
        return [
            {"id": "start", "label": "① 16:00 ワークフローを起動", "enabled": self.state == "待機"},
            {"id": "approve", "label": "② 2号店の店長として承認", "enabled": self.state == "承認待ち"},
            {"id": "advance", "label": f"③ 時刻を進める（{nt}）" if nt else "③ 時刻を進める",
             "enabled": self.state == "実行中" and nt is not None, "repeatable": True},
        ]

    def payload(self) -> dict:
        return {"uc3": {"context": self.agent.context, "transfers": [t.as_dict() for t in self.transfers.values()],
                        "markdowns": [m.as_dict() for m in self.markdowns.values()], "next_time": self.next_time(),
                        "timeline": TIMELINE}}

    def _confirm(self, transfers, markdowns, time, agent, label, rule=None):
        self.pending = (transfers, markdowns)
        # 来歴に残す「元にしたもの」: 運ぶ車（今夜のルート）と、見切りの店
        used = [C.VEHICLE[t.vehicle] for t in transfers] + [C.STORE[m.store] for m in markdowns]
        return self.gate.confirm(plan_graph(self.day, transfers, markdowns), subjects(transfers, markdowns),
                                 time, agent, label, used=used, rule=rule, event_type="example.transfer.confirmed",
                                 data={"plan": PLAN_ID, "transfers": {t.id: t.quantity for t in transfers},
                                       "markdowns": [m.id for m in markdowns]})

    def act_start(self) -> None:
        self.set_time("16:00")
        self.log("L4", "KINETIC", "毎日 16:00 のスケジュールで「夕方の在庫融通」ワークフローが起動")
        self.log("L4", "KINETIC", "AI に今日の融通と見切りの案を依頼")
        transfers, markdowns = self.agent.plan()
        for t in transfers:
            self.transfers[t.id] = t
        for m in markdowns:
            self.markdowns[m.id] = m
        self.set_time("16:08")
        res = self.gate.pre_validate(plan_graph(self.day, transfers, markdowns))
        self.record_validation("事前検証", res)
        if not res.conforms:
            self.log("L3", "SHACL", "事前検証: 不合格", res.results)
            self.state = "失敗"
            return
        self.log("L3", "SHACL", "事前検証: 合格（温度帯・期限・保冷時間・車の空き・引当分・帰り便・見切りの上限）")
        needs = {k.split("/")[0]: v for k, v in self.gate.needs_approval(plan_graph(self.day, transfers, markdowns)).items()}
        auto_t = [t for t in transfers if t.id not in needs]
        need_t = [t for t in transfers if t.id in needs]
        for t in transfers:
            t.status = "承認待ち" if t.id in needs else "承認不要"
        self.log("L3", "SHACL", "承認の要否", {"承認不要": [t.id for t in auto_t] + [m.id for m in markdowns],
                                               "受け入れる店の店長の承認が要る": needs})
        self.set_time("16:10")
        res = self._confirm(auto_t, markdowns, "16:10", C.EX.TransferPolicy, "上限以内の店間移動と見切りを自動で確定",
                            "50個以下かつ15,000円以下の店間移動、上限内の見切り")
        self.record_validation("確定（承認不要の分）", res)
        if need_t:
            t = need_t[0]
            self.approval_request = {
                "approver": "manager-ST031", "approver_label": "2号店の店長", "plan": PLAN_ID, "kind": "transfer",
                "message": f"{t.source.replace('ST-040', '3号店').replace('ST-014', '1号店')}から{t.name}{t.quantity}個を {t.eta} に受け入れ、今夜売り切る計画でよいですか？",
                "lines": [x.as_dict() | {"why": needs[x.id]} for x in need_t],
            }
            self.state = "承認待ち"
            self.log("L5", "業務画面", "2号店の店長のタブレットに承認依頼", self.approval_request["message"])
        else:
            self.state = "実行中"

    def act_approve(self, approver: str = "manager-ST031") -> None:
        self.set_time("16:15")
        need = [self.transfers[x["id"]] for x in self.approval_request["lines"]]
        for t in need:
            t.approved_by, t.approved_quantity = approver, t.quantity
        self.log("L5", "店長", "タブレットで「承認する」をタップ", {"approver": approver, "transfers": [t.id for t in need]})
        res = self._confirm(need, [], "16:15", C.PERSON[approver], "2号店の店長が、上限を超える店間移動の受け入れを承認")
        self.record_validation("再検証（承認付き）", res)
        if not res.conforms:
            for t in need:
                t.status = "却下"
            self.log("L3", "SHACL", "再検証: 不合格", res.results)
        self.approval_request = None
        self.state = "実行中"

    def act_advance(self) -> None:
        t = self.next_time()
        self.cursor += 1
        self.set_time(t)
        pos, staff, tms = self.l1.pos, self.l1.staff, self.l1.tms
        if t == "17:05":
            # 送り出す店で取り出し作業。実際の数が足りなければ、AI に数量の修正を頼む
            for tr in [x for x in self.transfers.values() if x.status == "確定"]:
                actual = staff.pick(pos, f"pick-{tr.id}", tr.source, tr.product, tr.quantity)
                self.log("L1", "スタッフ端末", f"{tr.source} で取り出し: {tr.name} {actual} が見つかった（予定 {tr.quantity}）")
                if actual >= tr.quantity:
                    continue
                self.log("L4", "KINETIC", f"{tr.id} の実際の数が足りないので、AI に数量の修正を頼む")
                self.agent.reduce(tr, actual)
                self.log("L4", "AI", f"{tr.id} を {actual} に減らす（減らすだけなので承認不要）")
                res = self._confirm([tr], [], t, C.EX.TransferPolicy, f"{tr.id} を {actual} に減らす",
                                    "店間移動の数量を減らすのは承認不要")
                self.record_validation(f"確定（{tr.id} の数量の修正）", res)
        elif t in ("17:50", "18:10"):
            for tr in (x for x in self.transfers.values() if x.eta == t and x.status == "確定"):
                pos.take_out(tr.source, tr.product, tr.quantity)
                pos.receive(tr.dest, {tr.product: tr.quantity})
                staff.complete(f"recv-{tr.id}", f"{tr.quantity} 受け入れ")
                tms.update_stop(tr.vehicle, tr.dest, status="完了")
                tr.status = "受け入れ済み"
                self.log("L1", "スタッフ端末", f"2号店で {tr.vehicle} から {tr.name} {tr.quantity} を受け入れ（スキャン）。POS の在庫が増える")
            sync_cdc(self.l1, self.kg)
        elif t in ("19:00", "20:30"):
            for m in self.markdowns.values():
                for h, pct in m.steps:
                    if hm(h) == t and m.status == "確定":
                        label = pos.set_price(m.store, m.product, self.l1.sap.price(m.product), pct, t, f"見切り {m.id}")
                        m.applied.append(t)
                        self.log("L4", "KINETIC", f"{t} まで待って（タイマー）、{m.store} の{m.name}を {pct}% 引きに")
                        self.log("L1", "電子棚札 / POS", f"{m.store} {m.name} の売価を {label['price']} 円に（{pct}%引き）", label)
        elif t == "22:00":
            self.log("L4", "KINETIC", "閉店。移動・数量の修正・見切りの来歴は監査グラフに残り、売れ残りは履歴の蓄積先から BI で振り返る")
            self.state = "完了"

    def on_confirmed(self, event: dict) -> None:
        transfers, markdowns = self.pending
        for t in transfers:
            t.status = "確定"
        for m in markdowns:
            m.status = "確定"
        self.log("L3", "SHACL", "合格 → SPARQL Update 成功 → 確定イベントを発行", event)
        self.log("L5", "ガバナンス", "監査グラフに来歴を記録（PROV-O）", self.gate.audit.entries[-1])
        sap, tms, pos, staff = self.l1.sap, self.l1.tms, self.l1.pos, self.l1.staff
        for t in transfers:
            sap.upsert_order(t.id, t.dest, t.source, self.day, {t.product: t.quantity}, kind="店間移動")
            tms.add_stop(t.vehicle, t.dest, t.eta, f"{t.id} {t.name} {t.quantity}")
            pos.set_incoming(t.dest, {t.product: t.quantity})
            staff.upsert_task(f"pick-{t.id}", t.source, "17:00", f"{t.name} {t.quantity} を取り出し、{t.vehicle} に積む（{t.id}）")
            staff.upsert_task(f"recv-{t.id}", t.dest, t.eta, f"{t.vehicle} から {t.name} {t.quantity} を受け入れて陳列（{t.id}）")
        if transfers:
            self.log("L1", "SAP / TMS / POS / スタッフ端末",
                     "店間移動伝票、帰り便の立ち寄り、入荷予定、取り出しと受け入れの作業を書き戻し",
                     {t.id: f"{t.source} → {t.dest} {t.name} {t.quantity}（{t.vehicle} {t.eta}）" for t in transfers})
            sync_cdc(self.l1, self.kg)
        for m in markdowns:
            self.log("L4", "KINETIC", f"{m.id} は値引きの時刻（" + "、".join(hm(h) for h, _ in m.steps) + "）まで待つ")

