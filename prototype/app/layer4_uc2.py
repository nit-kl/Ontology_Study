"""レイヤー4 UC2 電力ピークの自動調整（AI エージェントの代役と、KINETIC のワークフロー）。

AI は、ナレッジグラフから「ピークに動かせる設備」（OWL の推論）と、その電力と動かせる幅を読み、
何もしないときの 14:00〜15:00 のデマンドを見積もる。電力ピークの方針の順に調整を足し、
契約電力から余裕を引いた値を下回ったら止める。案は SHACL を通らないと BMS へ届かない。
KINETIC は、時刻を進めるたびに BMS の計測値をストアへ流し、14:00〜15:00 は5分ごとに SHACL で見張る。

状態: 待機 → 実行待ち → 実行中 → 完了
"""

from __future__ import annotations

from dataclasses import dataclass, field

from rdflib import RDF, Graph, Literal, URIRef
from rdflib.namespace import XSD

from . import config as C
from .config import EX
from .layer1 import hhmm, hours
from .layer2_etl import stream_readings
from .workflow import Context, Workflow

PLAN_ID = "PS-014"
STORE = "ST-014"
TIMES = (["12:45", "13:00", "13:15", "13:30", "13:45", "14:00"]
         + [f"14:{m:02d}" for m in range(5, 60, 5)] + ["15:00", "15:15", "15:30"])
HEAT_KW_PER_DEGREE = 18.5   # 外気温が1℃上がると、空調以外の店の負荷がどれだけ増えるか（過去の実績から）


@dataclass
class Setting:
    key: str
    equipment: str
    kind: str                 # DefrostShift / Precool / Setpoint / Dimming
    label: str
    saving_kw: float
    values: dict = field(default_factory=dict)
    status: str = "提案"
    revert: bool = False

    def as_dict(self) -> dict:
        return self.__dict__.copy()


