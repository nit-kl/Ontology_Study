"""店舗空調のエージェント。

意図を分類し、定義済みのSPARQLとSQLだけを実行する。
朝の機器指令は、グラフの方針と業務DBの状況から決める。
有料の外部モデルは呼ばない。質問文からクエリは作らない。
"""

from __future__ import annotations

from src.graph_store import knowledge_graph
from src.services import (
    Evidence,
    latest_readings,
    load_bridge,
    load_datasets,
    load_equipment,
    load_kpis,
    load_power,
    load_processes,
    load_store,
    load_zones,
    morning_briefing,
    table_counts,
)
from src.settings import AS_OF_TIME, ENERGY_LOOKBACK_DAYS

PROMPTS = [
    "指令は？",
    "空調構成は？",
    "外れているゾーンは？",
    "フィルタ点検は？",
    "役割分担は？",
]


def classify(question: str) -> str:
    text = question.strip()
    if not text:
        return "help"
    rules = (
        ("dispatch", ("指令", "動か", "エアカーテン", "風量", "除湿", "ブリーフィング")),
        ("architecture", ("役割", "分担", "オントロジ", "業務DB", "使い分け", "標準")),
        ("maintenance", ("点検", "フィルタ", "運転時間")),
        ("power", ("電力", "消費", "エネルギー", "外気", "電力量")),
        ("comfort", ("外れて", "快適", "設定温度", "ゾーン", "湿度")),
        ("system", ("構成", "設備", "空調", "室内機", "室外機")),
        ("store", ("概要", "この店", "店舗情報")),
    )
    for intent, words in rules:
        if any(word in text for word in words):
            return intent
    lowered = text.lower()
    english = (
        ("dispatch", ("dispatch", "command")),
        ("architecture", ("ontology", "brick", "sqlite")),
        ("maintenance", ("filter", "maintenance")),
        ("power", ("power", "energy")),
        ("comfort", ("setpoint", "comfort", "temperature")),
        ("system", ("hvac", "equipment")),
    )
    for intent, words in english:
        if any(word in lowered for word in words):
            return intent
    return "help"


def _clean(question: str) -> str:
    kept = "".join(ch for ch in question if ch == "\n" or ch >= " ")
    return kept.strip()[:500]


def _num(value) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.1f}"


