// レイヤー1 SAP S/4HANA（SAP GUI 風）。KINETIC が BAPI で作った在庫転送オーダ（ME23N）を見る。判断はしない。
import "./sap.css";
import { productName, storeName, watch, type State } from "../lib/api";
import { $, esc, toast } from "../lib/dom";

const UNIT: Record<string, string> = { "R-3310": "BT", "R-3901": "BG", "R-5581": "BT" };

let S: State | null = null;
let doc = "";

watch((s) => {
  const loaded = S !== null;
  const before = JSON.stringify(S?.systems.sap_orders ?? {});
  S = s;
  const after = JSON.stringify(s.systems.sap_orders);
  if (loaded && after !== before && after !== "{}") toast("在庫転送オーダ更新");
  const docs = Object.keys(s.systems.sap_orders);
  if (!docs.includes(doc)) doc = docs[0] ?? "";
  render();
});

function render() {
  if (!S) return;
  const body = $("#body");
  const o = S.systems.sap_orders[doc];
  const docs = Object.keys(S.systems.sap_orders);
  $("#apptoolbar").innerHTML = `<select id="docsel">${docs.map((d) => `<option ${d === doc ? "selected" : ""}>${d}</option>`).join("")}</select>`;
  document.getElementById("docsel")?.addEventListener("change", (e) => { doc = (e.target as HTMLSelectElement).value; render(); });
  if (!o) return void (body.innerHTML = `<p class="empty">―</p>`);
  const lastSap = [...S.log].reverse().find((e) => e.actor.startsWith("SAP"));
  const changed = new Set(Object.keys((lastSap?.detail as Record<string, number>) ?? {}));
  body.innerHTML = `<fieldset><div class="form">
    <label>供給</label><div class="val">${o.dc} ${storeName(o.dc)}</div><label>受入</label><div class="val">${o.store} ${storeName(o.store)}</div>
    <label>納入日付</label><div class="val">${o.date.replaceAll("-", "/")}</div><label>作成者</label><div class="val">RFC_KINETIC</div></div></fieldset>
    <table class="alv"><tr><th>明細</th><th>品目</th><th>品目テキスト</th><th>数量</th><th>単位</th></tr>
    ${Object.entries(o.lines).map(([p, q], i) => `<tr class="${changed.has(p) ? "changed" : ""}"><td class="n">${(i + 1) * 10}</td><td>${p}</td>
      <td>${esc(productName(S!, p))}</td><td class="n">${q}</td><td>${UNIT[p] ?? "PC"}</td></tr>`).join("")}
    </table>`;
}
