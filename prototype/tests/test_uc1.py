"""UC1「明日の発注と需要予測」を端から端まで流して、資料のシナリオどおりになるかを確かめる。"""

import pytest
from fastapi.testclient import TestClient

from app.demo import Demo


@pytest.fixture
def demo():
    return Demo()


def test_owl_finds_products_affected_by_tomorrow(demo):
    demo.start()
    products = demo.workflow.agent.context["products"]
    affected = {p for p, i in products.items() if i["reasons"]}
    assert affected == {"R-9020", "R-9105", "R-3310", "R-3901"}
    assert products["R-9105"]["similar"] == "R-9020"
    nearby = [e["id"] for e in demo.workflow.agent.context["events"] if e["nearby"]]
    assert nearby == ["E-1027"]   # 祭りは小さく、コンサートは遠いので外れる


def test_shacl_rejects_ice_that_does_not_fit_then_agent_fixes(demo):
    demo.start()
    first = demo.workflow.validations[0]
    assert not first["conforms"]
    assert [(r["focus"], r["check"]) for r in first["results"]] == [("OP-0141/R-3901", "置き場の容量")]
    assert demo.workflow.validations[1]["conforms"]
    assert demo.workflow.plan.lines["R-3901"].quantity == 36


def test_only_lines_over_policy_wait_for_manager(demo):
    demo.start()
    assert demo.workflow.state == "承認待ち"
    waiting = {ln["product"] for ln in demo.workflow.approval_request["lines"]}
    assert waiting == {"R-9020", "R-3310", "R-3901"}
    sap = demo.layer1.sap.orders["STO-0141"]["lines"]
    assert sap == {"R-9105": 36, "R-5581": 24, "R-6120": 18, "R-8104": 20}


def test_end_to_end_quantities_match_the_scenario(demo):
    demo.run_all()
    assert demo.workflow.state == "完了"
    assert demo.layer1.sap.orders["STO-0141"]["lines"] == {
        "R-9020": 108, "R-9105": 36, "R-3310": 96, "R-3901": 36,
        "R-5581": 24, "R-6120": 18, "R-8104": 20}
    # DC の在庫不足は、卸側コード（UnifiedSKU で推論）で WMS に引き当てて見つかる
    assert demo.layer1.wms.allocations["STO-0141"]["W-31008"] == 96
    # 確定した発注計画と、CDC で戻った SAP の発注が一致する
    planned = {r["l"].rsplit("/", 1)[-1]: r["q"] for r in demo.sparql(
        "SELECT ?l ?q WHERE { GRAPH <urn:example:graph:plans> { ?l ex:quantity ?q } }", inferred=False)}
    assert planned == {k: str(v) for k, v in demo.layer1.sap.orders["STO-0141"]["lines"].items()}


def test_approval_without_permission_is_rejected(demo):
    demo.start()
    demo.approve("buyer-01")   # ODRL で1号店の発注の承認の権限がない
    rejected = demo.workflow.validations[-1]
    assert not rejected["conforms"] and {r["check"] for r in rejected["results"]} == {"承認"}
    assert "R-9020" not in demo.layer1.sap.orders["STO-0141"]["lines"]


def test_audit_graph_keeps_who_and_which_model(demo):
    demo.run_all()
    labels = [(a["agent"], a["used"]) for a in demo.audit.entries]
    assert ("manager-ST014", ["E-1027", "East/2026-10-24", "v14"]) in labels
    assert "prov:wasAssociatedWith person:manager-ST014" in demo.audit.turtle()


def test_inferred_triples_are_not_stored(demo):
    demo.start()
    stored = demo.sparql("SELECT ?p WHERE { ?p ex:boostedByEvent ?e }", inferred=False)
    inferred = demo.sparql("SELECT ?p WHERE { ?p ex:boostedByEvent ?e }", inferred=True)
    assert stored == [] and len(inferred) >= 4


def test_api_walkthrough():
    from app.server import app
    c = TestClient(app)
    assert c.post("/api/reset").status_code == 200
    assert c.get("/").status_code == 200   # ビルド済みなら司令塔、未ビルドならビルドの案内
    assert c.get("/api/revision").json()["state"] == "待機"
    assert c.post("/api/approve").status_code == 409   # まだ承認待ちではない
    assert c.post("/api/start").json()["workflow_state"] == "承認待ち"
    assert c.post("/api/approve").json()["workflow_state"] == "締め待ち"
    assert c.post("/api/advance").json()["workflow_state"] == "完了"
    rows = c.post("/api/sparql", json={"query": "SELECT ?e WHERE { ?e a ex:Event }"}).json()["rows"]
    assert len(rows) == 3
    assert "OP-0141" in c.get("/api/graph/plans").text
