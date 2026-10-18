"""シナリオを画面なしで最後まで流し、出来事の流れと結果を表示する。

    .venv/Scripts/python run_demo.py                # UC1
    .venv/Scripts/python run_demo.py uc2            # UC2（uc3 も同じ）
    .venv/Scripts/python run_demo.py uc3 --detail   # 各出来事の中身も
"""

import json
import sys

from app.demo import Demo


def main() -> None:
    detail = "--detail" in sys.argv
    scenario = next((a for a in sys.argv[1:] if a.startswith("uc")), "uc1")
    sys.stdout.reconfigure(encoding="utf-8")
    d = Demo(scenario)
    d.run_all()
    print(d.workflow.title, "・", d.day)
    print()
    for e in d.log_entries:
        print(f"{e['time']:>8}  {e['layer']} {e['actor']:<10} {e['title']}")
        if detail and e["detail"] is not None:
            print("          " + json.dumps(e["detail"], ensure_ascii=False, default=str)[:600])
    print()
    if scenario == "uc1":
        print("確定した発注（SAP の在庫転送オーダ STO-0141）")
        for p, q in d.layer1.sap.orders["STO-0141"]["lines"].items():
            ln = d.workflow.plan.lines[p]
            rec = ln.recommended if ln.recommended is not None else "なし"
            print(f"  {p} {ln.name:<16} 推奨 {rec:>4}  発注 {q:>4}  {' → '.join(ln.history)}")
    elif scenario == "uc2":
        ctx = d.workflow.agent.context
        peak = max(h["kw"] for h in d.layer1.bms.history[1:])
        print(f"何もしないときの見込み {ctx['projected_kw']:.0f}kW → 計画 {ctx['planned_kw']:.0f}kW → 実績の最大 {peak:.0f}kW"
              f"（契約電力 {d.layer1.bms.contract_kw}kW）")
        for s in d.workflow.settings.values():
            print(f"  {s.status:<4} {s.label}")
    else:
        for t in d.workflow.transfers.values():
            print(f"  {t.id} {t.name} {t.quantity}: {t.source} → {t.dest}（{t.vehicle} {t.eta}）{t.status} {' '.join(t.history)}")
        for lb in d.layer1.pos.labels:
            print(f"  {lb['time']} {lb['store']} {lb['product']} {lb['discount']}%引き → {lb['price']}円")


if __name__ == "__main__":
    main()
