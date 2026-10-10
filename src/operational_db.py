"""空調の時系列と、朝の指令に使う状況データへの読み取り。

SQLは固定文で、値はプレースホルダだけを渡す。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from src.settings import AS_OF_TIME, DB_PATH, STORE_CODE


@dataclass(frozen=True)
class SqlTrace:
    statement: str
    params: list


def connect() -> sqlite3.Connection:
    if not DB_PATH.is_file():
        raise FileNotFoundError(
            "業務DBがありません。python scripts/init_db.py を先に実行してください。"
        )
    connection = sqlite3.connect(DB_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def fetch_all(statement: str, params: tuple = ()) -> tuple[list[dict], SqlTrace]:
    connection = connect()
    try:
        cursor = connection.execute(statement, params)
        rows = [dict(row) for row in cursor.fetchall()]
    finally:
        connection.close()
    return rows, SqlTrace(statement.strip(), list(params))


def latest_readings(at: str = AS_OF_TIME) -> tuple[dict[str, dict], SqlTrace]:
    rows, trace = fetch_all(
        """
        SELECT point_code, recorded_at, value_num
        FROM point_reading AS reading
        WHERE store_code = ?
          AND recorded_at = (
            SELECT MAX(recorded_at)
            FROM point_reading
            WHERE store_code = reading.store_code
              AND point_code = reading.point_code
              AND recorded_at <= ?
          )
        """,
        (STORE_CODE, at),
    )
    folded = {}
    for row in rows:
        value = row["value_num"]
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        folded[row["point_code"]] = {"at": row["recorded_at"], "value": value}
    return folded, trace


def energy_sum(point_code: str, start: str, end: str) -> tuple[float, SqlTrace]:
    rows, trace = fetch_all(
        """
        SELECT COALESCE(SUM(value_num), 0) AS amount
        FROM point_reading
        WHERE store_code = ? AND point_code = ? AND recorded_at >= ? AND recorded_at < ?
        """,
        (STORE_CODE, point_code, start, end),
    )
    return float(rows[0]["amount"]), trace


def point_series(point_codes: tuple[str, ...], at: str = AS_OF_TIME) -> tuple[list[dict], SqlTrace]:
    if not point_codes:
        return [], SqlTrace("SELECT point_code, recorded_at, value_num FROM point_reading WHERE 0", [])
    marks = ",".join("?" for _ in point_codes)
    return fetch_all(
        f"""
        SELECT point_code, recorded_at, value_num
        FROM point_reading
        WHERE store_code = ?
          AND recorded_at <= ?
          AND point_code IN ({marks})
        ORDER BY recorded_at, point_code
        """,
        (STORE_CODE, at, *point_codes),
    )


def latest_footfall(at: str = AS_OF_TIME) -> tuple[dict | None, SqlTrace]:
    rows, trace = fetch_all(
        """
        SELECT recorded_at, people_count
        FROM footfall
        WHERE store_code = ? AND recorded_at <= ?
        ORDER BY recorded_at DESC
        LIMIT 1
        """,
        (STORE_CODE, at),
    )
    return (rows[0] if rows else None), trace


def latest_door(at: str = AS_OF_TIME) -> tuple[dict | None, SqlTrace]:
    rows, trace = fetch_all(
        """
        SELECT recorded_at, open_ratio
        FROM door_interval
        WHERE store_code = ? AND recorded_at <= ?
        ORDER BY recorded_at DESC
        LIMIT 1
        """,
        (STORE_CODE, at),
    )
    return (rows[0] if rows else None), trace


def forecasts(at: str = AS_OF_TIME) -> tuple[list[dict], SqlTrace]:
    return fetch_all(
        """
        SELECT target_at, outside_temp_c
        FROM weather_forecast
        WHERE store_code = ? AND issued_at <= ?
        ORDER BY target_at
        """,
        (STORE_CODE, at),
    )


def latest_modes(at: str = AS_OF_TIME) -> tuple[list[dict], SqlTrace]:
    return fetch_all(
        """
        SELECT equipment_code, mode_code, recorded_at
        FROM equipment_mode AS mode
        WHERE store_code = ?
          AND recorded_at = (
            SELECT MAX(recorded_at)
            FROM equipment_mode
            WHERE store_code = mode.store_code
              AND equipment_code = mode.equipment_code
              AND recorded_at <= ?
          )
        """,
        (STORE_CODE, at),
    )


def counts() -> tuple[dict, SqlTrace]:
    rows, trace = fetch_all(
        """
        SELECT
          (SELECT COUNT(*) FROM point_reading) AS readings,
          (SELECT COUNT(DISTINCT point_code) FROM point_reading) AS points,
          (SELECT COUNT(*) FROM footfall) AS footfall,
          (SELECT COUNT(*) FROM door_interval) AS door,
          (SELECT COUNT(*) FROM weather_forecast) AS forecast,
          (SELECT COUNT(*) FROM equipment_mode) AS modes
        """
    )
    return rows[0], trace