class EnergyAgent:
    def __init__(self, kg, log):
        self.kg, self.log = kg, log
        self.context: dict = {}

    def gather(self, day: str) -> dict:
        d = f'"{day}"^^xsd:date'
        pol = self.kg.query("""SELECT ?from ?to ?margin WHERE {
            ex:PeakPolicy ex:peakFrom ?from ; ex:peakTo ?to ; ex:marginKw ?margin . }""")[0]
        meter = self.kg.query(f"""SELECT ?contract ?latest WHERE {{
            equip:EM-014 ex:contractKw ?contract ; ex:latestDemandKw ?latest . }}""")[0]
        forecast = self.kg.query(f"""SELECT ?t WHERE {{
            store:{STORE} ex:area ?a . ?f a ex:WeatherForecast ; ex:area ?a ; ex:date {d} ; ex:maxCelsius ?t . }}""")
        oat = self.kg.query("SELECT ?v WHERE { sensor:OAT ex:latestValue ?v }")
        equipment = self.kg.query(f"""
            SELECT ?e ?type ?kind ?prio ?kw ?kwdeg ?defkw ?min ?max ?dim ?minout ?label WHERE {{
                ?e a ex:PeakAdjustable ; ex:inStore store:{STORE} ; ex:adjustableBy ?kind ; rdfs:label ?label .
                ?kind ex:priority ?prio .
                ?e a ?type . FILTER (?type IN (ex:AirHandlingUnit, ex:LightingZone, ex:FreezerCase, ex:RefrigeratedCase))
                OPTIONAL {{ ?e ex:ratedKw ?kw }} OPTIONAL {{ ?e ex:kwPerDegree ?kwdeg }} OPTIONAL {{ ?e ex:defrostKw ?defkw }}
                OPTIONAL {{ ?e ex:autoMin ?min }} OPTIONAL {{ ?e ex:autoMax ?max }}
                OPTIONAL {{ ?e ex:autoMaxDim ?dim }} OPTIONAL {{ ?e ex:autoMinOutput ?minout }}
            }} ORDER BY ?prio ?e""")
        loads = self.kg.query(f"""
            SELECT ?e ?type ?kw WHERE {{
                ?e ex:inStore store:{STORE} ; ex:ratedKw ?kw ; a ?type .
                FILTER (?type IN (ex:AirHandlingUnit, ex:LightingZone, ex:FreezerCase)) }}""")
        defrost = self.kg.query(f"""
            SELECT ?e ?at WHERE {{ ?e a ex:RefrigeratedCase ; ex:defrostAt ?at .
                FILTER (?at >= {pol['from']} && ?at < {pol['to']}) }} ORDER BY ?e""")
        all_defrost = {}
        for r in self.kg.query("SELECT ?e ?at WHERE { ?e a ex:RefrigeratedCase ; ex:defrostAt ?at }"):
            all_defrost.setdefault(C.local(r["e"]), []).append(float(r["at"]))

        eq = {}
        for r in equipment:
            eid = C.local(r["e"])
            eq.setdefault(eid, {"id": eid, "label": str(r["label"]), "type": C.local(r["type"]), "kinds": []})
            eq[eid]["kinds"].append(C.local(r["kind"]))
            for k in ("kw", "kwdeg", "defkw", "min", "max", "dim", "minout"):
                if r.get(k) is not None:
                    eq[eid][k] = float(r[k])
        peak_defrost = sorted({C.local(r["e"]) for r in defrost})
        equipment_now = sum(float(r["kw"]) for r in loads)
        max_t = float(forecast[0]["t"])
        oat_now = float(oat[0]["v"])
        other = float(meter["latest"]) - equipment_now + HEAT_KW_PER_DEGREE * (max_t - oat_now)
        defrost_kw = sum(eq[e].get("defkw", 0) for e in peak_defrost)
        projected = other + equipment_now + defrost_kw
        self.context = {
            "day": day, "contract_kw": float(meter["contract"]), "margin_kw": float(pol["margin"]),
            "peak": [float(pol["from"]), float(pol["to"])], "max_temp": max_t, "oat_now": oat_now,
            "latest_kw": float(meter["latest"]), "equipment_now_kw": equipment_now,
            "other_kw": round(other, 1), "defrost_in_peak": peak_defrost, "defrost_kw": defrost_kw,
            "projected_kw": round(projected, 1), "adjustable": list(eq.values()), "defrost_schedule": all_defrost,
        }
        self.log("L4", "AI", "天気予報、電力の使用量、調整できる設備を調べた",
                 {"予報": max_t, "直近のデマンド": meter["latest"], "契約電力": meter["contract"]})
        self.log("L3", "推論", "ピーク時に調整できる設備を割り出した",
                 {"霜取りがピークに重なる冷蔵ケース": peak_defrost,
                  "予冷・設定・調光できる設備": [e["id"] for e in eq.values() if e["type"] != "RefrigeratedCase"]})
        self.log("L4", "AI", f"このままだと 14〜15時の電力は {projected:.0f}kW（契約 {meter['contract']}kW）",
                 {"その他の負荷": round(other, 1), "空調・照明・冷凍": equipment_now, "霜取り": defrost_kw})
        return self.context

    def propose(self) -> list[Setting]:
        ctx = self.context
        target = ctx["contract_kw"] - ctx["margin_kw"]
        frm, to = (hhmm(h) for h in ctx["peak"])
        eq = {e["id"]: e for e in ctx["adjustable"]}
        candidates: list[list[Setting]] = []
        # 1. 霜取りの時刻をずらす（半分はピークの前、半分は後へ）
        peak_cases = ctx["defrost_in_peak"]
        half = len(peak_cases) // 2
        group = []
        for i, e in enumerate(peak_cases):
            new = [h for h in ctx["defrost_schedule"][e] if not (ctx["peak"][0] <= h < ctx["peak"][1])]
            moved = ctx["peak"][0] - 1.25 if i < half else ctx["peak"][1] + 0.25
            group.append(Setting(f"{e}-defrost", e, "DefrostShift", f"{e} の霜取りを {hhmm(moved)} へ",
                                 eq[e].get("defkw", 0), {"defrostAt": sorted(new + [moved])}))
        candidates.append(group)
        # 2. 冷凍ケースを先に冷やし、ピークの間は出力を絞る
        for e in (x for x in eq.values() if x["type"] == "FreezerCase"):
            out = e.get("minout", 100)
            candidates.append([
                Setting(f"{e['id']}-precool", e["id"], "Precool", f"{e['id']} を {hhmm(ctx['peak'][0] - 1)}〜{frm} に {e['min'] + 2:g}℃ へ予冷",
                        0, {"setpoint": e["min"] + 2, "from": hhmm(ctx["peak"][0] - 1), "to": frm}),
                Setting(f"{e['id']}-output", e["id"], "Precool", f"{e['id']} の出力を {frm}〜{to} は {out:g}%",
                        e["kw"] * (1 - out / 100), {"outputPercent": out, "from": frm, "to": to,
                                                     "predictedCaseMax": e["min"] + 2 + 0.25 * 12}),
            ])
        # 3. 空調の設定温度を自動の上限まで上げる
        ahus = [x for x in eq.values() if x["type"] == "AirHandlingUnit"]
        candidates.append([Setting(f"{e['id']}-setpoint", e["id"], "Setpoint", f"{e['id']} を {frm}〜{to} だけ {e['max']:g}℃",
                                   e["kwdeg"] * (e["max"] - 25), {"setpoint": e["max"], "from": frm, "to": to,
                                                                   "predictedZoneMax": 26.8}) for e in ahus])
        # 4. 窓際の照明を調光する
        candidates.append([Setting(f"{e['id']}-dim", e["id"], "Dimming", f"{e['id']} を {e['dim']:g}% 調光",
                                   e["kw"] * e["dim"] / 100, {"dimPercent": e["dim"], "from": frm, "to": to})
                           for e in eq.values() if e["type"] == "LightingZone" and e.get("dim")])

        chosen: list[Setting] = []
        level = ctx["projected_kw"]
        steps = []
        for group in candidates:
            if level <= target:
                break
            chosen += group
            level -= sum(s.saving_kw for s in group)
            steps.append({"kind": group[0].kind, "saving": round(sum(s.saving_kw for s in group), 1), "after": round(level, 1)})
        ctx["planned_kw"] = round(level, 1)
        ctx["steps"] = steps
        self.log("L4", "AI", f"優先順に調整を足して、見込みを {level:.0f}kW に下げた（目標 {target:.0f}kW 以下）", steps)
        return chosen

    def revert(self, equipment: str) -> Setting:
        return Setting(f"{equipment}-revert", equipment, "Setpoint", f"{equipment} を通常の設定に戻す", 0,
                       {"setpoint": 25}, revert=True)


