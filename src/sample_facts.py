"""空調ポイントの測定列と、朝の指令に使う状況データ。

ポイントの意味、単位、設定温度、定格、点検間隔、指令のしきい値はオントロジー側が正です。
ここにあるのは、その方針へ当てはめる数値だけです。
風量は 1 が弱、2 が中、3 が強。エアカーテンの発停は 0 がオフ、1 がオンです。
"""

from __future__ import annotations

def _morning(values: tuple[float, float, float]) -> list[tuple[str, float]]:
    hours = ("04", "06", "08")
    return [(f"2026-10-10T{hour}:00:00", value) for hour, value in zip(hours, values)]


READINGS: dict[str, list[tuple[str, float]]] = {
    "PT-SALES-TEMP": _morning((26.1, 26.8, 27.8)),
    "PT-SALES-RH": _morning((62, 64, 66)),
    "PT-BACK-TEMP": _morning((25.7, 26.0, 26.3)),
    "PT-BACK-RH": _morning((55, 56, 58)),
    "PT-STOCK-TEMP": _morning((28.2, 28.9, 29.6)),
    "PT-STOCK-RH": _morning((70, 73, 76)),
    "PT-OA-TEMP": _morning((29.4, 31.1, 33.2)),
    "PT-ODU-POWER": _morning((3.4, 5.1, 6.9)),
    "PT-ODU-ENERGY": [
        ("2026-10-03T23:00:00", 52),
        ("2026-10-04T23:00:00", 55),
        ("2026-10-05T23:00:00", 49),
        ("2026-10-06T23:00:00", 58),
        ("2026-10-07T23:00:00", 61),
        ("2026-10-08T23:00:00", 54),
        ("2026-10-09T23:00:00", 57),
        ("2026-10-10T08:00:00", 18.4),
    ],
    "PT-FCU-SALES-RUN": [("2026-10-10T08:00:00", 2140)],
    "PT-FCU-BACK-RUN": [("2026-10-10T08:00:00", 860)],
    "PT-FCU-STOCK-RUN": [("2026-10-10T08:00:00", 1510)],
    "PT-FCU-SALES-STATUS": _morning((1, 1, 1)),
    "PT-FCU-BACK-STATUS": _morning((1, 1, 1)),
    "PT-FCU-STOCK-STATUS": _morning((1, 1, 1)),
    "PT-VENT-STATUS": _morning((1, 1, 1)),
    "PT-FCU-SALES-FAN": [("2026-10-10T08:00:00", 2)],
    "PT-VENT-SPEED": [("2026-10-10T08:00:00", 2)],
    "PT-CURTAIN-STATUS": [("2026-10-10T08:00:00", 0)],
}

# 直近1時間の来店。平常の人数はグラフの footfallBaseline。
FOOTFALL: list[tuple[str, int]] = [
    ("2026-10-10T08:00:00", 86),
]

# 直近15分に入口ドアが開いていた割合。
DOOR: list[tuple[str, float]] = [
    ("2026-10-10T08:00:00", 0.40),
]

# 基準時刻に入手した外気予報。(発行時刻, 対象時刻, ℃)
FORECAST: list[tuple[str, str, float]] = [
    ("2026-10-10T08:00:00", "2026-10-10T09:00:00", 34.1),
    ("2026-10-10T08:00:00", "2026-10-10T10:00:00", 35.0),
]

# 室内機の運転モード。コードの意味はグラフの DispatchPolicy。
MODES: dict[str, str] = {
    "FCU-SALES": "cool",
    "FCU-BACK": "cool",
    "FCU-STOCK": "cool",
}
MODE_AT = "2026-10-10T08:00:00"
