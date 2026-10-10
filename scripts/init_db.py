"""グラフの時系列IDと sample_facts を突き合わせて、業務DBを作り直す。"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.graph_store import knowledge_graph  # noqa: E402
from src.sample_facts import DOOR, FORECAST, FOOTFALL, MODE_AT, MODES, READINGS  # noqa: E402
from src.settings import AS_OF, AS_OF_TIME, DB_PATH, SCHEMA_PATH, STORE_CODE  # noqa: E402


def _fail(message: str) -> None:
    raise SystemExit(message)


def build() -> None:
    graph_rows, _ = knowledge_graph().query_file("timeseries.rq")
    graph_codes = {row["pointCode"] for row in graph_rows}
    fact_codes = set(READINGS)
    if fact_codes != graph_codes:
        missing = sorted(graph_codes - fact_codes)
        extra = sorted(fact_codes - graph_codes)
        _fail(f"時系列IDがグラフと測定値の種で一致しません。不足={missing} 余分={extra}")

    for code, samples in READINGS.items():
        if not samples:
            _fail(f"{code} の測定値が空です。")
        for recorded_at, _value in samples:
            if recorded_at > AS_OF_TIME:
                _fail(f"{code} の {recorded_at} が基準時刻より後です。")

    known_codes = {row["code"] for row in knowledge_graph().query_file("equipment_codes.rq")[0]}
    if set(MODES) != {"FCU-SALES", "FCU-BACK", "FCU-STOCK"}:
        _fail(f"運転モードの対象機器が室内機3台と一致しません: {sorted(MODES)}")
    missing_modes = sorted(set(MODES) - known_codes)
    if missing_modes:
        _fail(f"運転モードの機器コードがグラフにありません: {missing_modes}")
    if MODE_AT > AS_OF_TIME:
        _fail("運転モードの時刻が基準時刻より後です。")
    for recorded_at, _people in FOOTFALL:
        if recorded_at > AS_OF_TIME:
            _fail("来店人数の時刻が基準時刻より後です。")
    for recorded_at, ratio in DOOR:
        if recorded_at > AS_OF_TIME:
            _fail("ドア開放率の時刻が基準時刻より後です。")
        if ratio < 0 or ratio > 1:
            _fail("ドア開放率は 0 から 1 の範囲にしてください。")
    for issued_at, target_at, _temp in FORECAST:
        if issued_at > AS_OF_TIME:
            _fail("外気予報の発行時刻が基準時刻より後です。")
        if target_at < issued_at:
            _fail("外気予報の対象時刻が発行時刻より前です。")

    if DB_PATH.exists():
        DB_PATH.unlink()
    connection = sqlite3.connect(DB_PATH)
    try:
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        connection.execute("INSERT INTO demo_meta (key, value) VALUES (?, ?)", ("as_of", AS_OF))
        connection.execute("INSERT INTO demo_meta (key, value) VALUES (?, ?)", ("as_of_time", AS_OF_TIME))
        connection.execute("INSERT INTO demo_meta (key, value) VALUES (?, ?)", ("store_code", STORE_CODE))
        connection.execute(
            "INSERT INTO demo_meta (key, value) VALUES (?, ?)",
            ("note", "架空の空調測定と、来店・ドア・予報・運転モード。意味と指令方針はTTLを参照する。"),
        )
        rows = []
        reading_id = 1
        for code, samples in READINGS.items():
            for recorded_at, value in samples:
                rows.append((reading_id, STORE_CODE, code, recorded_at, value))
                reading_id += 1
        connection.executemany(
            """
            INSERT INTO point_reading (id, store_code, point_code, recorded_at, value_num)
            VALUES (?, ?, ?, ?, ?)
            """,
            rows,
        )
        connection.executemany(
            "INSERT INTO footfall (store_code, recorded_at, people_count) VALUES (?, ?, ?)",
            [(STORE_CODE, recorded_at, people) for recorded_at, people in FOOTFALL],
        )
        connection.executemany(
            "INSERT INTO door_interval (store_code, recorded_at, open_ratio) VALUES (?, ?, ?)",
            [(STORE_CODE, recorded_at, ratio) for recorded_at, ratio in DOOR],
        )
        connection.executemany(
            """
            INSERT INTO weather_forecast (store_code, issued_at, target_at, outside_temp_c)
            VALUES (?, ?, ?, ?)
            """,
            [(STORE_CODE, issued_at, target_at, temp) for issued_at, target_at, temp in FORECAST],
        )
        connection.executemany(
            """
            INSERT INTO equipment_mode (store_code, equipment_code, recorded_at, mode_code)
            VALUES (?, ?, ?, ?)
            """,
            [(STORE_CODE, code, MODE_AT, mode) for code, mode in MODES.items()],
        )
        connection.commit()
    except Exception:
        connection.close()
        if DB_PATH.exists():
            DB_PATH.unlink()
        raise
    else:
        connection.close()

    print(f"業務DBを作成しました: {DB_PATH}")
    print(f"空調の測定 {len(rows)} 行 / ポイント {len(READINGS)} 件")
    print(
        f"来店 {len(FOOTFALL)} 行 / ドア {len(DOOR)} 行 / 予報 {len(FORECAST)} 行 / 運転モード {len(MODES)} 行"
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    build()
