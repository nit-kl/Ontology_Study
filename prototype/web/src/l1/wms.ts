// レイヤー1 WMS 東部 DC（AS/400 のグリーン画面風）。DC の在庫と、補充発注への引き当て。
// 在庫は卸側のコードで持つ。KINETIC からの引き当てが足りないときは断る（ここで判断するのは「在庫が足りるか」だけ）。
import "./wms.css";
import { productName, watch, type State } from "../lib/api";
import { $, esc, pad } from "../lib/dom";

const DC = "DC-01";
const STO = "STO-0141";
let S: State | null = null;

const c = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;
const line = (...parts: string[]) => parts.join("");

function render() {
  if (!S) return;
  const alloc = S.systems.wms_allocations[STO] ?? {};
  const remain = S.systems.wms_stock[DC] ?? {};
  // 引き当てられなかった要求（KINETIC の書き戻しの記録から）
  type Refused = { code: string; requested: number; available: number };
  const refusedLog = [...S.log].reverse().find((e) =>
    e.actor === "WMS / POS" && Object.keys((e.detail as { 引き当てられない?: object })?.引き当てられない ?? {}).length);
  const shortage = refusedLog
    ? Object.values((refusedLog.detail as { 引き当てられない: Record<string, Refused> }).引き当てられない)[0]
    : null;
  const time = (S.now.replace("翌 ", "") || "00:00") + ":00";
  const rows = [line(c("b", pad("WMS110R", 12)), c("w", pad("在庫照会　DC-01 東部ＤＣ", 54)), c("b", pad(time, 14, "right"))), ""];
  rows.push(c("w", line(pad("品目", 10), pad("品名", 24), pad("総在庫", 9, "right"), pad("引当済", 9, "right"), pad("有効在庫", 10, "right"))));
  for (const [code, left] of Object.entries(remain)) {
    const a = alloc[code] ?? 0;
    const cell = pad(String(left), 10, "right");
    rows.push(line(pad(code, 10), pad(productName(S, code), 24), pad(String(left + a), 9, "right"), pad(String(a), 9, "right"),
      left === 0 ? c("r", cell) : cell));
  }
  while (rows.length < 21) rows.push("");
  rows.push(shortage ? c("rr", pad(` CPF9898 有効在庫不足のため引当不可: ${shortage.code} 要求 ${shortage.requested} 有効 ${shortage.available}`, 80)) : "");
  $("#screen").innerHTML = rows.join("\n");
}

watch((s) => { S = s; render(); });
