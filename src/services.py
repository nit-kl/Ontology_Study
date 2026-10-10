"""Brick / BOT の関係と、空調時系列・来店状況を結合して朝の機器指令を作る。"""

from __future__ import annotations

from datetime import datetime

from src import operational_db as db
from src.graph_store import knowledge_graph
from src.operational_db import SqlTrace
from src.settings import AS_OF_TIME, energy_window

_WEEKDAY = "月火水木金土日"


class Evidence:
    def __init__(self) -> None:
        self.sparql: list[dict[str, str]] = []
        self.sql: list[dict] = []

    def add_graph(self, name: str, rows_and_text: tuple[list[dict], str]) -> list[dict]:
        rows, text = rows_and_text
        self.sparql.append({"name": name, "text": text.strip()})
        return rows

    def add_sql(self, trace: SqlTrace) -> None:
        self.sql.append({"statement": trace.statement, "params": trace.params})


def _graph(name: str, evidence: Evidence) -> list[dict]:
    return evidence.add_graph(name, knowledge_graph().query_file(name))


def _number(value) -> float:
    return float(value)


def _one_decimal(value: float) -> float:
    return float(f"{value:.1f}")


def load_store(evidence: Evidence) -> dict:
    rows = _graph("store.rq", evidence)
    if len(rows) != 1:
        raise RuntimeError("モデル店舗を1件に特定できません。")
    return rows[0]


def load_processes(evidence: Evidence) -> list[dict]:
    return _graph("processes.rq", evidence)


def load_kpis(evidence: Evidence) -> list[dict]:
    return _graph("kpis.rq", evidence)


def load_datasets(evidence: Evidence) -> list[dict]:
    grouped: dict[str, dict] = {}
    for row in _graph("datasets.rq", evidence):
        item = grouped.setdefault(
            row["table"],
            {
                "label": row["label"],
                "table": row["table"],
                "comment": row["comment"],
                "cadence": row["cadence"],
                "keys": [],
                "attributes": [],
            },
        )
        bucket = item["keys"] if row["kind"] == "key" else item["attributes"]
        if row["value"] not in bucket:
            bucket.append(row["value"])
    return list(grouped.values())


def load_bridge(evidence: Evidence) -> list[dict]:
    return _graph("bridge.rq", evidence)


def latest_readings(evidence: Evidence) -> dict[str, dict]:
    readings, trace = db.latest_readings(AS_OF_TIME)
    evidence.add_sql(trace)
    return readings


def load_zones(evidence: Evidence, readings: dict[str, dict]) -> list[dict]:
    rows = []
    for row in _graph("zones.rq", evidence):
        temperature = readings[row["tempCode"]]
        humidity = readings[row["rhCode"]]
        setpoint = _number(row["setpoint"])
        tolerance = _number(row["tolerance"])
        temp_value = _number(temperature["value"])
        rh_value = _number(humidity["value"])
        deviation = _one_decimal(temp_value - setpoint)
        comfort = "快適範囲外" if abs(deviation) > tolerance else "快適範囲内"
        high = _number(row["humidityHigh"])
        low = _number(row["humidityLow"])
        if rh_value > high:
            humidity_status = "高め"
        elif rh_value < low:
            humidity_status = "低め"
        else:
            humidity_status = "範囲内"
        rows.append(
            {
                "label": row["label"],
                "setpoint": setpoint,
                "tolerance": tolerance,
                "temperature": temp_value,
                "recordedAt": temperature["at"],
                "deviation": deviation,
                "comfort": comfort,
                "humidity": rh_value,
                "humidityLow": low,
                "humidityHigh": high,
                "humidityStatus": humidity_status,
                "tempCode": row["tempCode"],
                "rhCode": row["rhCode"],
            }
        )
    return rows


