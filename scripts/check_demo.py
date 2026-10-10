"""TTL、空調の時系列、エージェント、HTTPが同じシナリオを指していることを確認する。"""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.init_db import build  # noqa: E402
from src.agent import PROMPTS, StoreOpsAgent  # noqa: E402
from src.graph_store import knowledge_graph  # noqa: E402
from src.sample_facts import READINGS  # noqa: E402
from src.server import make_server  # noqa: E402
from src.settings import AS_OF_TIME, ONTOLOGY_PATH, STORE_CODE  # noqa: E402


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ttl = ONTOLOGY_PATH.read_text(encoding="utf-8")
    for term in ("brick:HVAC_Zone", "bot:Building", "sosa:observes", "unit:DEG_C", "brick:hasTimeseriesId"):
        expect(term in ttl, f"TTLに標準語彙の参照がありません: {term}")
    for measurement in ("27.8", "6.9", "33.2", "2140", "86", "34.1", "35.0", "0.40"):
        expect(measurement not in ttl, f"測定値 {measurement} がTTLに入っています。")
    expect("cpr:DispatchPolicy" in ttl, "指令方針がTTLにありません。")
    expect(knowledge_graph().triple_count() > 150, "トリプル数が少なすぎます。")

    build()
    agent = StoreOpsAgent()
    intents = {
        PROMPTS[0]: "dispatch",
        PROMPTS[1]: "system",
        PROMPTS[2]: "comfort",
        PROMPTS[3]: "maintenance",
        PROMPTS[4]: "architecture",
    }
    answers = {}
    for prompt, intent in intents.items():
        result = agent.ask(prompt)
        expect(result["intent"] == intent, f"意図が違います: {prompt} -> {result['intent']}")
        expect(result["answer"].strip(), f"回答が空です: {prompt}")
        answers[intent] = result

    comfort = {row["label"]: row for row in answers["comfort"]["rows"]}
    expect(comfort["売場ゾーン"]["comfort"] == "快適範囲外", comfort["売場ゾーン"])
    expect(comfort["売場ゾーン"]["temperature"] == 27.8, comfort["売場ゾーン"])
    expect(comfort["バックルームゾーン"]["comfort"] == "快適範囲内", comfort["バックルームゾーン"])
    expect(comfort["倉庫ゾーン"]["comfort"] == "快適範囲外", comfort["倉庫ゾーン"])
    expect(comfort["倉庫ゾーン"]["humidityStatus"] == "高め", comfort["倉庫ゾーン"])

    due = {row["code"] for row in answers["maintenance"]["rows"] if row["service"] == "点検"}
    expect(due == {"FCU-SALES"}, due)
    expect("Brick" in answers["architecture"]["answer"], "標準語彙の説明がありません。")
    expect("point_reading" in answers["architecture"]["answer"], "時系列テーブルが回答にありません。")
    expect("footfall" in answers["architecture"]["answer"], "来店テーブルが回答にありません。")
    expect("CPオール" in answers["system"]["answer"], "運営会社が回答にありません。")
    expect("CURTAIN-01" in answers["system"]["answer"], "エアカーテンが構成にありません。")

    power = agent.ask("室外機の電力と外気の関係は？")
    expect(power["intent"] == "power", power["intent"])
    expect("6.9" in power["answer"] and "33.2" in power["answer"], power["answer"])
    expect(power["rows"][0]["weekEnergy"] == 386, power["rows"][0])

    orders = {row["id"]: row for row in answers["dispatch"]["rows"]}
    expect(orders["CMD-BACK-SP"]["commandValue"] == 27, orders["CMD-BACK-SP"])
    expect(orders["CMD-SALES-FAN"]["holdSetpoint"] == 25, orders["CMD-SALES-FAN"])
    expect(orders["CMD-SALES-FAN"]["commandValue"] == 3, orders["CMD-SALES-FAN"])
    expect(orders["CMD-STOCK-MODE"]["commandValue"] == "dry", orders["CMD-STOCK-MODE"])
    expect(orders["CMD-CURTAIN"]["commandValue"] == 1, orders["CMD-CURTAIN"])
    expect(orders["CMD-VENT"]["commandValue"] == 1, orders["CMD-VENT"])
    expect(orders["WO-FILTER-FCU-SALES"]["kind"] == "作業指示", orders["WO-FILTER-FCU-SALES"])
    expect(len([row for row in orders.values() if row["kind"] == "機器指令"]) == 5, orders)

    hostile = agent.ask('設定温度"; DROP TABLE point_reading; --')
    expect(hostile["intent"] == "comfort", "破壊的な文字列で意図が壊れました。")
    expect(len(hostile["rows"]) == 3, "破壊的な文字列のあとゾーン数が変わりました。")

    server = make_server(0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/bootstrap") as response:
            body = json.load(response)
        expect(body["store"]["storeCode"] == STORE_CODE, "HTTPの店舗コードが違います。")
        expect(body["asOf"] == AS_OF_TIME, "HTTPの基準時刻が違います。")
        expect(len(body["zones"]) == 3, len(body["zones"]))
        expect(body["counts"]["readings"] == sum(len(samples) for samples in READINGS.values()), body["counts"])
        expect(body["outdoor"]["temperature"] == 33.2, body["outdoor"])
        expect(body["dispatch"]["context"]["footfall"] == 86, body["dispatch"]["context"])
        expect(len(body["dispatch"]["commands"]) == 5, body["dispatch"]["commands"])
        expect(body["dispatch"]["workOrders"][0]["code"] == "FCU-SALES", body["dispatch"]["workOrders"])
        payload = json.dumps({"question": "今、現場の機器へ出す指令は？"}).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/ask",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:
            asked = json.load(response)
        expect(asked["intent"] == "dispatch", asked["intent"])
        expect(len(asked["rows"]) == 6, len(asked["rows"]))
    finally:
        server.shutdown()
        server.server_close()

    print("確認できました。指令方針、状況データ、エージェント、HTTPが同じ朝のシナリオを参照しています。")


if __name__ == "__main__":
    main()
