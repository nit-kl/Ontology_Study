"""レイヤー1 基幹システムのシミュレーター。

原本を持ち、上の層からの書き戻しを受け付ける。判断はしない。
SAP（商品・拠点・自動補充・在庫転送オーダ）、POS（店頭在庫・入荷予定・電子棚札）、WMS（DC の在庫と引き当て）、
スタッフ端末（作業）、BMS（店舗設備・センサー・電力メーター）、TMS（配送車とルート）、外部データ（予報・イベント情報）を、
ファイルから読んでメモリに持つ。どのファイルを読むかはシナリオ（uc1 / uc2 / uc3）で決まる。
"""

from __future__ import annotations

import copy
import csv
import json
from dataclasses import dataclass, field

from .config import LAYER1_DIR


def _csv(name: str) -> list[dict]:
    return list(csv.DictReader((LAYER1_DIR / name).open(encoding="utf-8")))


def _json(name: str):
    return json.loads((LAYER1_DIR / name).read_text(encoding="utf-8"))


def hours(t: str) -> float:
    """"14:20" → 14.333…"""
    h, m = t.split(":")
    return int(h) + int(m) / 60


def hhmm(x: float) -> str:
    return f"{int(x):02d}:{round((x - int(x)) * 60):02d}"


class SAP:
    """SAP S/4HANA。商品マスタ、拠点、自動補充の推奨数、在庫転送オーダ（STO）の原本。"""

    def __init__(self):
        self.products = _csv("sap_products.csv")
        self.sites = _csv("sap_sites.csv")
        self.replenishment = _csv("sap_replenishment.csv")
        self.orders: dict[str, dict] = {}   # STO 番号 → {kind, store, dc, date, lines: {商品: 数}}
        self.changes: list[dict] = []        # CDC で上へ流す変更

    def upsert_order(self, sto: str, store: str, dc: str, day: str, lines: dict[str, int],
                     kind: str = "補充") -> dict:
        """BAPI: 在庫転送オーダを作る、または明細を足す・直す。dc は供給元（DC か、店間移動なら送り出す店）。"""
        order = self.orders.setdefault(sto, {"kind": kind, "store": store, "dc": dc, "date": day, "lines": {}})
        order["lines"].update(lines)
        self.changes.append({"table": "STO", "sto": sto, "lines": dict(lines)})
        return copy.deepcopy(order)

    def price(self, product: str) -> int:
        return int(next(p["price"] for p in self.products if p["retail_code"] == product))


class POS:
    """店舗システム（POS・棚割・電子棚札）。店頭在庫と今日の販売数の原本。入荷予定と売価の変更を受け付ける。"""

    def __init__(self, state_file: str, hours_open: int, hours_left: int):
        self.state = _json(state_file)
        self.planogram = _csv("planogram.csv")
        self.hours_open, self.hours_left = hours_open, hours_left
        self.incoming: dict[str, dict[str, int]] = {}   # 店 → 商品 → 入荷予定
        self.labels: list[dict] = []                    # 電子棚札に送った売価の変更

    def stock_api(self, store: str, products: list[str] | None = None) -> dict:
        """POS の在庫 API。今の店頭在庫と今日の販売数（あれば期限とネットスーパーの引当分）を返す。"""
        items = self.state.get(store, {})
        return {p: dict(items.get(p, {"stock": 0, "sold_today": 0}),
                        hours_open=self.hours_open, hours_left=self.hours_left)
                for p in (products if products is not None else list(items))}

    def set_incoming(self, store: str, lines: dict[str, int]) -> None:
        self.incoming.setdefault(store, {}).update(lines)

    def receive(self, store: str, lines: dict[str, int]) -> None:
        for p, q in lines.items():
            self.state.setdefault(store, {}).setdefault(p, {"stock": 0, "sold_today": 0})
            self.state[store][p]["stock"] += q
            self.incoming.get(store, {}).pop(p, None)

    def take_out(self, store: str, product: str, qty: int) -> None:
        self.state[store][product]["stock"] -= qty

    def set_price(self, store: str, product: str, base: int, discount: int, time: str, reason: str) -> dict:
        """電子棚札と POS の売価を変える（見切りの値引き）。"""
        label = {"store": store, "product": product, "base": base, "discount": discount,
                 "price": round(base * (100 - discount) / 100), "time": time, "reason": reason}
        self.labels.append(label)
        return label


