"""レイヤー4 需要予測モデル（Amazon SageMaker の代わり）。

履歴の蓄積先の販売明細だけで学習し、明日の販売数と80%の幅を返す。
「明日は何がある日か」「履歴のない新商品はどれに似ているか」は自分で調べない。
AI がナレッジグラフから集めた特徴を受け取って使う。
"""

from __future__ import annotations

import csv
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

MODEL_VERSION = "v14"
HEAT_BASE = 25          # この気温を超えた分だけ伸びを見る
LAUNCH_SHARE = 0.35     # 新しいおにぎりの初日は、似た商品の何割売れるか（過去の発売日の実績から）


@dataclass
class Forecast:
    product: str
    mean: int
    lower: int
    upper: int
    version: str
    basis: str  # どう予測したかの説明

    def as_dict(self) -> dict:
        return self.__dict__.copy()


class DemandModel:
    version = MODEL_VERSION

    def __init__(self, history_csv: Path):
        rows = list(csv.DictReader(history_csv.open(encoding="utf-8")))
        self._fit(rows)

    def _fit(self, rows: list[dict]) -> None:
        by_product = defaultdict(list)
        for r in rows:
            by_product[r["product"]].append({
                "wd": date.fromisoformat(r["date"]).weekday(),
                "qty": int(r["qty"]),
                "heat": max(0, int(r["max_temp"]) - HEAT_BASE),
                "event": r["nearby_event_type"] or None,
            })
        self.baseline, self.slope, self.uplift, self.band = {}, {}, {}, {}
        for p, rs in by_product.items():
            plain = [r for r in rs if r["event"] is None]
            # 曜日ごとの基本の数は、暑くない普通の日の中央値
            base = {}
            for wd in range(7):
                cool = [r["qty"] for r in plain if r["wd"] == wd and r["heat"] == 0]
                any_ = [r["qty"] for r in plain if r["wd"] == wd]
                base[wd] = statistics.median(cool or any_)
            self.baseline[p] = base
            # 暑さの伸びは、普通の日の (実績 / 基本 − 1) を、25℃を超えた度数で最小二乗
            xy = sum(r["heat"] * (r["qty"] / base[r["wd"]] - 1) for r in plain)
            xx = sum(r["heat"] ** 2 for r in plain)
            self.slope[p] = max(0.0, xy / xx) if xx else 0.0
            # イベントの伸びは、イベントの日の (実績 / 暑さ込みの基本) の中央値
            ups = defaultdict(list)
            for r in rs:
                if r["event"]:
                    ups[r["event"]].append(r["qty"] / self._plain(p, r["wd"], r["heat"]))
            self.uplift[p] = {k: statistics.median(v) for k, v in ups.items()}
            # 80%の幅は、学習データでの (実績 / 当てはめ) の10%点と90%点
            ratios = sorted(r["qty"] / self._fitted(p, r["wd"], r["heat"], r["event"]) for r in rs)
            self.band[p] = (_quantile(ratios, 0.1), _quantile(ratios, 0.9))

    def _plain(self, p: str, wd: int, heat: int) -> float:
        return self.baseline[p][wd] * (1 + self.slope[p] * heat)

    def _fitted(self, p: str, wd: int, heat: int, event: str | None) -> float:
        return self._plain(p, wd, heat) * (self.uplift[p].get(event, 1.0) if event else 1.0)

    def knows(self, product: str) -> bool:
        return product in self.baseline

    def predict(self, product: str, day: date, max_temp: int, event_type: str | None = None,
                similar_product: str | None = None) -> Forecast:
        """event_type と similar_product は、AI がナレッジグラフから集めた特徴。"""
        heat = max(0, max_temp - HEAT_BASE)
        source, share = product, 1.0
        if not self.knows(product):
            if not similar_product or not self.knows(similar_product):
                raise ValueError(f"{product} は履歴がなく、似た商品も渡されていない")
            source, share = similar_product, LAUNCH_SHARE
        f = self._fitted(source, day.weekday(), heat, event_type) * share
        lo, hi = self.band[source]
        parts = [f"{['月','火','水','木','金','土','日'][day.weekday()]}曜の基本 {self.baseline[source][day.weekday()]:g}"]
        if heat:
            parts.append(f"暑さ {max_temp}℃ ×{1 + self.slope[source] * heat:.2f}")
        if event_type:
            parts.append(f"イベント ×{self.uplift[source].get(event_type, 1.0):.2f}")
        if source != product:
            parts.append(f"{similar_product} の履歴を借りて ×{share}")
        return Forecast(product, round(f), round(f * lo), round(f * hi), self.version, "、".join(parts))


def _quantile(xs: list[float], q: float) -> float:
    i = (len(xs) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)
