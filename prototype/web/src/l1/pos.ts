// レイヤー1 店舗システム（POS と棚割、Windows 98 の業務アプリ風）。
// 店頭在庫と今日の販売数の原本。KINETIC から入荷予定を受け、レイヤー4 の AI から在庫 API で照会される。
import "./pos.css";
import { productName, storeName, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type View = "stock" | "incoming" | "labels" | "planogram" | "apilog";
const VIEWS: [View, string][] = [["stock", "在庫照会"], ["incoming", "入荷予定照会"], ["labels", "売価変更・棚札"],
  ["planogram", "棚割マスタ"], ["apilog", "外部照会ログ"]];
const STORES = ["ST-014", "ST-031", "ST-040"];
let STORE = new URLSearchParams(location.search).get("store") ?? "ST-014";

let S: State | null = null;
let view: View = VIEWS.some(([k]) => k === location.hash.slice(1)) ? (location.hash.slice(1) as View) : "stock";
let lastIncoming = "";

$("#toolbar").innerHTML = VIEWS.map(([k, n]) => `<button class="btn" data-v="${k}">${n}</button>`).join("") +
  `<button class="btn" disabled>帳票出力</button><button class="btn" disabled>終了(F12)</button>`;
$("#side").innerHTML = VIEWS.map(([k, n]) => `<div data-v="${k}">${n}</div>`).join("");
$$<HTMLElement>("[data-v]").forEach((el) => (el.onclick = () => { view = el.dataset.v as View; render(); }));

const clock = () => ($("#tray").textContent = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }));
clock();
setInterval(clock, 30_000);

function storeSelect(): string {
  return `<label class="field">店舗 <select id="store">${STORES.map((s) => `<option value="${s}" ${s === STORE ? "selected" : ""}>${s} ${storeName(s)}</option>`).join("")}</select></label>`;
}

function bindStore() {
  document.getElementById("store")?.addEventListener("change", (e) => {
    STORE = (e.target as HTMLSelectElement).value;
    lastIncoming = JSON.stringify(S?.systems.pos_incoming[STORE] ?? {});
    render();
  });
}

watch((s) => {
  const inc = JSON.stringify(s.systems.pos_incoming[STORE] ?? {});
  if (S && inc !== lastIncoming && inc !== "{}") toast("入荷予定データを受信しました（本部連携）");
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
  $("#store-title").textContent = `${storeName(STORE)} ${STORE}`;
  const day = S.now.startsWith("翌") ? S.master.weather.find((w) => w.date > S!.day)?.date ?? S.day : S.day;
  $("#st2").textContent = `業務日付 ${day.replaceAll("-", "/")}  ${S.now.replace("翌 ", "")}`;

  if (view === "stock") {
    main.innerHTML = `<div class="group"><span class="cap">検索条件</span><div class="fields">
        ${storeSelect()}
        <label class="field">部門 <input value="全部門" readonly></label></div></div>
      <div class="grid"><table><tr><th>JAN/商品CD</th><th>商品名</th><th>店頭在庫</th><th>本日販売</th><th>賞味期限</th><th>ﾈｯﾄ引当</th><th>入荷予定</th></tr>
      ${Object.keys(stock).map((p) => `<tr><td>${p}</td><td>${esc(productName(S!, p))}</td><td class="n">${stock[p]}</td>
        <td class="n">${sold[p] ?? 0}</td><td>${detail[p]?.expiry?.replaceAll("-", "/") ?? ""}</td><td class="n">${detail[p]?.reserved_online || ""}</td>
        <td class="n">${incoming[p] ?? ""}</td></tr>`).join("")}</table></div>`;
    $("#st1").textContent = `${Object.keys(stock).length} 件表示`;
  } else if (view === "incoming") {
    const rows = Object.entries(incoming);
    const docs = Object.entries(S.systems.sap_orders).filter(([, o]) => o.store === STORE);
    const docOf = (p: string) => docs.find(([, o]) => p in o.lines);
    const stops = S.systems.tms.stops.filter((x) => x.store === STORE);
    main.innerHTML = `<div class="group"><span class="cap">入荷予定（本部連携で受信）</span><div class="fields">${storeSelect()}</div></div>
      ${rows.length ? `<div class="grid"><table><tr><th>商品CD</th><th>商品名</th><th>予定数</th><th>伝票</th><th>出荷元</th><th>納品時刻</th></tr>
      ${rows.map(([p, q]) => {
        const d = docOf(p);
        const stop = stops.find((x) => d && x.purpose.startsWith(d[0]));
        return `<tr class="new"><td>${p}</td><td>${esc(productName(S!, p))}</td><td class="n">${q}</td><td>${d?.[0] ?? ""}</td>
          <td>${d ? storeName(d[1].dc) : ""}</td><td>${stop ? `${stop.time}（${stop.vehicle}）` : "06:30"}</td></tr>`;
      }).join("")}</table></div>`
      : `<div class="grid"><p class="empty">${S.workflow_state === "完了" ? "入荷予定はすべて検品済みです。" : "該当するデータがありません。"}</p></div>`}`;
    $("#st1").textContent = `${rows.length} 件`;
  } else if (view === "labels") {
    const labels = S.systems.pos_labels.filter((l) => l.store === STORE);
    main.innerHTML = `<div class="group"><span class="cap">売価変更（電子棚札へ送信）</span><div class="fields">${storeSelect()}</div></div>
      <div class="grid"><table><tr><th>送信時刻</th><th>商品CD</th><th>商品名</th><th>通常売価</th><th>値引</th><th>新売価</th><th>理由</th></tr>
      ${labels.map((l) => `<tr class="new"><td>${l.time}</td><td>${l.product}</td><td>${esc(productName(S!, l.product))}</td><td class="n">${l.base}</td>
        <td class="n">${l.discount}%</td><td class="n">${l.price}</td><td>${esc(l.reason)}</td></tr>`).join("") ||
        `<tr><td colspan="7">売価変更はありません</td></tr>`}</table></div>`;
    $("#st1").textContent = `${labels.length} 件`;
  } else if (view === "planogram") {
    main.innerHTML = `<div class="grid"><table><tr><th>店舗</th><th>商品CD</th><th>商品名</th><th>什器</th><th>最大陳列数</th></tr>
      ${S.master.planogram.map((r) => `<tr><td>${r.store}</td><td>${r.product}</td><td>${esc(productName(S!, r.product))}</td>
        <td>${r.equipment}</td><td class="n">${r.capacity}</td></tr>`).join("")}</table></div>`;
    $("#st1").textContent = `${S.master.planogram.length} 件`;
  } else {
    const rows = S.log.filter((e) => e.title.includes("POS") || e.actor.includes("POS"));
    main.innerHTML = `<div class="group"><span class="cap">外部システムからの照会・連携</span>
      <div class="fields"><span>在庫API（MCP 経由の照会）と、本部からの入荷予定の連携の記録です。</span></div></div>
      <div class="grid"><table><tr><th>時刻</th><th>相手</th><th>内容</th></tr>
      ${rows.map((e) => `<tr><td>${esc(e.time)}</td><td>${e.layer === "L4" ? "本部 AI（在庫API）" : "本部連携"}</td><td>${esc(e.title)}</td></tr>`).join("") ||
        `<tr><td colspan="3">記録はありません</td></tr>`}</table></div>`;
    $("#st1").textContent = `${rows.length} 件`;
  }
  bindStore();
}