class StoreOpsAgent:
    def ask(self, question: str) -> dict:
        cleaned = _clean(question)
        intent = classify(cleaned)
        handler = {
            "store": self._system,
            "system": self._system,
            "dispatch": self._dispatch,
            "comfort": self._comfort,
            "power": self._power,
            "maintenance": self._maintenance,
            "architecture": self._architecture,
            "help": self._help,
        }[intent]
        result = handler()
        result["intent"] = intent
        result["question"] = cleaned
        return result

    def _context(self) -> tuple[Evidence, dict, list[dict], list[dict]]:
        evidence = Evidence()
        readings = latest_readings(evidence)
        zones = load_zones(evidence, readings)
        equipment = load_equipment(evidence, readings)
        return evidence, readings, zones, equipment

    def _system(self) -> dict:
        evidence = Evidence()
        store = load_store(evidence)
        processes = load_processes(evidence)
        readings = latest_readings(evidence)
        equipment = load_equipment(evidence, readings)
        lines = [
            f"{store['label']}（{store['storeCode']}）は、{store['parent']}の {store['org']} が運営する店舗です。",
            f"所在は{store['area']}、{store['address']}。延床面積は {store['floor']} 平方メートル、営業時間は {store['hours']} です。",
            f"空調システムは「{store['system']}」です。関係は Brick の設備・ゾーンと、BOT の建物・空間で表しています。",
            "主な機器:",
        ]
        for row in equipment:
            extra = f"、供給先 {row['feeds']}" if row["feeds"] else ""
            capacity = f"、定格冷房 {_num(row['capacity'])} kW" if row["capacity"] is not None else ""
            lines.append(f"・{row['label']}（{row['code']}、{row['kind']}、{row['location']}{extra}{capacity}）")
        lines.append("確認のプロセス:")
        lines.extend(f"・{row['label']} — {row['schedule']}" for row in processes)
        return _result(
            "空調構成",
            lines,
            evidence,
            [
                {"key": "label", "label": "機器"},
                {"key": "code", "label": "コード"},
                {"key": "kind", "label": "種別"},
                {"key": "location", "label": "場所"},
                {"key": "feeds", "label": "供給先"},
                {"key": "capacity", "label": "定格冷房（kW）"},
            ],
            equipment,
            [
                "質問を空調構成と分類する",
                "建物、組織、空調システム、機器の関係をグラフから辿る",
                "機器に紐づく運転時間があれば業務DBの最新値を添える",
            ],
        )

    def _dispatch(self) -> dict:
        evidence = Evidence()
        briefing = morning_briefing(evidence)
        dispatch = briefing["dispatch"]
        lines = [
            f"基準時刻は {AS_OF_TIME} です。",
            dispatch["summary"],
            "設定温度、快適幅、定格、しきい値、戻す条件はグラフの方針です。温度、来店人数、ドア開放率、外気予報、運転モードは業務DBです。",
            f"機器への指令は {len(dispatch['commands'])} 件、人の作業指示は {len(dispatch['workOrders'])} 件です。",
            "機器への指令:",
        ]
        if dispatch["commands"]:
            for row in dispatch["commands"]:
                lines.append(
                    f"・{row['label']}（{row['code']}）: {row['current']} を {row['command']} にする。{row['reason']} 戻す条件は、{row['revert']}。"
                )
        else:
            lines.append("・条件に合う機器指令はありません。")
        lines.append("作業指示:")
        if dispatch["workOrders"]:
            for row in dispatch["workOrders"]:
                lines.append(f"・{row['label']}（{row['code']}）: {row['action']}。{row['reason']}")
        else:
            lines.append("・作業指示はありません。")
        lines.append("この指令は画面の中だけです。実機や外部サービスへは送りません。")
        rows = dispatch["commands"] + dispatch["workOrders"]
        return _result(
            "朝の機器指令",
            lines,
            evidence,
            [
                {"key": "label", "label": "対象"},
                {"key": "current", "label": "いま"},
                {"key": "command", "label": "指令"},
                {"key": "revert", "label": "戻す"},
            ],
            rows,
            [
                "質問を朝の機器指令と分類する",
                "指令方針、操作できる機器、ゾーン、室外機をグラフから取る",
                "最新の空調測定、来店人数、ドア開放率、外気予報、運転モードを業務DBから取る",
                "方針のしきい値を超えたものだけを機器指令にし、フィルタ超過は作業指示に分ける",
            ],
        )

    def _comfort(self) -> dict:
        evidence, _readings, zones, _equipment = self._context()
        outside = [row for row in zones if row["comfort"] == "快適範囲外"]
        humid = [row for row in zones if row["humidityStatus"] != "範囲内"]
        lines = [
            f"基準時刻は {AS_OF_TIME} です。",
            "冷房設定温度と快適幅、湿度の上下限はグラフの方針です。ゾーン温度と相対湿度は業務DBの最新測定です。",
            f"空調ゾーン {len(zones)} 件のうち、快適範囲外は {len(outside)} 件です。",
        ]
        for row in zones:
            lines.append(
                f"・{row['label']}: 温度 { _num(row['temperature']) }℃（設定 {_num(row['setpoint'])}℃、偏差 {_num(row['deviation'])}℃、許容 ±{_num(row['tolerance'])}℃）で{row['comfort']}。"
                f"湿度 {_num(row['humidity'])}% は{row['humidityStatus']}です。"
            )
        if humid:
            names = "、".join(row["label"] for row in humid)
            lines.append(f"湿度が方針の帯を外れているのは {names} です。")
        return _result(
            "ゾーンの快適性",
            lines,
            evidence,
            [
                {"key": "label", "label": "ゾーン"},
                {"key": "setpoint", "label": "設定温度"},
                {"key": "tolerance", "label": "快適幅"},
                {"key": "temperature", "label": "最新温度"},
                {"key": "deviation", "label": "偏差"},
                {"key": "comfort", "label": "温度"},
                {"key": "humidity", "label": "湿度"},
                {"key": "humidityStatus", "label": "湿度の状態"},
            ],
            zones,
            [
                "質問を快適性の確認と分類する",
                "ゾーン、設定温度、快適幅、湿度の上下限と、測定ポイントの時系列IDをグラフから取る",
                "基準時刻以前で最新の温度と湿度を業務DBから取る",
                "偏差が快適幅を超えるゾーンを残す",
            ],
        )

    def _power(self) -> dict:
        evidence = Evidence()
        readings = latest_readings(evidence)
        power = load_power(evidence, readings)
        lines = [
            f"基準時刻は {AS_OF_TIME} です。",
            f"{power['label']}（{power['code']}）の電力は {_num(power['power'])} kW（{power['powerAt']}）です。",
            f"定格冷房能力はグラフ上の数量で {_num(power['capacity'])} kW です。",
            f"同じ基準で見た外気温度は {_num(power['outside'])}℃（{power['outsideAt']}）です。",
            f"基準日の {AS_OF_TIME[11:16]} までの電力量は {_num(power['todayEnergy'])} kWh、"
            f"その前の {ENERGY_LOOKBACK_DAYS} 日間は {_num(power['weekEnergy'])} kWh です。",
            "外気と電力と電力量は Brick のポイントで、数値は業務DBです。定格は QUDT の数量としてグラフにあります。",
        ]
        return _result(
            "室外機と外気",
            lines,
            evidence,
            [
                {"key": "label", "label": "機器"},
                {"key": "outside", "label": "外気（℃）"},
                {"key": "power", "label": "電力（kW）"},
                {"key": "capacity", "label": "定格冷房（kW）"},
                {"key": "todayEnergy", "label": "本日電力量（kWh）"},
                {"key": "weekEnergy", "label": "前7日電力量（kWh）"},
            ],
            [power],
            [
                "質問を電力の確認と分類する",
                "室外機、定格冷房能力、外気・電力・電力量の時系列IDをグラフから取る",
                "最新の電力と外気、日次電力量の合計を業務DBから取る",
            ],
        )

    def _maintenance(self) -> dict:
        evidence, _readings, _zones, equipment = self._context()
        watched = [row for row in equipment if row["serviceHours"] is not None]
        due = [row for row in watched if row["service"] == "点検"]
        lines = [
            f"基準時刻は {AS_OF_TIME} です。",
            "点検間隔はフィルタの方針としてグラフにあります。累積運転時間は室内機のセンサー時系列です。",
            f"間隔を持つ室内機 {len(watched)} 台のうち、点検候補は {len(due)} 台です。",
        ]
        for row in watched:
            lines.append(
                f"・{row['label']}（{row['code']}）: 運転時間 {_num(row['runtime'])} 時間、点検間隔 {_num(row['serviceHours'])} 時間、状態は{row['service']}。"
            )
        return _result(
            "フィルタ点検",
            lines,
            evidence,
            [
                {"key": "label", "label": "室内機"},
                {"key": "code", "label": "コード"},
                {"key": "runtime", "label": "運転時間"},
                {"key": "serviceHours", "label": "点検間隔"},
                {"key": "service", "label": "状態"},
            ],
            watched,
            [
                "質問をフィルタ点検と分類する",
                "室内機、フィルタ、点検間隔、運転時間ポイントをグラフから辿る",
                "累積運転時間の最新値を業務DBから取る",
            ],
        )

    def _architecture(self) -> dict:
        evidence = Evidence()
        datasets = load_datasets(evidence)
        bridge = load_bridge(evidence)
        counts = table_counts(evidence)
        triple_count = knowledge_graph().triple_count()
        lines = [
            "建物と空間は BOT、空調機器とゾーンとポイントは Brick 1.4、センサーの観測量は SOSA、単位と定格能力は QUDT です。",
            "設定温度、快適幅、点検間隔、定格冷房能力、朝の指令方針はグラフに置いています。",
            "温度、湿度、電力、電力量、発停、運転時間、風量、エアカーテンの発停は point_reading です。Brick の brick:hasTimeseriesId が point_code になります。",
            "来店人数、入口ドアの開放率、外気予報、室内機の運転モードも業務DBです。",
            "結合キーは次のとおりです。",
        ]
        lines.extend(f"・{row['label']} → {row['column']}" for row in bridge)
        lines.append(
            f"現在のグラフは {triple_count} トリプルです。測定は {counts['readings']} 行、ポイントは {counts['points']} 件です。"
        )
        for row in datasets:
            keys = ", ".join(row["keys"])
            attrs = ", ".join(row["attributes"])
            lines.append(f"・{row['label']}（表 {row['table']}、結合キー {keys}、列 {attrs}）。{row['comment']}")
        flat = [
            {
                "label": row["label"],
                "table": row["table"],
                "keys": ", ".join(row["keys"]),
                "attributes": ", ".join(row["attributes"]),
                "cadence": row["cadence"],
            }
            for row in datasets
        ]
        return _result(
            "グラフと業務DBの分担",
            lines,
            evidence,
            [
                {"key": "label", "label": "データ"},
                {"key": "table", "label": "表"},
                {"key": "keys", "label": "結合キー"},
                {"key": "attributes", "label": "業務DBにある列"},
                {"key": "cadence", "label": "更新"},
            ],
            flat,
            [
                "質問をデータの置き場所と分類する",
                "標準語彙と業務DBの対応、データセット定義をグラフから取る",
                "測定行の件数を業務DBから取る",
            ],
        )

    def _help(self) -> dict:
        lines = [
            "このエージェントは、質問の意図を選んでから、用意したSPARQLとSQLだけを実行します。",
            "クエリの文は質問文から作りません。外部の有料APIも呼びません。",
            "次の質問に答えられます。",
        ]
        lines.extend(f"・{prompt}" for prompt in PROMPTS)
        return _result("できること", lines, Evidence(), [], [], ["質問が用意した意図に当てはまらないので、案内を返す"])


def _result(title, lines, evidence: Evidence, columns, rows, plan) -> dict:
    return {
        "title": title,
        "answer": "\n".join(lines),
        "columns": columns,
        "rows": rows,
        "plan": [{"detail": step} for step in plan],
        "sparql": evidence.sparql,
        "sql": evidence.sql,
    }