def settings_graph(settings: list[Setting], day: str) -> Graph:
    g = Graph()
    plan = C.PLAN[PLAN_ID]
    g.add((plan, RDF.type, EX.AdjustmentPlan))
    g.add((plan, EX.store, C.STORE[STORE]))
    g.add((plan, EX.date, Literal(day, datatype=XSD.date)))
    for s in settings:
        n = C.SETTING[f"{PLAN_ID}/{s.key}"]
        g.add((n, RDF.type, EX.EquipmentSetting))
        g.add((n, EX.plan, plan))
        g.add((n, EX.equipment, C.EQUIP[s.equipment]))
        g.add((n, EX.kind, EX[s.kind]))
        if s.revert:
            g.add((n, EX.revert, Literal(True)))
        for k, v in s.values.items():
            if k == "defrostAt":
                for h in v:
                    g.add((n, EX.defrostAt, Literal(h, datatype=XSD.decimal)))
            elif k in ("from", "to"):
                g.add((n, EX[k + "Time"], Literal(v)))
            else:
                g.add((n, EX[k], Literal(v, datatype=XSD.decimal)))
    return g


def bms_commands(settings: list[Setting]) -> list[dict]:
    cmds = []
    for s in settings:
        v = s.values
        if s.revert:
            cmds.append({"equipment": s.equipment, "kind": "revert", "of": "setpoint"})
        elif s.kind == "DefrostShift":
            cmds.append({"equipment": s.equipment, "kind": "defrost", "value": v["defrostAt"]})
        elif "outputPercent" in v:
            cmds.append({"equipment": s.equipment, "kind": "output", "value": v["outputPercent"], "from": v["from"], "to": v["to"]})
        elif s.kind == "Precool":
            cmds.append({"equipment": s.equipment, "kind": "precool", "value": v["setpoint"], "from": v["from"], "to": v["to"]})
        elif s.kind == "Setpoint":
            cmds.append({"equipment": s.equipment, "kind": "setpoint", "value": v["setpoint"], "from": v["from"], "to": v["to"]})
        elif s.kind == "Dimming":
            cmds.append({"equipment": s.equipment, "kind": "dim", "value": v["dimPercent"], "from": v["from"], "to": v["to"]})
    return cmds