class WMS:
    """WMS。配送センターの在庫（卸側コード）と、店への出荷の引き当て。"""

    def __init__(self):
        self.stock = _json("wms_dc_stock.json")
        self.allocations: dict[str, dict[str, int]] = {}   # STO → 卸側コード → 数

    def allocate(self, dc: str, sto: str, wholesale_code: str, qty: int) -> dict:
        """明日 5:00 の出荷に引き当てる。足りなければ引き当てずに、残りの数を返す。"""
        already = self.allocations.get(sto, {}).get(wholesale_code, 0)
        available = self.stock[dc][wholesale_code] + already
        if qty > available:
            return {"ok": False, "code": wholesale_code, "requested": qty, "available": available}
        self.stock[dc][wholesale_code] = available - qty
        self.allocations.setdefault(sto, {})[wholesale_code] = qty
        return {"ok": True, "code": wholesale_code, "allocated": qty}


@dataclass
class StaffTerminal:
    """スタッフ端末。作業指示を受け、完了と実際の数を記録する。"""
    tasks: list[dict] = field(default_factory=list)

    def upsert_task(self, key: str, store: str, when: str, text: str) -> None:
        """同じ key の作業があれば中身を差し替え、なければ足す。"""
        for t in self.tasks:
            if t["key"] == key:
                t.update(when=when, text=text)
                return
        self.tasks.append({"key": key, "store": store, "when": when, "text": text, "done": False, "result": ""})

    def pick(self, pos: "POS", key: str, store: str, product: str, qty: int) -> int:
        """取り出し作業。棚で見つからない分（POS の数と棚の実物のずれ）があれば、実際に見つかった数だけ返す。"""
        missing = pos.state[store][product].get("shelf_missing", 0)
        actual = max(0, qty - missing)
        self.complete(key, f"{actual} 見つかった（予定 {qty}）")
        return actual

    def complete(self, key: str, result: str = "") -> None:
        for t in self.tasks:
            if t["key"] == key:
                t.update(done=True, result=result)

    def complete_all(self, store: str) -> None:
        for t in self.tasks:
            if t["store"] == store:
                t["done"] = True


