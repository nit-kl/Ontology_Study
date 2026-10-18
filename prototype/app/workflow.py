"""レイヤー4 KINETIC のワークフローの共通部分。

どのワークフローも、自分では判断しない。スケジュールで起き、AI に提案を頼み、SHACL からの確定イベントを受けて
レイヤー1 へ書き戻し、承認と時刻を待つ。画面は actions() の一覧からボタンを作る。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .action_gate import ActionGate
from .layer1 import Layer1
from .layer3_kg import KnowledgeGraph


@dataclass
class Context:
    l1: Layer1
    kg: KnowledgeGraph
    gate: ActionGate
    log: Callable[..., None]
    set_time: Callable[[str], None]
    lake: list


class Workflow:
    title = ""

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.l1, self.kg, self.gate, self.log, self.set_time = ctx.l1, ctx.kg, ctx.gate, ctx.log, ctx.set_time
        self.state = "待機"
        self.validations: list[dict] = []
        self.approval_request: dict | None = None
        self.cloud_events: list[dict] = []
        self.gate.listeners.append(self._on_event)

    # 画面のボタン: [{"id", "label", "enabled"}]
    def actions(self) -> list[dict]:
        raise NotImplementedError

    def do(self, action: str, **kwargs) -> None:
        fn = getattr(self, f"act_{action}", None)
        enabled = {a["id"]: a["enabled"] for a in self.actions()}
        if fn is None or not enabled.get(action):
            raise RuntimeError(f"今（{self.state}）は「{action}」を受け付けない")
        fn(**kwargs)

    def payload(self) -> dict:
        """シナリオごとの画面向けの中身。"""
        return {}

    def _on_event(self, event: dict) -> None:
        self.cloud_events.append(event)
        self.on_confirmed(event)

    def on_confirmed(self, event: dict) -> None:
        raise NotImplementedError

    def record_validation(self, label: str, result, at: int | None = None) -> None:
        entry = {"label": label, "shapes": result.shapes, "conforms": result.conforms, "results": result.results}
        self.validations.insert(len(self.validations) if at is None else at, entry)
