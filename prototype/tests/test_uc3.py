"""UC3「夕方の在庫融通と見切り」を流して、資料のシナリオどおりになるかを確かめる。"""

import pytest

from app.demo import Demo


@pytest.fixture
def demo():
    d = Demo("uc3")
    d.start()
    return d


def test_plan_matches_scenario(demo):
    t = {x["id"]: (x["product"], x["quantity"], x["source"], x["dest"], x["vehicle"]) for x in demo.state()["uc3"]["transfers"]}
    assert t == {"T-1601": ("R-5581", 20, "ST-014", "ST-031", "V-14"),
                 "T-1602": ("R-6120", 55, "ST-040", "ST-031", "V-40")}
    m = demo.state()["uc3"]["markdowns"]
    assert [(x["store"], x["product"], x["steps"]) for x in m] == [("ST-040", "R-8104", [(19.0, 30), (20.5, 50)])]


def test_only_over_limit_transfer_waits_for_receiving_manager(demo):
    assert demo.workflow.state == "承認待ち"
    assert demo.workflow.approval_request["approver"] == "manager-ST031"
    assert [x["id"] for x in demo.workflow.approval_request["lines"]] == ["T-1602"]
    assert set(demo.layer1.sap.orders) == {"T-1601"}


def test_end_to_end(demo):
    demo.run_all()
    assert demo.workflow.state == "完了"
    assert demo.layer1.sap.orders["T-1601"]["lines"] == {"R-5581": 18}   # 17:05 に18本へ修正
    assert demo.layer1.sap.orders["T-1602"]["lines"] == {"R-6120": 55}
    assert demo.layer1.pos.state["ST-031"]["R-5581"]["stock"] == 4 + 18
    assert [(l["time"], l["discount"], l["price"]) for l in demo.layer1.pos.labels] == [("19:00", 30, 349), ("20:30", 50, 249)]
    assert {s["vehicle"]: s["status"] for s in demo.layer1.tms.stops} == {"V-14": "完了", "V-40": "完了"}


def test_shacl_rejects_transfer_on_wrong_vehicle():
    from app.layer4_uc3 import plan_graph
    d = Demo("uc3")
    d.start()
    t = d.workflow.transfers["T-1601"]
    t.vehicle = "V-40"          # 3号店の車に、1号店の牛乳を積もうとする
    t.quantity = 75             # しかも車の空き（70）に入らず、1号店にネットスーパーの引当分も残らない
    res = d.gate.pre_validate(plan_graph(d.workflow.day, [t], []))
    assert not res.conforms
    assert {r["check"] for r in res.results} == {"在庫移動: 帰り便", "在庫移動: 車の空き", "在庫移動: 引当分"}
