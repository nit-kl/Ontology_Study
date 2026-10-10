"""パスと、シナリオ全体で共有する定数。"""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ONTOLOGY_PATH = ROOT / "ontology" / "cp-retail.ttl"
QUERY_DIR = ROOT / "queries"
SCHEMA_PATH = ROOT / "data" / "schema.sql"
DB_PATH = ROOT / "data" / "cp_store.sqlite"
DEMO_DIR = ROOT / "demo"

STORE_CODE = "7EL-BKK-SS01"
AS_OF = "2026-10-10"
AS_OF_TIME = "2026-10-10T08:00:00"
ENERGY_LOOKBACK_DAYS = 7
HOST = "127.0.0.1"
PORT = 8765

if not re.fullmatch(r"[A-Z0-9-]{1,32}", STORE_CODE):
    raise RuntimeError("店舗コードはSPARQLへ埋め込める安全な形式だけを許可しています。")

date.fromisoformat(AS_OF)


def energy_window() -> tuple[str, str]:
    """基準日の前日までの7日間。開始は含み、基準日の0時は含まない。"""
    as_of = date.fromisoformat(AS_OF)
    start = as_of - timedelta(days=ENERGY_LOOKBACK_DAYS)
    return f"{start.isoformat()}T00:00:00", f"{AS_OF}T00:00:00"
