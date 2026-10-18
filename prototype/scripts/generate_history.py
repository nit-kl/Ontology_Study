"""履歴の蓄積先（データレイク）に置く、1号店の過去8週間の販売明細を作る。

需要予測モデルの学習データになる。乱数の種を固定しているので、何度実行しても同じ CSV になる。
過去の土曜のうち3日は東部スタジアムで試合があった日、暑い日も何日か混ぜてある。
"""

import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "lake" / "sales_history.csv"
TODAY = date(2026, 10, 23)  # デモの「今日」（金曜）。明日 10/24（土）が予測の対象
DAYS = 56

# 商品ごとの曜日別の基本の販売数（月〜日）
BASE = {
    "R-9020": [44, 42, 43, 45, 50, 59, 55],  # 鮭おにぎり
    "R-3310": [30, 29, 30, 31, 36, 46, 42],  # スポーツドリンク
    "R-3901": [12, 11, 12, 12, 15, 19, 18],  # 氷
    "R-5581": [22, 21, 22, 22, 24, 26, 25],  # B社 オーガニック牛乳
    "R-6120": [15, 15, 16, 15, 17, 19, 18],  # ヨーグルト
    "R-8104": [18, 17, 18, 18, 21, 22, 20],  # 幕の内弁当
}
# 気温が25℃を1℃超えるごとの伸び
TEMP_SLOPE = {"R-9020": 0.012, "R-3310": 0.07, "R-3901": 0.10}
# 近くでスポーツ観戦のイベントがある日の伸び
EVENT_UPLIFT = {"R-9020": 1.68, "R-3310": 1.70, "R-3901": 1.62}
# 過去の試合の日（いずれも土曜）
EVENT_DAYS = {date(2026, 9, 5): "E-0905", date(2026, 9, 26): "E-0926", date(2026, 10, 10): "E-1010"}


def max_temp(d: date) -> int:
    # 9月初めは暑く、10月に向けて下がる。ところどころ暑い日が混ざる
    seasonal = 31 - (d - date(2026, 8, 28)).days * 0.16
    bump = 4 if d.day % 9 == 0 else 0
    return round(seasonal + bump + 1.5 * math.sin(d.toordinal()))


def main() -> None:
    rng = random.Random(20261023)
    rows = []
    for i in range(DAYS, 0, -1):
        d = TODAY - timedelta(days=i)
        t = max_temp(d)
        event = EVENT_DAYS.get(d, "")
        for sku, base in BASE.items():
            mu = base[d.weekday()] * (1 + TEMP_SLOPE.get(sku, 0) * max(0, t - 25))
            if event:
                mu *= EVENT_UPLIFT.get(sku, 1.0)
            qty = max(0, round(mu * rng.gauss(1.0, 0.07)))
            rows.append({"date": d.isoformat(), "store": "ST-014", "product": sku,
                         "qty": qty, "max_temp": t, "nearby_event": event,
                         "nearby_event_type": "SportsWatching" if event else ""})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} 行を {OUT} に書きました")


if __name__ == "__main__":
    main()