class BMS:
    """BMS（店舗設備の監視と制御）と電力メーター。

    KINETIC から時刻つきの設定を受け取り、tick(時刻) のたびに、その時刻の設備の状態からセンサーの値と
    デマンドを計算する。時刻つきの設定は BMS が自分で時刻どおりに当て、時刻が過ぎたら通常へ戻す。
    """

    STEP = 5 / 60   # 5分

    def __init__(self):
        cfg = _json("bms_equipment.json")
        self.cfg = cfg
        self.contract_kw = cfg["meter"]["contract_kw"]
        self.equipment = {e["id"]: dict(e) for e in cfg["equipment"]}
        self.sensors = dict(cfg["initial"]["sensors"])
        self.now = cfg["initial"]["time"]
        self.timed: list[dict] = []         # {id, equipment, kind, value, from, to}
        self.history: list[dict] = [{"time": self.now, "kw": cfg["initial"]["meter_kw"], **self.sensors}]
        self.alarms: list[dict] = []
        self.commands: list[dict] = []      # 受け付けた制御コマンドの記録

    # ---- 書き戻しの受け口（BMS の制御コマンド） --------------------------------------

    def apply(self, time: str, settings: list[dict]) -> None:
        """時刻つきの設定をまとめて受け付ける。kind: defrost / setpoint / dim / output / precool / revert。"""
        for s in settings:
            self.commands.append({"time": time, **s})
            if s["kind"] == "defrost":
                self.equipment[s["equipment"]]["defrost"] = list(s["value"])
            elif s["kind"] == "revert":
                self.timed = [t for t in self.timed if not (t["equipment"] == s["equipment"] and t["kind"] == s["of"])]
            else:
                self.timed.append(dict(s))

    # ---- 時刻つきの設定を当てた、その時刻の状態 ---------------------------------------

    def _active(self, eq: str, kind: str, t: float):
        for s in self.timed:
            if s["equipment"] == eq and s["kind"] == kind and hours(s["from"]) <= t < hours(s["to"]):
                return s["value"]
        return None

    def effective(self, t: float) -> dict:
        out = {}
        for eid, e in self.equipment.items():
            st = {}
            if e["type"] == "AirHandlingUnit":
                st["setpoint"] = self._active(eid, "setpoint", t) or e["setpoint"]
            elif e["type"] == "LightingZone":
                st["dim"] = self._active(eid, "dim", t) or 0
            elif e["type"] == "FreezerCase":
                pre = self._active(eid, "precool", t)
                st["setpoint"] = pre if pre is not None else e["setpoint"]
                st["precool"] = pre is not None
                st["output"] = self._active(eid, "output", t) or 100
            elif e["type"] == "RefrigeratedCase":
                st["defrosting"] = any(d <= t < d + 0.5 for d in e["defrost"])
            out[eid] = st
        return out

    def demand(self, t: float) -> float:
        """その時刻のデマンド（kW）。設備の分と、それ以外の店の負荷の和。"""
        eff = self.effective(t)
        other = 495 if t < 13 else 500 if t < 14 else 550 if t < 15 else 520
        kw = other
        for eid, e in self.equipment.items():
            st = eff[eid]
            if e["type"] == "AirHandlingUnit":
                kw += e["kw"] - e["kw_per_degree"] * (st["setpoint"] - 25)
            elif e["type"] == "LightingZone":
                kw += e["kw"] * (1 - st["dim"] / 100)
            elif e["type"] == "FreezerCase":
                kw += e["precool_kw"] if st["precool"] else e["kw"] * st["output"] / 100
            elif e["type"] == "RefrigeratedCase" and st["defrosting"]:
                kw += e["defrost_kw"]
        return round(kw, 1)

    # ---- 時間を進める --------------------------------------------------------

    def tick(self, time: str) -> dict:
        """前の時刻から5分刻みで設備とセンサーを動かし、この時刻の値を返す。"""
        t0, t1 = hours(self.now), hours(time)
        t = t0
        while t < t1 - 1e-9:
            self._step(t)
            t += self.STEP
        self.now = time
        row = {"time": time, "kw": self.demand(t1), **{k: round(v, 1) for k, v in self.sensors.items()}}
        self.history.append(row)
        if row["ZT-2"] > 27.0 and not any(a["sensor"] == "ZT-2" and a["time"] == time for a in self.alarms):
            self.alarms.append({"time": time, "sensor": "ZT-2", "text": "ZT-2 室温 上限警報 (27.0℃)", "value": row["ZT-2"]})
        return row

    def _step(self, t: float) -> None:
        eff = self.effective(t)
        s = self.sensors
        afternoon = t >= 14

        def toward(key: str, target: float, rate: float):
            v = s[key]
            s[key] = min(v + rate, target) if v < target else max(v - rate, target)

        # 売場の温度: 空調の設定と、午後の日射（窓際は強い）で決まる目標へ近づく
        for zt, ahu, window in (("ZT-1", "AHU-1", False), ("ZT-2", "AHU-2", True), ("ZT-3", "AHU-3", False)):
            sp = eff[ahu]["setpoint"]
            if window:
                target = (27.8 if sp >= 26 else 26.2) if afternoon else 26.0
                toward(zt, target, 0.3)
            else:
                toward(zt, (26.6 if sp >= 26 else 25.8) if afternoon else 25.4, 0.1)
        # 冷凍ケース: 予冷で下がり、出力を絞ると上がる
        fz = eff["FZ-01"]
        if fz["precool"]:
            toward("FZ-01-T1", fz["setpoint"], 0.2)
        elif fz["output"] < 100:
            s["FZ-01-T1"] = round(s["FZ-01-T1"] + 0.25, 2)
        else:
            toward("FZ-01-T1", -20.0, 0.3)
        # 外気温: 午後に向けて予報の最高気温（37℃）まで上がる
        toward("OAT", 37.0 if t >= 13.5 else 36.0, 0.2)
        # 冷蔵ケース: 霜取りの間だけ少し上がる
        for sid, rc in (("RC-03-T1", "RC-03"), ("RC-08-T1", "RC-08")):
            toward(sid, 4.4 if eff[rc]["defrosting"] else 3.4, 0.25)


