"""5層を組み立てて、選んだシナリオ（UC1 / UC2 / UC3）を動かす入口。画面と CLI とテストが使う。"""

from __future__ import annotations

from . import config as C
from .action_gate import ActionGate
from .forecast import DemandModel
from .layer1 import Layer1
from .layer2_etl import load_all, stream_readings
from .layer3_kg import KnowledgeGraph
from .layer4_kinetic import TomorrowOrderWorkflow
from .layer4_uc2 import PeakWorkflow
from .layer4_uc3 import EveningWorkflow
from .layer5_governance import AuditGraph
from .workflow import Context

LAYER_NAMES = {"L1": "基幹システム", "L2": "セマンティックETL", "L3": "ナレッジグラフ",
               "L4": "AI推論とキネティック実行", "L5": "業務画面とガバナンス"}
START_TIME = {"uc1": "09:00", "uc2": "12:00", "uc3": "15:30"}


class Demo:
    def __init__(self, scenario: str = "uc1"):
        if scenario not in C.SCENARIOS:
            raise ValueError(f"{scenario} というシナリオはない")
        self.scenario = scenario
        self.day = C.SCENARIOS[scenario]["day"]
        self.now = START_TIME[scenario]
        self.log_entries: list[dict] = []
        self.lake: list[dict] = []   # このデモの間に、履歴の蓄積先へ追記した計測値
        self.layer1 = Layer1(scenario)
        self.kg = KnowledgeGraph()
        self.audit = AuditGraph(self.day)
        self.gate = ActionGate(self.kg, self.audit, self.day)

        # レイヤー2 がレイヤー1 のコピーを三つ組にしてストアへ入れる
        self.etl_report = load_all(self.layer1, self.kg)
        self.log("L2", "ETL", "レイヤー1 のマスタ・台帳・棚割・推奨数・予報・イベント・ルートを三つ組に変換してストアへ",
                 self.etl_report)

        # レイヤー5 の画面に出す ODRL の権限（誰が、どの店の、何を承認できるか）
        self.permissions = [
            {"assignee": C.local(r["assignee"]), "label": str(r["label"]), "action": C.local(r["action"]),
             "target": C.local(r["target"]), "comment": str(r["comment"])}
            for r in self.kg.query("""
                SELECT ?assignee ?label ?action ?target ?comment WHERE {
                    ?perm a odrl:Permission ; odrl:assignee ?assignee ; odrl:action ?action ;
                          odrl:target ?target ; rdfs:comment ?comment .
                    ?assignee rdfs:label ?label . }""", inferred=False)]

        ctx = Context(self.layer1, self.kg, self.gate, self.log, self._set_time, self.lake)
        if scenario == "uc1":
            self.model = DemandModel(C.LAKE_DIR / "sales_history.csv")
            self.kg.update(f"""INSERT DATA {{ GRAPH <{C.G_STATE}> {{
                model:{self.model.version} a ex:ForecastModel ; ex:status ex:Active . }} }}""")
            self.log("L4", "需要予測モデル", f"履歴の蓄積先で学習した {self.model.version} を運用中として登録")
            self.workflow = TomorrowOrderWorkflow(ctx, self.model)
        elif scenario == "uc2":
            # 12:30 の時点の計測値が、ストリームでストアの最新の観測に入っている
            first = self.layer1.bms.history[0]
            stream_readings(self.kg, "ST-014", first["time"], first, self.lake)
            self.log("L2", "ETL", "BMS と電力メーターの計測値をストリームで受け、最新の観測を差し替え",
                     {k: v for k, v in first.items() if k != "time"})
            self.workflow = PeakWorkflow(ctx)
        else:
            self.workflow = EveningWorkflow(ctx)

    def _set_time(self, t: str) -> None:
        self.now = t

    def log(self, layer: str, actor: str, title: str, detail=None) -> None:
        self.log_entries.append({"time": self.now, "layer": layer, "layer_name": LAYER_NAMES[layer],
                                 "actor": actor, "title": title, "detail": detail})

    # ---- 操作 ---------------------------------------------------------------

    def do(self, action: str, **kwargs):
        self.workflow.do(action, **kwargs)

    # よく使う操作の別名（テストと CLI が使う）
    def start(self):
        self.do("start")

    def approve(self, approver: str | None = None):
        self.do("approve", **({"approver": approver} if approver else {}))

    def advance(self):
        self.do("advance")

    def run_all(self):
        """最後まで流す（承認は決められた人が承認する）。"""
        while True:
            enabled = [a for a in self.workflow.actions() if a["enabled"]]
            if not enabled:
                return
            self.do(enabled[0]["id"])

    # ---- 画面向けの状態 -------------------------------------------------------------

    def state(self) -> dict:
        wf = self.workflow
        base = {
            "scenario": self.scenario,
            "scenarios": [{"id": k, "title": v["title"], "day": v["day"].isoformat()} for k, v in C.SCENARIOS.items()],
            "title": wf.title,
            "day": self.day.isoformat(),
            "now": self.now,
            "workflow_state": wf.state,
            "actions": wf.actions(),
            "context": {}, "plan": None,          # UC1 のときだけ中身が入る
            "validations": wf.validations,
            "approval_request": wf.approval_request,
            "cloud_events": wf.cloud_events,
            "last_update": self.gate.last_update,
            "systems": self.layer1.snapshot(),
            "kg_stats": self.kg.stats(),
            "inferred_only": self.kg.count_inferred_only(),
            "audit": self.audit.entries,
            "audit_turtle": self.audit.turtle(),
            "log": self.log_entries,
            "revision": len(self.log_entries),
            "master": {
                "products": self.layer1.sap.products,
                "replenishment": self.layer1.sap.replenishment,
                "sites": self.layer1.sap.sites,
                "events": self.layer1.external.events,
                "weather": self.layer1.external.weather,
                "planogram": self.layer1.pos.planogram,
            },
            "permissions": self.permissions,
        }
        base.update(wf.payload())
        return base

    def sparql(self, q: str, inferred: bool = True) -> list[dict]:
        return [{k: str(v) for k, v in row.items()} for row in self.kg.query(q, inferred)]
