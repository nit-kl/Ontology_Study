"""レイヤー4 KINETIC のワークフロー「明日の発注」（UC1）。

自分では判断しない。毎日 10:00 のスケジュールで起き、AI に提案を頼み、
SHACL からの確定イベントを受けてレイヤー1 へ書き戻し、承認と時刻を待つ。
書き戻し先が受け付けなかったら、AI に直しを頼み、直した案はまた SHACL を通す。

状態: 待機 → 承認待ち → 締め待ち → 完了
"""

from __future__ import annotations

from . import config as C
from .forecast import DemandModel
from .layer2_etl import sync_cdc
from .layer4_agent import OrderAgent
from .plan import OrderPlan
from .workflow import Context, Workflow

PLAN_ID = "OP-0141"
STO_ID = "STO-0141"
MAX_FIX = 3


class TomorrowOrderWorkflow(Workflow):
    title = C.SCENARIOS["uc1"]["title"]

    def __init__(self, ctx: Context, model: DemandModel):
        super().__init__(ctx)
        self.agent = OrderAgent(self.kg, self.l1.pos, model, self.log)
        self.plan: OrderPlan | None = None

    def actions(self) -> list[dict]:
        return [
            {"id": "start", "label": "① 10:00 ワークフローを起動", "enabled": self.state == "待機"},
            {"id": "approve", "label": "② 店長として承認", "enabled": self.state == "承認待ち"},
            {"id": "advance", "label": "③ 翌朝の受け入れへ", "enabled": self.state == "締め待ち"},
        ]

    def payload(self) -> dict:
        p = self.plan
        return {"context": self.agent.context,
                "plan": {"id": p.id, "store": p.store, "delivery_date": p.delivery_date,
                         "lines": [ln.as_dict() for ln in p.lines.values()]} if p else None}

    def _confirm(self, products: list[str], time: str, agent, label: str, rule: str | None = None):
        plan = self.plan
        used = []
        if any(plan.lines[p].forecast for p in products):
            used = [C.MODEL[plan.lines[p].forecast["version"]] for p in products if plan.lines[p].forecast]
            used += list(plan.evidence)   # 予測の元になったイベントと予報
        return self.gate.confirm(plan.to_graph(products), [plan.line_iri(p) for p in products], time, agent,
                                 label, used=used, rule=rule, event_type="example.order.confirmed",
                                 data={"plan": plan.id, "store": plan.store,
                                       "lines": {p: plan.lines[p].quantity for p in products}})

    # ---- 1. スケジュールで起動し、提案を頼む --------------------------------------

    def act_start(self) -> None:
        self.set_time("10:00")
        self.log("L4", "ワークフロー", "10:00 になったので「明日の発注」を始めた（締め切り 11:00）")
        self.log("L4", "ワークフロー", "AI に1号店の発注案を頼んだ")
        self.set_time("10:05")
        plan = self.agent.plan_tomorrow(C.DEMO_STORE, C.TOMORROW, PLAN_ID)
        self.plan = plan

        # 事前検証。不合格なら AI が理由を見て直し、もう一度出す
        self.set_time("10:12")
        for attempt in range(1, MAX_FIX + 1):
            result = self.gate.pre_validate(plan.to_graph())
            self.record_validation(f"事前検証 {attempt} 回目", result)
            if result.conforms:
                break
            self.log("L3", "ルール点検", f"発注案をルールで点検（{attempt} 回目）: 問題あり", result.results)
            if not self.agent.fix(plan, result):
                self.state = "失敗"
                self.log("L4", "ワークフロー", "AI が案を直せなかったので中止した")
                return
            self.log("L4", "AI", "指摘に合わせて案を直した",
                     {p: ln.history for p, ln in plan.lines.items() if len(ln.history) > 1})
        else:
            self.state = "失敗"
            return
        self.log("L3", "ルール点検", f"発注案をルールで点検（{attempt} 回目）: 問題なし")

        # 承認の要否は SHACL の承認の点検が決める
        needs = {focus.rsplit("/", 1)[-1]: m for focus, m in self.gate.needs_approval(plan.to_graph()).items()}
        need_products = list(needs)
        auto = [p for p in plan.lines if p not in need_products]
        for p in plan.lines:
            plan.lines[p].status = "承認待ち" if p in need_products else "承認不要"
        self.log("L3", "ルール点検", "店長の承認が要る品目を判定した",
                 {"承認不要": auto, "店長の承認が要る": needs})

        # 承認の要らない明細は、そのまま確定
        self.set_time("10:15")
        res = self._confirm(auto, "10:15", C.EX.OrderPolicy, "方針の範囲内の発注を自動で確定",
                            rule="推奨数の1.5倍以内、または新商品で似た商品の推奨数以内")
        self.record_validation("確定（承認不要の明細）", res)

        # 承認が要る明細は、店長に頼んで待つ
        ev = next((e for e in self.agent.context["events"] if e["nearby"]), None)
        self.approval_request = {
            "approver": "manager-ST014", "approver_label": "1号店の店長", "plan": PLAN_ID,
            "message": (f"明日 {ev['label']}（{ev['attendance']:,}人、{ev['km']}km）と予報"
                        f"{self.agent.context['max_temp']}℃のため、{len(need_products)}品を多めに発注します"
                        if ev else f"{len(need_products)}品を多めに発注します"),
            "lines": [plan.lines[p].as_dict() | {"why": needs[p]}
                      for p in need_products],
        }
        self.state = "承認待ち"
        self.log("L5", "店長アプリ", "1号店の店長に承認を頼んだ", self.approval_request["message"])

    # ---- 2. 承認を受けて確定 ------------------------------------------------------

    def act_approve(self, approver: str = "manager-ST014") -> None:
        self.set_time("10:30")
        products = [ln["product"] for ln in self.approval_request["lines"]]
        for p in products:
            ln = self.plan.lines[p]
            ln.approved_by, ln.approved_quantity = approver, ln.quantity
        self.log("L5", "店長", "発注を承認した", {"approver": approver, "lines": products})
        at = len(self.validations)   # 確定イベントの中で数量の修正が先に記録されるので、順番を保つ
        res = self._confirm(products, "10:30", C.PERSON[approver], "1号店の店長が、推奨数の1.5倍を超える発注を承認")
        self.record_validation("再検証（承認付き）", res, at)
        if not res.conforms:
            for p in products:
                self.plan.lines[p].status = "却下"
            self.log("L3", "ルール点検", "承認後の点検: 問題あり", res.results)
            self.state = "締め待ち"
            return
        self.approval_request = None
        self.state = "締め待ち"
        self.set_time("11:00")
        self.log("L4", "ワークフロー", "11:00 発注を締め切った。明日の朝の入荷を待つ")

    # ---- 3. 翌朝の受け入れ ------------------------------------------------------

    def act_advance(self) -> None:
        self.set_time("翌 05:00")
        self.log("L1", "WMS", "東部DCから1号店へ出荷した", self.l1.wms.allocations.get(STO_ID))
        self.set_time("翌 06:40")
        lines = self.l1.sap.orders[STO_ID]["lines"]
        # 閉店までに売れて、朝に残った数（AI の見込みどおりだったとする）から受け入れる
        for p, ln in self.plan.lines.items():
            self.l1.pos.state[self.plan.store].setdefault(p, {"stock": 0, "sold_today": 0})["stock"] = ln.morning_stock
        self.l1.pos.receive(self.plan.store, lines)
        self.l1.staff.complete_all(self.plan.store)
        self.log("L1", "スタッフ端末", "1号店で入荷を検品し、在庫に反映した", lines)
        self.log("L4", "ワークフロー", "入荷が終わったので完了")
        self.state = "完了"

    # ---- 確定イベントを受けて書き戻す ---------------------------------------------------

    def on_confirmed(self, event: dict) -> None:
        lines: dict[str, int] = event["data"]["lines"]
        for p in lines:
            self.plan.lines[p].status = "確定"
        self.log("L3", "ルール点検", "点検に合格したので確定した", event)
        self.log("L5", "監査記録", "誰が何をもとに決めたかを記録した", self.gate.audit.entries[-1])
        self._write_back(lines)

    def _write_back(self, lines: dict[str, int]) -> None:
        store = self.plan.store
        dc = "DC-01"
        order = self.l1.sap.upsert_order(STO_ID, store, dc, self.plan.delivery_date, lines)
        self.log("L1", "SAP", f"発注伝票 {STO_ID} を登録した", order["lines"])
        codes = self._wholesale_codes(list(lines))
        shortages = {}
        for p, q in lines.items():
            r = self.l1.wms.allocate(dc, STO_ID, codes[p], q)
            if not r["ok"]:
                shortages[p] = r
        self.l1.pos.set_incoming(store, {p: q for p, q in lines.items() if p not in shortages})
        self.log("L1", "WMS / POS", "DC の在庫を確保し、1号店に入荷予定を送った",
                 {"引き当て": {p: q for p, q in lines.items() if p not in shortages},
                  "引き当てられない": shortages})
        if any(self.plan.lines[p].forecast for p in lines if p not in shortages):
            # 確定して引き当てられた、事情に関わる商品で、明日の朝の作業を作り直す
            boosted = [ln for ln in self.plan.lines.values()
                       if ln.forecast and ln.status == "確定" and ln.product in self.l1.pos.incoming.get(store, {})]
            names = "、".join(f"{ln.name} {ln.quantity}" for ln in boosted)
            self.l1.staff.upsert_task("island", store, "翌 06:30", f"入口に島陳列を作る（{names}）")
            if any(ln.product == "R-3901" for ln in boosted):
                self.l1.staff.upsert_task("ice", store, "翌 06:30", "冷凍ケース FZ-01 に氷を補充する")
            self.log("L1", "スタッフ端末", "明日の朝の作業を登録した", [t["text"] for t in self.l1.staff.tasks])

        cdc = sync_cdc(self.l1, self.kg)
        if cdc:
            diff = self.kg.query(f"""
                SELECT ?p ?planned ?sap WHERE {{
                    GRAPH <{C.G_PLANS}> {{ ?l ex:product ?p ; ex:quantity ?planned . }}
                    GRAPH <{C.G_CDC}> {{ ?s ex:product ?p ; ex:quantity ?sap . }}
                    FILTER (?planned != ?sap) }}""", inferred=False)
            self.log("L2", "データ取り込み", "SAP の発注伝票を取り込み、確定した計画と照合: "
                     + ("一致" if not diff else f"{len(diff)} 件ずれ"), cdc)

        for p, r in shortages.items():
            self.log("L4", "ワークフロー", f"DC に「{self.plan.lines[p].name}」が {r['available']} しかないと断られたので、AI に数量の修正を頼んだ")
            self.set_time("10:33")
            q = self.agent.reduce_to_available(self.plan, p, r["available"])
            self.log("L4", "AI", f"「{self.plan.lines[p].name}」を {q} に減らした（減らすだけなので承認は不要）")
            res = self._confirm([p], "10:34", C.EX.OrderPolicy, f"DC の在庫に合わせて{self.plan.lines[p].name}を {q} に減らす",
                                rule="発注の数量を減らすのは承認不要")
            self.record_validation(f"確定（{p} の数量の修正）", res)

    def _wholesale_codes(self, products: list[str]) -> dict[str, str]:
        """小売側コードに対応する卸側コードを、OWL の推論（同じ UnifiedSKU）で引く。"""
        values = " ".join(f"sku:{p}" for p in products)
        rows = self.kg.query(f"""
            SELECT ?r ?code WHERE {{
                VALUES ?r {{ {values} }}
                ?r ex:sameProductCode ?w . ?w ex:wholesale true ; ex:code ?code . }}""")
        return {C.local(r["r"]): str(r["code"]) for r in rows}
