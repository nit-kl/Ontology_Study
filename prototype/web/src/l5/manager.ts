// レイヤー5 店長アプリ（店のタブレット）。今日の数字、店長の判断が要る業務、AI と方針が自動で処理した履歴を見る。
// 画面に出すのは、レイヤー3 の事前検証に合格した提案だけ。承認はレイヤー3 の SHACL で再検証される。
// UC1・UC2 は1号店の店長、UC3 は受け入れる2号店の店長が使う。
import "./modern.css";
import "./manager.css";
import { act, storeName, watch, type Line, type State, type Transfer } from "../lib/api";
import { $, esc, toast } from "../lib/dom";

const STORE_OF: Record<string, string> = { "manager-ST014": "ST-014", "manager-ST031": "ST-031" };
let S: State | null = null;
let user = "";
let sending = false;

watch((s) => {
  user = s.scenario === "uc3" ? "manager-ST031" : "manager-ST014";
  S = s;
  render();
});

async function approve() {
  sending = true;
  render();
  const r = await act("approve");
  sending = false;
  if (!r.ok) return toast(r.message);
  S = r.state;
  toast(`承認しました（${S.now}）`);
  render();
}

const store = () => STORE_OF[user];
const mine = () => !!S?.approval_request && S.approval_request.approver === user;

/** 業務日付と時刻（「翌」は次の日）。 */
function when(s: State): string {
  const d = new Date(s.day + "T00:00:00");
  if (s.now.startsWith("翌")) d.setDate(d.getDate() + 1);
  return `${d.getMonth() + 1}/${d.getDate()}（${"日月火水木金土"[d.getDay()]}） ${s.now.replace("翌 ", "")}`;
}

function render() {
  if (!S) return;
  $("#store").textContent = `${storeName(store())}（${store()}）`;
  $("#when").textContent = when(S);
  $("#user").textContent = `${storeName(store())} 店長`;
  $("#kpis").innerHTML = kpis().map(([k, v, u]) => `<div class="kpi"><span>${k}</span><b>${v}<small>${u}</small></b></div>`).join("");
  $("#count").textContent = mine() ? "1" : "0";
  $("#count").className = "count" + (mine() ? " on" : "");
  $("#todo").innerHTML = mine() ? approval() : `<div class="none">✓ 対応が必要な業務はありません</div>`;
  $("#history").innerHTML = history();
  document.getElementById("approve")?.addEventListener("click", () => void approve());
}

// ---- 今日の数字 ------------------------------------------------------------------

function kpis(): [string, string, string][] {
  const s = S!;
  const dash = (v: number | undefined, ok = true) => (ok && v != null ? v.toLocaleString() : "―");
  if (s.scenario === "uc1") {
    const lines = s.plan?.lines ?? [];
    const has = lines.length > 0;
    return [
      ["明日の発注", dash(lines.length, has), "品目"],
      ["自動で確定", dash(lines.filter((l) => l.status === "確定" && !l.approved_by).length, has), "品目"],
      ["承認待ち", dash(lines.filter((l) => l.status === "承認待ち").length, has), "品目"],
      ["確定数量", dash(lines.reduce((n, l) => n + (l.status === "確定" ? l.quantity : 0), 0), has), "個"],
    ];
  }
  if (s.scenario === "uc2") {
    const c = s.uc2!.context;
    const b = s.systems.bms;
    const peak = b.history.length > 1 ? Math.max(...b.history.slice(1).map((h) => h.kw)) : undefined;
    return [
      ["現在の電力", dash(b.history[b.history.length - 1].kw), "kW"],
      ["契約電力", dash(b.contract_kw), "kW"],
      ["調整後の見込み", dash(c.planned_kw), "kW"],
      ["本日の最大", dash(peak), "kW"],
    ];
  }
  const u = s.uc3!;
  const has = u.transfers.length > 0;
  return [
    ["受け入れ予定", dash(u.transfers.filter((t) => t.dest === store()).length, has), "便"],
    ["受け入れ数量", dash(u.transfers.filter((t) => t.dest === store()).reduce((n, t) => n + t.quantity, 0), has), "個"],
    ["送り出し", dash(u.transfers.filter((t) => t.source === store()).length, has), "便"],
    ["見切り", dash(u.markdowns.filter((m) => m.store === store()).length, has), "件"],
  ];
}

// ---- 要対応 ----------------------------------------------------------------------

function approval(): string {
  const a = S!.approval_request!;
  const isTransfer = a.kind === "transfer";
  return `<article class="task">
      <div class="task-head"><span class="tag wait">承認待ち</span><b>${isTransfer ? "店間移動の受け入れ" : "明日の発注（推奨数の1.5倍超）"}</b><span class="no">${esc(a.plan)}</span></div>
      <p class="msg">${esc(a.message)}</p>
      ${isTransfer ? transferTable(a.lines as Transfer[]) : orderTable(a.lines as Line[])}
      <p class="check">✓ 本部のルール点検（SHACL）合格済み</p>
      <div class="actions"><button class="btn" id="approve" ${sending ? "disabled" : ""}>${sending ? "送信中…" : "承認する"}</button></div>
    </article>`;
}

function orderTable(lines: Line[]): string {
  return `<table class="grid"><tr><th>品目</th><th class="n">推奨</th><th class="n">予測</th><th class="n">発注</th><th class="n">倍率</th></tr>
    ${lines.map((l) => `<tr><td>${esc(l.name)}<small>${esc(l.reason.replace(/ E-\d+/, ""))}</small></td>
      <td class="n">${l.recommended ?? "―"}</td>
      <td class="n">${l.forecast ? `${l.forecast.mean}<small>${l.forecast.lower}〜${l.forecast.upper}</small>` : "―"}</td>
      <td class="n"><b>${l.quantity}</b></td><td class="n warn">${l.ratio ? `×${l.ratio}` : ""}</td></tr>`).join("")}</table>`;
}

function transferTable(lines: Transfer[]): string {
  return `<table class="grid"><tr><th>品目</th><th class="n">数量</th><th>送り元</th><th>便</th><th>到着</th></tr>
    ${lines.map((t) => {
      const e = S!.uc3!.context.estimates?.find((x) => x.store === store() && x.product === t.product);
      return `<tr><td>${esc(t.name)}${e ? `<small>当店在庫 ${e.stock}・閉店まで ${e.rest} 売れる見込み${e.runout ? `・${Math.floor(e.runout)}時ごろ欠品` : ""}</small>` : ""}</td>
        <td class="n"><b>${t.quantity}</b></td><td>${storeName(t.source)}</td><td>${t.vehicle}</td><td>${t.eta}</td></tr>`;
    }).join("")}</table>`;
}

// ---- 処理履歴 --------------------------------------------------------------------

function history(): string {
  const s = S!;
  const rows = [
    ...s.audit.map((a) => ({ time: a.time, text: a.label, sub: a.rule ?? "", kind: a.agent.startsWith("manager") ? "承認" : "自動" })),
    ...(s.uc2?.notifications ?? []).map((n) => ({ time: n.time, text: n.title, sub: n.body, kind: n.title.includes("戻しました") ? "修正" : "通知" })),
  ].sort((x, y) => y.time.localeCompare(x.time));
  const cls: Record<string, string> = { 承認: "ok", 自動: "auto", 修正: "warn", 通知: "" };
  return rows.length ? `<table class="log">${rows.map((r) => `<tr><td class="t">${esc(r.time)}</td><td><span class="tag ${cls[r.kind]}">${r.kind}</span></td>
      <td>${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</td></tr>`).join("")}</table>`
    : `<div class="none">履歴はまだありません</div>`;
}
