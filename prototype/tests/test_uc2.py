"""UC2「電力ピークの自動調整」を流して、資料のシナリオどおりになるかを確かめる。"""

import pytest

from app.demo import Demo


@pytest.fixture
def demo():
    d = Demo("uc2")
    d.start()
    return d


def test_owl_finds_peak_adjustable_equipment_and_projection(demo):
    ctx = demo.workflow.agent.context
    assert ctx["projected_kw"] == 830.0          # 何もしないと契約電力 800kW を超える
    assert len(ctx["defrost_in_peak"]) == 12      # 14:00 の霜取りが重なる冷蔵ケース
    kinds = {e["id"]: e["kinds"] for e in ctx["adjustable"]}
    assert kinds["FZ-01"] == ["Precool"] and kinds["LZ-4"] == ["Dimming"] and "LZ-1" not in kinds


def test_plan_follows_policy_order_and_is_auto_confirmed(demo):
    ctx = demo.workflow.agent.context
    assert [s["kind"] for s in ctx["steps"]] == ["DefrostShift", "Precool", "Setpoint", "Dimming"]
    assert ctx["planned_kw"] == 758.0
    assert demo.workflow.state == "実行待ち"
    assert demo.audit.entries[0]["agent"] == "PeakPolicy"   # 方針の範囲内なので承認なし
    assert demo.layer1.bms.equipment["RC-01"]["defrost"] == [2, 8, 12.75, 20]


def test_monitoring_reverts_only_ahu2_and_peak_stays_under_contract(demo):
    demo.run_all()
    violations = [m for m in demo.workflow.monitor_log if not m["conforms"]]
    assert [(m["time"], m["results"][0]["focus"]) for m in violations] == [("14:20", "ZT-2")]
    assert demo.workflow.settings["AHU-2-revert"].status == "確定"
    assert demo.workflow.settings["AHU-1-setpoint"].status == "確定"
    assert max(h["kw"] for h in demo.layer1.bms.history) < demo.layer1.bms.contract_kw
    fz = [h["FZ-01-T1"] for h in demo.layer1.bms.history]
    assert max(fz) <= -18                         # 冷凍の温度帯を外れない


def test_out_of_policy_setting_needs_manager():
    from app.layer4_uc2 import Setting, settings_graph
    d = Demo("uc2")
    s = Setting("AHU-1-setpoint", "AHU-1", "Setpoint", "AHU-1 を 27℃", 10,
                {"setpoint": 27, "from": "14:00", "to": "15:00", "predictedZoneMax": 26.9})
    needs = d.gate.needs_approval(settings_graph([s], "2026-08-07"))
    assert any("自動の範囲" in m for m in needs.values())
