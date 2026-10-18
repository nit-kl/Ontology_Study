// レイヤー1 店舗システム（POS、Windows 98 の業務アプリ風）。
// 店頭在庫と今日の販売数の原本。KINETIC から入荷予定と売価変更を受ける。
import "./pos.css";
import { productName, storeName, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type View = "stock" | "incoming" | "labels";
const VIEWS: [View, string][] = [["stock", "在庫"], ["incoming", "入荷予定"], ["labels", "売価変更"]];
const STORES = ["ST-014", "ST-031", "ST-040"];
let STORE = new URLSearchParams(location.search).get("store") ?? "ST-014";

let S: State | null = null;
let view: View = VIEWS.some(([k]) => k === location.hash.slice(1)) ? (location.hash.slice(1) as View) : "stock";
let lastIncoming = "";

$("#toolbar").innerHTML = VIEWS.map(([k, n]) => `<button class="btn" data-v="${k}">${n}</button>`).join("") +
  `<select id="store">${STORES.map((s) => `<option value="${s}" ${s === STORE ? "selected" : ""}>${storeName(s)}</option>`).join("")}</select>`;
$$<HTMLElement>("[data-v]").forEach((el) => (el.onclick = () => { view = el.dataset.v as View; render(); }));
$<HTMLSelectElement>("#store").onchange = (e) => {
  STORE = (e.target as HTMLSelectElement).value;
  lastIncoming = JSON.stringify(S?.systems.pos_incoming[STORE] ?? {});
  render();
};

watch((s) => {
  const inc = JSON.stringify(s.systems.pos_incoming[STORE] ?? {});
  if (S && inc !== lastIncoming && inc !== "{}") toast("入荷予定を受信");
  lastIncoming = inc;
  S = s;
  render();
});

function render() {
  if (!S) return;
  $$<HTMLElement>("[data-v]").forEach((el) => el.classList.toggle("on", el.dataset.v === view));
  const main = $("#main");
  const stock = S.systems.pos_stock[STORE] ?? {};
  const sold = S.systems.pos_sold_today[STORE] ?? {};
  const incoming = S.systems.pos_incoming[STORE] ?? {};
  const detail = S.systems.pos_detail[STORE] ?? {};
  $("#store-title").textContent = storeName(STORE);

  if (view === "stock") {
    main.innerHTML = `<div class="grid"><table><tr><th>商品CD</th><th>商品名</th><th>在庫</th><th>販売</th><th>期限</th><th>ﾈｯﾄ引当</th><th>入荷予定</th></tr>
      ${Object.keys(stock).map((p) => `<tr><td>${p}</td><td>${esc(productName(S!, p))}</td><td class="n">${stock[p]}</td>
        <td class="n">${sold[p] ?? 0}</td><td>${detail[p]?.expiry?.replaceAll("-", "/") ?? ""}</td><td class="n">${detail[p]?.reserved_online || ""}</td>
        <td class="n">${incoming[p] ?? ""}</td></tr>`).join("")}</table></div>`;
  } else if (view === "incoming") {
    const rows = Object.entries(incoming);
    const docs = Object.entries(S.systems.sap_orders).filter(([, o]) => o.store === STORE);
    const docOf = (p: string) => docs.find(([, o]) => p in o.lines);
    const stops = S.systems.tms.stops.filter((x) => x.store === STORE);
    main.innerHTML = rows.length ? `<div class="grid"><table><tr><th>商品CD</th><th>商品名</th><th>数</th><th>伝票</th><th>出荷元</th><th>納品</th></tr>
      ${rows.map(([p, q]) => {
        const d = docOf(p);
        const stop = stops.find((x) => d && x.purpose.startsWith(d[0]));
        return `<tr class="new"><td>${p}</td><td>${esc(productName(S!, p))}</td><td class="n">${q}</td><td>${d?.[0] ?? ""}</td>
          <td>${d ? storeName(d[1].dc) : ""}</td><td>${stop ? `${stop.time}（${stop.vehicle}）` : "06:30"}</td></tr>`;
      }).join("")}</table></div>`
      : `<div class="grid"><p class="empty">―</p></div>`;
  } else {
    const labels = S.systems.pos_labels.filter((l) => l.store === STORE);
    main.innerHTML = labels.length ? `<div class="grid"><table><tr><th>時刻</th><th>商品名</th><th>売価</th><th>値引</th><th>新売価</th></tr>
      ${labels.map((l) => `<tr class="new"><td>${l.time}</td><td>${esc(productName(S!, l.product))}</td><td class="n">${l.base}</td>
        <td class="n">${l.discount}%</td><td class="n">${l.price}</td></tr>`).join("")}</table></div>`
      : `<div class="grid"><p class="empty">―</p></div>`;
  }
}