def load_equipment(evidence: Evidence, readings: dict[str, dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for row in _graph("equipment.rq", evidence):
        item = grouped.setdefault(
            row["code"],
            {
                "code": row["code"],
                "label": row["label"],
                "kind": row["kind"],
                "location": row["location"],
                "feeds": [],
                "capacity": row["capacity"],
                "interval": row["interval"],
                "runCode": row["runCode"],
            },
        )
        if row["feedsLabel"] and row["feedsLabel"] not in item["feeds"]:
            item["feeds"].append(row["feedsLabel"])
        if item["capacity"] is None and row["capacity"] is not None:
            item["capacity"] = row["capacity"]
        if item["interval"] is None and row["interval"] is not None:
            item["interval"] = row["interval"]
        if item["runCode"] is None and row["runCode"] is not None:
            item["runCode"] = row["runCode"]
    rows = []
    for item in grouped.values():
        runtime = None
        if item["runCode"]:
            runtime = _number(readings[item["runCode"]]["value"])
        interval = None if item["interval"] is None else int(item["interval"])
        if interval is None or runtime is None:
            service = "—"
        elif runtime >= interval:
            service = "点検"
        else:
            service = "期間内"
        capacity = None if item["capacity"] is None else _number(item["capacity"])
        rows.append(
            {
                "code": item["code"],
                "label": item["label"],
                "kind": item["kind"],
                "location": item["location"],
                "feeds": "、".join(item["feeds"]),
                "capacity": capacity,
                "runtime": runtime,
                "runCode": item["runCode"],
                "serviceHours": interval,
                "service": service,
            }
        )
    return sorted(rows, key=lambda row: row["code"])


def load_power(evidence: Evidence, readings: dict[str, dict]) -> dict:
    rows = _graph("power.rq", evidence)
    if len(rows) != 1:
        raise RuntimeError("室外機の電力ポイントを1件に特定できません。")
    row = rows[0]
    start, end = energy_window()
    amount, trace = db.energy_sum(row["energyCode"], start, end)
    evidence.add_sql(trace)
    return {
        "code": row["equipCode"],
        "label": row["equipLabel"],
        "capacity": _number(row["capacity"]),
        "outside": _number(readings[row["oaCode"]]["value"]),
        "outsideAt": readings[row["oaCode"]]["at"],
        "power": _number(readings[row["powerCode"]]["value"]),
        "powerAt": readings[row["powerCode"]]["at"],
        "todayEnergy": _number(readings[row["energyCode"]]["value"]),
        "weekEnergy": amount,
        "oaCode": row["oaCode"],
        "powerCode": row["powerCode"],
    }


def table_counts(evidence: Evidence) -> dict:
    totals, trace = db.counts()
    evidence.add_sql(trace)
    return totals


def _fmt(value) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.1f}"


def load_policy(evidence: Evidence) -> dict:
    rows = _graph("policy.rq", evidence)
    if len(rows) != 1:
        raise RuntimeError("機器指令の方針を1件に特定できません。")
    return rows[0]


def load_actuators(evidence: Evidence) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for row in _graph("actuators.rq", evidence):
        role = row["role"]
        if role in found:
            raise RuntimeError(f"指令上の役割が重複しています: {role}")
        found[role] = row
    expected = {"reliefSetpoint", "salesAir", "dehumidify", "airCurtain", "exhaust"}
    missing = sorted(expected - set(found))
    if missing:
        raise RuntimeError(f"指令に必要な機器がグラフにありません: {missing}")
    return found


def load_context(evidence: Evidence) -> dict:
    footfall, trace = db.latest_footfall()
    evidence.add_sql(trace)
    door, trace = db.latest_door()
    evidence.add_sql(trace)
    forecast_rows, trace = db.forecasts()
    evidence.add_sql(trace)
    mode_rows, trace = db.latest_modes()
    evidence.add_sql(trace)
    if footfall is None or door is None or not forecast_rows:
        raise RuntimeError("来店人数、ドア開放率、外気予報のいずれかが基準時刻までにありません。")
    return {
        "footfall": int(footfall["people_count"]),
        "footfallAt": footfall["recorded_at"],
        "doorOpenRatio": float(door["open_ratio"]),
        "doorAt": door["recorded_at"],
        "forecast": [
            {"targetAt": row["target_at"], "temperature": float(row["outside_temp_c"])}
            for row in forecast_rows
        ],
        "modes": {row["equipment_code"]: row["mode_code"] for row in mode_rows},
    }


def _speed_label(policy: dict, step) -> str:
    labels = {
        int(policy["fanSpeedLow"]): policy["speedLabelLow"],
        int(policy["fanSpeedMid"]): policy["speedLabelMid"],
        int(policy["fanSpeedHigh"]): policy["speedLabelHigh"],
    }
    return labels[int(step)]


def _mode_label(policy: dict, code: str) -> str:
    if code == policy["coolingMode"]:
        return policy["coolingModeLabel"]
    if code == policy["dryMode"]:
        return policy["dryModeLabel"]
    return code


def _zone(zones: list[dict], label: str) -> dict:
    for zone in zones:
        if zone["label"] == label:
            return zone
    raise RuntimeError(f"指令が参照するゾーンがありません: {label}")


def _issue(title: str, status: str, finding: str, relations: list[str], readings: list[str]) -> dict:
    return {
        "title": title,
        "status": status,
        "finding": finding,
        "relations": relations,
        "readings": readings,
    }


def _command(
    actuator: dict,
    action: str,
    current: str,
    command: str,
    reason: str,
    revert: str,
    value,
    issue_title: str,
    because: str,
) -> dict:
    return {
        "id": None,
        "kind": "機器指令",
        "code": actuator["code"],
        "label": actuator["label"],
        "action": action,
        "current": current,
        "command": command,
        "reason": reason,
        "revert": revert,
        "commandValue": value,
        "issueTitle": issue_title,
        "because": because,
    }


def decide(
    zones: list[dict],
    equipment: list[dict],
    power: dict,
    policy: dict,
    actuators: dict[str, dict],
    readings: dict[str, dict],
    context: dict,
) -> dict:
    sales = _zone(zones, actuators["salesAir"]["zoneLabel"])
    back = _zone(zones, actuators["reliefSetpoint"]["zoneLabel"])
    stock = _zone(zones, actuators["dehumidify"]["zoneLabel"])
    ratio = power["power"] / power["capacity"]
    near = ratio >= float(policy["nearCapacityRatio"])
    sales_hot = sales["comfort"] == "快適範囲外"
    back_ok = back["comfort"] == "快適範囲内"
    busy = context["footfall"] > int(policy["footfallBaseline"])
    door_open = context["doorOpenRatio"] > float(policy["doorOpenRatioLimit"])
    outside_high = power["outside"] >= float(policy["ventilationCutoffCelsius"])
    peak = max(context["forecast"], key=lambda item: item["temperature"])
    rising = peak["temperature"] > power["outside"]
    stock_humid = stock["humidityStatus"] == "高め"
    sales_unit = actuators["salesAir"]
    back_unit = actuators["reliefSetpoint"]
    stock_unit = actuators["dehumidify"]
    curtain = actuators["airCurtain"]
    exhaust = actuators["exhaust"]
    issues = []
    if sales_hot or near:
        measured = [
            (
                f"{sales['label']}は{_fmt(sales['temperature'])}℃。"
                f"快適幅は{_fmt(sales['setpoint'])}±{_fmt(sales['tolerance'])}℃で、{sales['comfort']}。"
            ),
            (
                f"{power['label']}は{_fmt(power['power'])}kW。"
                f"定格{_fmt(power['capacity'])}kWの{_fmt(float(policy['nearCapacityRatio']) * 100)}%以上。"
                if near
                else f"{power['label']}は{_fmt(power['power'])}kW。定格は{_fmt(power['capacity'])}kW。"
            ),
            (
                f"{back['label']}は{_fmt(back['temperature'])}℃。"
                f"快適幅は{_fmt(back['setpoint'])}±{_fmt(back['tolerance'])}℃で、{back['comfort']}。"
            ),
        ]
        if busy:
            measured.append(f"来店は{context['footfall']}人。平常の{policy['footfallBaseline']}人を超えている。")
        found = []
        if sales_hot:
            found.append(f"{sales['label']}は快適幅の外")
        if near:
            found.append(f"{power['label']}は定格に近い")
        finding = "、".join(found) + "。"
        if back_ok:
            finding += f"冷房を分けている{back['label']}は快適幅の内なので、売場だけを強く冷やせない。"
        else:
            finding += f"同じ{power['label']}の冷房を{back['label']}と分けている。"
        if busy:
            finding += "来店も平常を超えている。"
        issues.append(
            _issue(
                "売場を強く冷やせない",
                "bad" if sales_hot else "warn",
                finding,
                [
                    f"{power['label']}が、{sales_unit['label']}と{back_unit['label']}へ冷房を分けている。",
                    f"{sales_unit['label']}は{sales['label']}を冷やし、{back_unit['label']}は{back['label']}を冷やしている。",
                ],
                measured,
            )
        )
    elif busy:
        issues.append(
            _issue(
                "来店が平常を超えている",
                "warn",
                f"来店は{context['footfall']}人で、平常の{policy['footfallBaseline']}人を超えている。",
                ["来店人数の平常値は、店舗の指令方針にある。"],
                [f"直近1時間の来店は{context['footfall']}人。"],
            )
        )
    if stock_humid:
        issues.append(
            _issue(
                "倉庫の湿度が上限を超えている",
                "bad",
                f"{stock_unit['label']}が冷やしている{stock['label']}の湿度が、上限を超えている。",
                [f"{stock_unit['label']}が{stock['label']}を冷やしている。"],
                [f"湿度は{_fmt(stock['humidity'])}%。上限{_fmt(stock['humidityHigh'])}%を超えている。"],
            )
        )
    inflow_readings = []
    inflow_bits = []
    if sales_hot:
        inflow_readings.append(
            f"{sales['label']}は{_fmt(sales['temperature'])}℃で、快適幅{_fmt(sales['setpoint'])}±{_fmt(sales['tolerance'])}℃の外。"
        )
    if outside_high:
        inflow_readings.append(
            f"外気は{_fmt(power['outside'])}℃。換気を弱める{_fmt(policy['ventilationCutoffCelsius'])}℃以上。"
        )
        inflow_bits.append("外気が暑い")
    if door_open:
        inflow_readings.append(
            f"ドアの開放率は{_fmt(context['doorOpenRatio'] * 100)}%。上限{_fmt(float(policy['doorOpenRatioLimit']) * 100)}%を超えている。"
        )
        inflow_bits.append("ドアが開いている")
    if rising:
        inflow_readings.append(
            f"{peak['targetAt'][11:16]}の予報は{_fmt(peak['temperature'])}℃で、いまの外気より高い。"
        )
        inflow_bits.append("このあとも外気温が上がる")
    if inflow_bits:
        issues.append(
            _issue(
                "暑い外気が売場に入っている",
                "bad",
                f"{curtain['label']}と{exhaust['label']}が{sales['label']}へ空気を送っている。{'、'.join(inflow_bits)}。",
                [
                    f"{curtain['label']}が{sales['label']}へ空気を送っている。",
                    f"{exhaust['label']}も{sales['label']}へ空気を送っている。",
                ],
                inflow_readings,
            )
        )
    for row in equipment:
        if row["service"] != "点検":
            continue
        issues.append(
            _issue(
                "フィルタが点検間隔を超えている",
                "bad",
                f"{row['label']}の一部であるフィルタが、点検間隔を超えている。",
                [f"フィルタは{row['label']}の一部。"],
                [f"運転時間は{_fmt(row['runtime'])}時間。点検間隔{_fmt(row['serviceHours'])}時間に達している。"],
            )
        )
    commands = []

    if sales_hot and near and back_ok and busy:
        actuator = actuators["reliefSetpoint"]
        current = float(actuator["setpoint"])
        target = current + float(policy["setpointReliefCelsius"])
        commands.append(
            {
                **_command(
                    actuator,
                    "冷房設定温度を上げる",
                    f"{_fmt(current)}℃",
                    f"{_fmt(target)}℃",
                    (
                        f"売場は{_fmt(sales['temperature'])}℃で快適範囲外、来店は直近1時間 {context['footfall']} 人で平常の "
                        f"{policy['footfallBaseline']} 人を超えている。室外機は定格の {_fmt(float(policy['nearCapacityRatio']) * 100)}% 以上を使っている。"
                        f"バックルームは{_fmt(back['temperature'])}℃で快適範囲内なので、設定を {_fmt(policy['setpointReliefCelsius'])}℃ 緩めて売場へ冷房能力を回す。"
                    ),
                    f"来店{policy['footfallBaseline']}人以下で{_fmt(current)}℃",
                    target,
                    "売場を強く冷やせない",
                    (
                        f"{back['label']}は快適幅の内なので、設定を{_fmt(current)}℃から{_fmt(target)}℃へ緩める。"
                        f"同じ{power['label']}の冷房を、暑い{sales['label']}へ回す。"
                    ),
                ),
                "id": "CMD-BACK-SP",
            }
        )

    if sales_hot and near:
        actuator = actuators["salesAir"]
        current_speed = int(readings[actuator["fanCode"]]["value"])
        high = int(policy["fanSpeedHigh"])
        hold = float(actuator["setpoint"])
        if current_speed != high:
            commands.append(
                {
                    **_command(
                        actuator,
                        "設定温度は維持し、風量を上げる",
                        f"{_fmt(hold)}℃ {_speed_label(policy, current_speed)}",
                        f"{_fmt(hold)}℃ {_speed_label(policy, high)}",
                        (
                            f"室外機は {_fmt(power['power'])} kW で定格 {_fmt(power['capacity'])} kW に近い。"
                            f"売場の設定温度は {_fmt(hold)}℃ のままにし、風量を"
                            f"{_speed_label(policy, current_speed)}から{_speed_label(policy, high)}にして空気を動かす。"
                        ),
                        f"売場が快適幅内で風量{_speed_label(policy, policy['fanSpeedMid'])}",
                        high,
                        "売場を強く冷やせない",
                        (
                            f"{power['label']}は定格に近いので、{sales['label']}の設定温度は{_fmt(hold)}℃のままにする。"
                            f"風量を{_speed_label(policy, current_speed)}から{_speed_label(policy, high)}にして、売場の空気を動かす。"
                        ),
                    ),
                    "id": "CMD-SALES-FAN",
                    "holdSetpoint": hold,
                }
            )

    if stock_humid:
        actuator = actuators["dehumidify"]
        current_mode = context["modes"].get(actuator["code"])
        if current_mode is None:
            raise RuntimeError(f"{actuator['code']} の運転モードが基準時刻までにありません。")
        if current_mode != policy["dryMode"]:
            commands.append(
                {
                    **_command(
                        actuator,
                        "除湿に切り替える",
                        _mode_label(policy, current_mode),
                        policy["dryModeLabel"],
                        (
                            f"倉庫の相対湿度は {_fmt(stock['humidity'])}% で、上限 {_fmt(stock['humidityHigh'])}% を超えている。"
                            f"{_mode_label(policy, current_mode)}から{policy['dryModeLabel']}へ切り替える。"
                        ),
                        f"湿度{_fmt(stock['humidityHigh'])}%以下で{_mode_label(policy, policy['coolingMode'])}",
                        policy["dryMode"],
                        "倉庫の湿度が上限を超えている",
                        (
                            f"{stock['label']}の湿度が上限{_fmt(stock['humidityHigh'])}%を超えているので、"
                            f"{actuator['label']}を{_mode_label(policy, current_mode)}から{policy['dryModeLabel']}へ切り替える。"
                        ),
                    ),
                    "id": "CMD-STOCK-MODE",
                }
            )

    if door_open and outside_high and sales_hot:
        actuator = actuators["airCurtain"]
        current = int(readings[actuator["statusCode"]]["value"])
        if current == 0:
            commands.append(
                {
                    **_command(
                        actuator,
                        "エアカーテンをオンにする",
                        "オフ",
                        "オン",
                        (
                            f"外気は {_fmt(power['outside'])}℃、入口ドアの開放率は {_fmt(context['doorOpenRatio'] * 100)}% で、"
                            f"方針の {_fmt(float(policy['doorOpenRatioLimit']) * 100)}% を超えている。売場が暑いので入口で外気を遮る。"
                        ),
                        f"ドア{_fmt(float(policy['doorOpenRatioLimit']) * 100)}%未満でオフ",
                        1,
                        "暑い外気が売場に入っている",
                        (
                            f"{actuator['label']}は{sales['label']}へ空気を送っている。"
                            f"外気が暑くドアが開いているので、オフからオンにして外気を遮る。"
                        ),
                    ),
                    "id": "CMD-CURTAIN",
                }
            )

    if outside_high and rising and near:
        actuator = actuators["exhaust"]
        current_speed = int(readings[actuator["fanCode"]]["value"])
        low = int(policy["fanSpeedLow"])
        if current_speed != low:
            commands.append(
                {
                    **_command(
                        actuator,
                        "風量を下げる",
                        _speed_label(policy, current_speed),
                        _speed_label(policy, low),
                        (
                            f"外気は {_fmt(power['outside'])}℃ で、換気を弱める {_fmt(policy['ventilationCutoffCelsius'])}℃ を超えている。"
                            f"{peak['targetAt'][11:16]} の予報は {_fmt(peak['temperature'])}℃ まで上がる。"
                            "室外機が定格に近いので、熱い外気の取り込みを抑える。"
                        ),
                        f"外気{_fmt(policy['ventilationCutoffCelsius'])}℃未満で風量{_speed_label(policy, policy['fanSpeedMid'])}",
                        low,
                        "暑い外気が売場に入っている",
                        (
                            f"{actuator['label']}も{sales['label']}へ空気を送っている。"
                            f"外気が上がる予報なので、風量を{_speed_label(policy, current_speed)}から{_speed_label(policy, low)}にして取り込みを抑える。"
                        ),
                    ),
                    "id": "CMD-VENT",
                }
            )

    work_orders = []
    for row in equipment:
        if row["service"] != "点検":
            continue
        work_orders.append(
            {
                "id": f"WO-FILTER-{row['code']}",
                "kind": "作業指示",
                "code": row["code"],
                "label": row["label"],
                "action": "フィルタを点検する",
                "current": f"{_fmt(row['runtime'])}h",
                "command": "点検",
                "reason": (
                    f"累積運転時間が点検間隔 {_fmt(row['serviceHours'])} 時間に達している。"
                    "機器の運転指令とは分けて、人の作業にする。"
                ),
                "revert": "点検後にリセット",
                "commandValue": None,
                "issueTitle": "フィルタが点検間隔を超えている",
                "because": (
                    f"フィルタは{row['label']}の一部で、運転時間が点検間隔を超えている。"
                    "運転の切り替えとは分けて、人が点検する。"
                ),
            }
        )

    clock = datetime.fromisoformat(AS_OF_TIME)
    summary = (
        f"{_WEEKDAY[clock.weekday()]}曜日 {clock.strftime('%H:%M')}。"
        f"売場は {_fmt(sales['temperature'])}℃ で{sales['comfort']}、"
        f"来店は直近1時間 {context['footfall']} 人（平常 {policy['footfallBaseline']} 人）。"
        f"外気は {_fmt(power['outside'])}℃、{peak['targetAt'][11:16]} の予報は {_fmt(peak['temperature'])}℃。"
        f"室外機は {_fmt(power['power'])} kW、定格は {_fmt(power['capacity'])} kW。"
        f"入口ドアの開放率は {_fmt(context['doorOpenRatio'] * 100)}%。"
        f"倉庫の湿度は {_fmt(stock['humidity'])}% で{stock['humidityStatus']}。"
        f"バックルームは {_fmt(back['temperature'])}℃ で{back['comfort']}。"
    )
    return {
        "summary": summary,
        "commands": commands,
        "workOrders": work_orders,
        "context": {
            "footfall": context["footfall"],
            "footfallBaseline": int(policy["footfallBaseline"]),
            "doorOpenRatio": context["doorOpenRatio"],
            "doorOpenRatioLimit": float(policy["doorOpenRatioLimit"]),
            "forecast": context["forecast"],
            "weekday": _WEEKDAY[clock.weekday()],
            "nearCapacityRatio": float(policy["nearCapacityRatio"]),
        },
        "issues": issues,
        "signals": {
            "nearCapacity": near,
            "salesHot": sales_hot,
            "backHasMargin": back_ok,
            "busy": busy,
            "doorOpen": door_open,
            "outsideHigh": outside_high,
            "forecastRising": rising,
            "stockHumid": stock_humid,
        },
    }


def _clock(stamp: str) -> str:
    return stamp[11:16]


def _series_map(rows: list[dict]) -> dict[str, dict[str, float]]:
    folded: dict[str, dict[str, float]] = {}
    for row in rows:
        value = row["value_num"]
        folded.setdefault(row["point_code"], {})[_clock(row["recorded_at"])] = float(value)
    return folded


def load_trends(evidence: Evidence, zones: list[dict], power: dict, context: dict) -> dict:
    codes = tuple(
        [zone["tempCode"] for zone in zones]
        + [zone["rhCode"] for zone in zones]
        + [power["oaCode"], power["powerCode"]]
    )
    rows, trace = db.point_series(codes)
    evidence.add_sql(trace)
    folded = _series_map(rows)
    times = sorted({clock for zone in zones for clock in folded.get(zone["tempCode"], {})})
    order = {"売場ゾーン": 0, "バックルームゾーン": 1, "倉庫ゾーン": 2}
    ordered = sorted(zones, key=lambda zone: order.get(zone["label"], 9))
    return {
        "times": times,
        "zones": [
            {
                "label": zone["label"].replace("ゾーン", ""),
                "setpoint": zone["setpoint"],
                "tolerance": zone["tolerance"],
                "comfort": zone["comfort"],
                "humidityStatus": zone["humidityStatus"],
                "humidityLow": zone["humidityLow"],
                "humidityHigh": zone["humidityHigh"],
                "temperature": [folded.get(zone["tempCode"], {}).get(clock) for clock in times],
                "humidity": [folded.get(zone["rhCode"], {}).get(clock) for clock in times],
            }
            for zone in ordered
        ],
        "outside": [folded.get(power["oaCode"], {}).get(clock) for clock in times],
        "power": [folded.get(power["powerCode"], {}).get(clock) for clock in times],
        "forecast": [
            {"at": _clock(item["targetAt"]), "temperature": item["temperature"]}
            for item in context["forecast"]
        ],
    }


def morning_briefing(evidence: Evidence) -> dict:
    store = load_store(evidence)
    datasets = load_datasets(evidence)
    readings = latest_readings(evidence)
    zones = load_zones(evidence, readings)
    equipment = load_equipment(evidence, readings)
    power = load_power(evidence, readings)
    policy = load_policy(evidence)
    actuators = load_actuators(evidence)
    context = load_context(evidence)
    dispatch = decide(zones, equipment, power, policy, actuators, readings, context)
    trends = load_trends(evidence, zones, power, context)
    return {
        "asOf": AS_OF_TIME,
        "storeCode": store["storeCode"],
        "store": store,
        "datasets": datasets,
        "zones": zones,
        "equipment": equipment,
        "outdoor": {
            "temperature": power["outside"],
            "power": power["power"],
            "capacity": power["capacity"],
            "label": power["label"],
        },
        "counts": table_counts(evidence),
        "dispatch": dispatch,
        "trends": trends,
    }