class TMS:
    """TMS。配送車の台帳、今夜のルート、立ち寄りの追加。"""

    def __init__(self):
        self.vehicles = _json("tms_vehicles.json")
        self.stops: list[dict] = []   # {vehicle, store, time, purpose, status}

    def add_stop(self, vehicle: str, store: str, time: str, purpose: str) -> dict:
        stop = {"vehicle": vehicle, "store": store, "time": time, "purpose": purpose, "status": "予定"}
        self.stops = [s for s in self.stops if not (s["vehicle"] == vehicle and s["store"] == store)] + [stop]
        return stop

    def update_stop(self, vehicle: str, store: str, **fields) -> None:
        for s in self.stops:
            if s["vehicle"] == vehicle and s["store"] == store:
                s.update(fields)


class External:
    """外部データ。気象局の予報と、地域のイベント情報。"""

    def __init__(self):
        self.weather = _json("weather.json")
        self.events = _json("events.json")


# シナリオごとの POS の元データと、その時刻の開店からの時間・閉店までの時間
POS_SCENARIO = {"uc1": ("pos_store_state.json", 2, 12),   # 10:00
                "uc2": ("pos_store_state.json", 2, 12),
                "uc3": ("pos_uc3.json", 8, 6)}             # 16:00


class Layer1:
    def __init__(self, scenario: str = "uc1"):
        self.scenario = scenario
        self.sap = SAP()
        self.pos = POS(*POS_SCENARIO[scenario])
        self.wms = WMS()
        self.staff = StaffTerminal()
        self.bms = BMS()
        self.tms = TMS()
        self.external = External()

    def snapshot(self) -> dict:
        return {
            "sap_orders": copy.deepcopy(self.sap.orders),
            "wms_allocations": copy.deepcopy(self.wms.allocations),
            "wms_stock": copy.deepcopy(self.wms.stock),
            "pos_incoming": copy.deepcopy(self.pos.incoming),
            "pos_stock": {s: {p: v["stock"] for p, v in ps.items()} for s, ps in self.pos.state.items()},
            "pos_sold_today": {s: {p: v["sold_today"] for p, v in ps.items()} for s, ps in self.pos.state.items()},
            "pos_detail": copy.deepcopy(self.pos.state),
            "pos_labels": copy.deepcopy(self.pos.labels),
            "staff_tasks": copy.deepcopy(self.staff.tasks),
            "bms": {"now": self.bms.now, "contract_kw": self.bms.contract_kw,
                    "equipment": copy.deepcopy(self.bms.cfg["equipment"]),
                    "effective": self.bms.effective(hours(self.bms.now)),
                    "defrost": {k: v["defrost"] for k, v in self.bms.equipment.items() if "defrost" in v},
                    "timed": copy.deepcopy(self.bms.timed), "sensors": dict(self.bms.sensors),
                    "history": copy.deepcopy(self.bms.history), "alarms": copy.deepcopy(self.bms.alarms),
                    "commands": copy.deepcopy(self.bms.commands), "zones": self.bms.cfg["zones"]},
            "tms": {"vehicles": copy.deepcopy(self.tms.vehicles), "stops": copy.deepcopy(self.tms.stops)},
        }