class PeakWorkflow(Workflow):
    title = C.SCENARIOS["uc2"]["title"]

    def __init__(self, ctx: Context):
        super().__init__(ctx)
        self.day = C.SCENARIOS["uc2"]["day"].isoformat()
        self.agent = EnergyAgent(self.kg, self.log)
        self.settings: dict[str, Setting] = {}
        self.cursor = 0
        self.monitor_log: list[dict] = []
        self.notifications: list[dict] = []
        self.pending: list[Setting] = []

    def next_time(self) -> str | None:
        return TIMES[self.cursor] if self.cursor < len(TIMES) else None

    def actions(self) -> list[dict]:
        nt = self.next_time()
        return [
            {"id": "start", "label": "① 12:30 ワークフローを起動", "enabled": self.state == "待機"},
            {"id": "advance", "label": f"② 時刻を進める（{nt}）" if nt else "② 時刻を進める",
             "enabled": self.state in ("実行待ち", "実行中") and nt is not None, "repeatable": True},
        ]

    def payload(self) -> dict:
        return {"uc2": {"context": self.agent.context, "settings": [s.as_dict() for s in self.settings.values()],
                        "next_time": self.next_time(), "times": TIMES, "monitor": self.monitor_log,
                        "notifications": self.notifications}}

    def _confirm(self, settings: list[Setting], time: str, label: str, rule: str):
        used = [C.FC[f"East/{self.day}"], C.EQUIP["EM-014"]]
        self.pending = settings
        return self.gate.confirm(settings_graph(settings, self.day),
                                 [C.SETTING[f"{PLAN_ID}/{s.key}"] for s in settings], time, C.EX.PeakPolicy, label,
                                 used=used, rule=rule, event_type="example.equipment.confirmed",
                                 data={"plan": PLAN_ID, "settings": [s.key for s in settings]})

    def act_start(self) -> None:
        self.set_time("12:30")
        self.log("L4", "ワークフロー", "12:30 になったので「電力ピーク対策」を始めた")
        self.log("L4", "ワークフロー", "AI に今日の電力調整の案を頼んだ")
        self.agent.gather(self.day)
        proposal = self.agent.propose()
        res = self.gate.pre_validate(settings_graph(proposal, self.day))
        self.record_validation("事前検証", res)
        if not res.conforms:
            self.log("L3", "ルール点検", "調整案をルールで点検: 問題あり", res.results)
            self.state = "失敗"
            return
        self.log("L3", "ルール点検", "調整案をルールで点検: 問題なし（食品の温度・霜取りの間隔・売場の暑さ）")
        needs = self.gate.needs_approval(settings_graph(proposal, self.day))
        self.log("L3", "ルール点検", "店長の承認: " + ("範囲内なので不要" if not needs else "必要"), needs or None)
        for s in proposal:
            self.settings[s.key] = s
        self.set_time("12:35")
        res = self._confirm(proposal, "12:35", "方針の範囲内の電力調整を自動で確定",
                            "設備操作の範囲（自動で動かしてよい範囲）の中")
        self.record_validation("確定（承認の点検を含む）", res)
        note = {"time": "12:35", "title": "本日の電力調整（自動）",
                "body": f"霜取り・冷凍ケース・空調・照明を調整。ピークの見込みは {self.agent.context['planned_kw']:.0f}kW"}
        self.notifications.append(note)
        self.log("L5", "店長アプリ", "店長に知らせた（承認は不要）", note)
        self.state = "実行待ち"

    def act_advance(self) -> None:
        t = self.next_time()
        self.cursor += 1
        self.set_time(t)
        if self.state == "実行待ち" and hours(t) >= 12.75:
            self.state = "実行中"
        row = self.l1.bms.tick(t)
        stream_readings(self.kg, STORE, t, row, self.ctx.lake)
        self.log("L1", "BMS", f"電力 {row['kw']:.0f}kW、窓際の売場 {row['ZT-2']}℃、冷凍ケース {row['FZ-01-T1']}℃",
                 {k: v for k, v in row.items() if k != "time"})
        peak = self.agent.context["peak"]
        if peak[0] <= hours(t) <= peak[1]:
            result = self.kg.monitor()
            self.monitor_log.append({"time": t, "conforms": result.conforms, "results": result.results})
            self.record_validation(f"見張り {t}", result)
            if result.conforms:
                self.log("L3", "ルール点検", f"{t} の温度チェック: 問題なし")
            else:
                self.log("L3", "ルール点検", f"{t} の温度チェック: 基準を超えた", result.results)
                for r in result.results:
                    if r["check"] == "売場の快適性":
                        ahu = r["message"].rsplit(": ", 1)[-1]
                        self._revert(t, ahu, r)
        if t == TIMES[-1]:
            peak_kw = max(h["kw"] for h in self.l1.bms.history if hours(h["time"]) >= 12.75)
            self.log("L1", "電力メーター", f"今日の電力の最大は {peak_kw:.0f}kW（契約 {self.l1.bms.contract_kw}kW）")
            self.log("L4", "ワークフロー", "ピークの時間が過ぎたので完了")
            self.notifications.append({"time": t, "title": "電力調整の結果",
                                       "body": f"今日のピークは最大 {peak_kw:.0f}kW。契約電力の範囲内でした"})
            self.state = "完了"

    def _revert(self, t: str, ahu: str, violation: dict) -> None:
        self.log("L4", "ワークフロー", f"売場（{violation['focus']}）の温度が基準を超えたので、AI に空調 {ahu} を元に戻すよう頼んだ")
        s = self.agent.revert(ahu)
        self.log("L4", "AI", f"空調 {ahu} だけ 25℃ に戻す案を出した（元に戻すだけなので承認は不要）")
        self.settings[s.key] = s
        if f"{ahu}-setpoint" in self.settings:
            self.settings[f"{ahu}-setpoint"].status = "取り消し"
        res = self._confirm([s], t, f"売場の快適性の違反（{violation['focus']}）で {ahu} を元に戻す", "元に戻す操作は安全側なので承認不要")
        self.record_validation(f"確定（{ahu} の戻し）", res)
        note = {"time": t, "title": f"{ahu} を元に戻しました", "body": violation["message"]}
        self.notifications.append(note)
        self.log("L5", "店長アプリ", "店長に知らせた", note)

    def on_confirmed(self, event: dict) -> None:
        settings = self.pending
        for s in settings:
            if s.status != "取り消し":
                s.status = "確定"
        self.log("L3", "ルール点検", "点検に合格したので確定した", event)
        self.log("L5", "監査記録", "誰が何をもとに決めたかを記録した", self.gate.audit.entries[-1])
        cmds = bms_commands(settings)
        self.l1.bms.apply(self.ctx_time(event), cmds)
        self.log("L1", "BMS", f"設備の設定を {len(cmds)} 件受け取った", cmds)

    @staticmethod
    def ctx_time(event: dict) -> str:
        return event["time"][11:16]
