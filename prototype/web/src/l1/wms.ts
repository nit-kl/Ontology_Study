// レイヤー1 WMS 東部 DC（AS/400 のグリーン画面風）。DC の在庫と、店の補充発注の出荷への引き当て。
// 在庫は卸側のコードで持つ。KINETIC からの引き当てが足りないときは断る（ここで判断するのは「在庫が足りるか」だけ）。
import "./wms.css";
import { productName, watch, type State } from "../lib/api";
import { $, esc, pad } from "../lib/dom";

type Scr = "menu" | "stock" | "alloc" | "log";
const DC = "DC-01";
const STO = "STO-0141";
let S: State | null = null;
let scr: Scr = (["menu", "stock", "alloc", "log"] as const).find((k) => k === location.hash.slice(1)) ?? "menu";

const c = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;
const line = (...parts: string[]) => parts.join("");

function header(program: string, title: string): string[] {
  const now = S?.now ?? "";
  const date = now.startsWith("翌") ? "10/24/26" : "10/23/26";
  const time = (now.replace("翌 ", "") || "00:00") + ":00";
  return [
    line(c("b", pad(program, 12)), c("w", pad(title, 54)), c("b", pad(date, 14, "right"))),
    line(c("b", pad("EASTDC01", 12)), pad("", 54), c("b", pad(time, 14, "right"))),
    "",
  ];
}

function fkeys(keys: [string, string][]): string {
  return keys.map(([k, label]) => `<span class="fk t" data-key="${k}">${esc(`${k}=${label}`)}</span>`).join("  ");
}

function render() {
  if (!S) return;
  const rows: string[] = [];
  const alloc = S.systems.wms_allocations[STO] ?? {};
  const remain = S.systems.wms_stock[DC] ?? {};
  // 引き当てられなかった要求（KINETIC の書き戻しの記録から）
  type Refused = { code: string; requested: number; available: number };
  const refusedLog = [...S.log].reverse().find((e) =>
    e.actor === "WMS / POS" && Object.keys((e.detail as { 引き当てられない?: object })?.引き当てられない ?? {}).length);
  const shortage = refusedLog
    ? Object.values((refusedLog.detail as { 引き当てられない: Record<string, Refused> }).引き当てられない)[0]
    : null;
  let message = "";

  if (scr === "menu") {
    rows.push(...header("WMSMNU", "東部ＤＣ　倉庫管理システム　メインメニュー"));
    rows.push("選択項目を入力してください。", "");
    rows.push(line("     ", c("w", "1."), " 在庫照会（品目別）"));
    rows.push(line("     ", c("w", "2."), " 出荷引当照会（在庫転送オーダ別）"));
    rows.push(line("     ", c("w", "3."), " 処理ログ照会"));
    rows.push(line("     ", c("w", "90."), " サインオフ"));
    while (rows.length < 19) rows.push("");
    rows.push(line("選択項目またはコマンド", ""));
    rows.push(line("===> ", `<input id="cmd" maxlength="2" autocomplete="off">`));
  } else if (scr === "stock") {
    rows.push(...header("WMS110R", "在庫照会　　　　　倉庫: DC-01 東部ＤＣ"));
    rows.push(c("w", line(pad("品目", 10), pad("品名", 24), pad("総在庫", 9, "right"), pad("引当済", 9, "right"), pad("有効在庫", 10, "right"), "  ", pad("状態", 8))));
    for (const [code, left] of Object.entries(remain)) {
      const a = alloc[code] ?? 0;
      const low = left === 0;
      rows.push(line(pad(code, 10), pad(productName(S, code), 24), pad(String(left + a), 9, "right"), pad(String(a), 9, "right"),
        low ? c("r", pad(String(left), 10, "right")) : pad(String(left), 10, "right"), "  ", low ? c("r", pad("在庫ナシ", 8)) : pad("", 8)));
    }
    while (rows.length < 21) rows.push("");
    if (shortage) message = c("rr", pad(` CPF9898 有効在庫不足のため引当不可: ${shortage.code} 要求 ${shortage.requested} 有効 ${shortage.available}`, 80));
  } else if (scr === "alloc") {
    rows.push(...header("WMS210R", "出荷引当照会　　　オーダ: " + STO));
    rows.push(line("出荷元 ", c("w", "DC-01"), "   出荷先 ", c("w", "ST-014 1号店"), "   出荷予定 ", c("w", "10/24 05:00")));
    rows.push("");
    rows.push(c("w", line(pad("品目", 10), pad("品名", 26), pad("数量", 8, "right"), "  ", pad("状態", 12))));
    const done = S.workflow_state === "完了";
    for (const [code, q] of Object.entries(alloc)) {
      rows.push(line(pad(code, 10), pad(productName(S, code), 26), pad(String(q), 8, "right"), "  ", done ? c("y", pad("出荷済", 12)) : pad("引当済", 12)));
    }
    if (!Object.keys(alloc).length) rows.push(c("y", "  該当するレコードがありません。"));
    while (rows.length < 21) rows.push("");
    if (shortage && !done) message = c("y", pad(` 前回の引当要求で ${shortage.code} が不足しました。要求数量の修正を受信済みです。`, 80));
  } else {
    rows.push(...header("WMS900R", "処理ログ照会"));
    rows.push(c("w", line(pad("時刻", 10), pad("要求元", 12), "内容")));
    const logs = S.log.filter((e) => e.actor.includes("WMS") || e.title.startsWith("WMS が受け付けない"));
    for (const e of logs.slice(-14)) {
      const err = e.title.startsWith("WMS が受け付けない");
      rows.push(line(pad(e.time, 10), pad(e.layer === "L4" ? "KINETIC" : "WMS", 12),
        err ? c("r", pad("CPF9898 引当不可 " + e.title.replace(/^WMS が受け付けない: /, ""), 58)) : pad(e.title, 58)));
    }
    while (rows.length < 21) rows.push("");
  }
  rows.push(message || "");
  rows.push(scr === "menu" ? fkeys([["F3", "終了"], ["F12", "取消"]]) : fkeys([["F3", "戻る"], ["F5", "再表示"], ["F12", "取消"]]));
  $("#screen").innerHTML = rows.join("\n");
  $("#oia-msg").textContent = shortage && scr !== "menu" ? "X II" : "";
  document.querySelectorAll<HTMLElement>(".fk").forEach((el) => (el.onclick = () => key(el.dataset.key!)));
  const cmd = document.getElementById("cmd") as HTMLInputElement | null;
  if (cmd) {
    cmd.focus();
    cmd.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      scr = ({ "1": "stock", "2": "alloc", "3": "log" } as Record<string, Scr>)[cmd.value.trim()] ?? "menu";
      render();
    };
  }
}

function key(k: string) {
  if (k === "F3" || k === "F12") scr = "menu";
  render();
}

document.addEventListener("keydown", (e) => {
  if (["F3", "F5", "F12"].includes(e.key)) {
    e.preventDefault();
    key(e.key);
  }
});

watch((s) => { S = s; render(); });
