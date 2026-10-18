// レイヤー1 SAP S/4HANA（SAP GUI 風）。品目マスタ、自動補充の推奨数、補充発注（在庫転送オーダ）、アプリケーションログ。
// 原本を持って見せるだけで、判断はしない。補充発注は KINETIC からの BAPI で作られる。
import "./sap.css";
import { productName, storeName, watch, type State } from "../lib/api";
import { $, $$, esc, num, toast } from "../lib/dom";

type Tx = "SMEN" | "MM03" | "WRP1" | "ME23N" | "SLG1";
const TX: Record<Tx, string> = {
  SMEN: "SAP Easy Access",
  MM03: "品目の照会: 一覧",
  WRP1: "補充: 推奨数の照会（自動補充）",
  ME23N: "在庫転送オーダの照会",
  SLG1: "アプリケーションログ: ログの表示",
};
const UNIT: Record<string, string> = { "R-3310": "BT", "R-3901": "BG", "R-5581": "BT" };

let S: State | null = null;
let doc = "";
let tx: Tx = (location.hash.slice(1).toUpperCase() as Tx) in TX ? (location.hash.slice(1).toUpperCase() as Tx) : "SMEN";
const okcode = $<HTMLInputElement>("#okcode");

okcode.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const code = okcode.value.trim().toUpperCase().replace(/^\/N/, "") as Tx;
  okcode.value = "";
  if (code in TX) go(code);
  else status(`トランザクション ${code || "(空白)"} は存在しません`, true);
});
$("#back").onclick = () => go("SMEN");
document.addEventListener("keydown", (e) => { if (e.key === "F3") { e.preventDefault(); go("SMEN"); } });

function go(t: Tx) {
  tx = t;
  render();
}

function status(msg: string, warn = false) {
  const el = $("#status");
  el.textContent = msg;
  el.className = "msg" + (warn ? " warn" : "");
}

watch((s) => {
  const loaded = S !== null;
  const before = JSON.stringify(S?.systems.sap_orders ?? {});
  S = s;
  const after = JSON.stringify(s.systems.sap_orders);
  if (loaded && after !== before && after !== "{}") toast("在庫転送オーダが更新されました（BAPI）");
  const docs = Object.keys(s.systems.sap_orders);
  if (!docs.includes(doc)) doc = docs[0] ?? "";
  render();
});

function render() {
  if (!S) return;
  document.title = TX[tx];
  $("#wintitle").textContent = TX[tx];
  $("#screentitle").textContent = TX[tx];
  const body = $("#body");
  const tools = $("#apptoolbar");
  tools.innerHTML = "";
  if (tx === "SMEN") {
    tools.innerHTML = `<button>その他のメニュー</button><button>お気に入りに追加</button>`;
    body.innerHTML = `<div class="tree"><ul>
      <li class="folder">お気に入り</li>
      <li class="folder">SAP メニュー<ul>
        <li class="folder">ロジスティクス<ul>
          <li class="folder">マテリアル管理<ul>
            <li class="folder">品目マスタ<ul><li class="tx" data-tx="MM03"><code>MM03</code>照会</li></ul></li>
            <li class="folder">購買<ul><li class="tx" data-tx="ME23N"><code>ME23N</code>購買伝票の照会</li></ul></li>
          </ul></li>
          <li class="folder">小売<ul><li class="folder">補充<ul><li class="tx" data-tx="WRP1"><code>WRP1</code>補充: 推奨数</li></ul></li></ul></li>
        </ul></li>
        <li class="folder">ツール<ul><li class="folder">管理<ul><li class="tx" data-tx="SLG1"><code>SLG1</code>アプリケーションログ</li></ul></li></ul></li>
      </ul></li></ul></div>`;
    $$<HTMLElement>(".tx", body).forEach((li) => (li.ondblclick = li.onclick = () => go(li.dataset.tx as Tx)));
    status("トランザクションコードを入力するか、メニューから選んでください（MM03 / WRP1 / ME23N / SLG1）");
  } else if (tx === "MM03") {
    body.innerHTML = `<table class="alv"><tr><th>品目</th><th>品目テキスト</th><th>品目グループ</th><th>温度条件</th>
      <th>販売価格</th><th>発注単位</th><th>最小残存期間(日)</th><th>EAN/UPC</th><th>卸側品目</th><th>販売開始日</th></tr>
      ${S.master.products.map((p) => `<tr><td>${p.retail_code}</td><td>${esc(p.name)}</td><td>${p.category.toUpperCase()}</td>
      <td>${p.temp_zone.toUpperCase()}</td><td class="n">${num(+p.price)} JPY</td><td class="n">${p.case_size}</td>
      <td class="n">${p.shelf_life_days}</td><td>${p.gtin}</td><td>${p.wholesale_code}</td><td>${p.launch_date ? p.launch_date.replaceAll("-", "/") : ""}</td></tr>`).join("")}
      </table>`;
    status(`${S.master.products.length} 品目が選択されました`);
  } else if (tx === "WRP1") {
    const ordered = S.systems.sap_orders["STO-0141"]?.lines ?? {};
    body.innerHTML = `<fieldset><legend>選択条件</legend><div class="form">
      <label>プラント</label><div class="val">ST-014 1号店</div><label>計画日付</label><div class="val">2026/10/24</div>
      <label>補充方法</label><div class="val">過去4週の同じ曜日の平均</div><label>実行</label><div class="val">2026/10/23 09:00 バッチ</div></div></fieldset>
      <table class="alv"><tr><th>プラント</th><th>品目</th><th>品目テキスト</th><th>日付</th><th>推奨数量</th><th>オーダ数量</th><th>差異</th></tr>
      ${S.master.replenishment.map((r) => {
        const q = ordered[r.product];
        return `<tr><td>${r.store}</td><td>${r.product}</td><td>${esc(productName(S!, r.product))}</td><td>${r.date.replaceAll("-", "/")}</td>
          <td class="n">${r.recommended}</td><td class="n">${q ?? ""}</td><td class="n">${q != null ? q - +r.recommended : ""}</td></tr>`;
      }).join("")}</table>`;
    status("推奨数は自動補充（WRP1）の結果です。イベントや天気は考慮していません");
  } else if (tx === "ME23N") {
    const o = S.systems.sap_orders[doc];
    const docs = Object.keys(S.systems.sap_orders);
    tools.innerHTML = `<button>照会 ↔ 変更</button><button>印刷プレビュー</button><button>伝票の履歴</button>
      <span style="margin-left:12px">購買伝票 <select id="docsel">${docs.map((d) => `<option ${d === doc ? "selected" : ""}>${d}</option>`).join("")}</select></span>`;
    document.getElementById("docsel")?.addEventListener("change", (e) => { doc = (e.target as HTMLSelectElement).value; render(); });
    if (!o) {
      body.innerHTML = `<p class="empty">在庫転送オーダはまだありません。</p>`;
      status("在庫転送オーダは存在しません", true);
      return;
    }
    const lastSap = [...S.log].reverse().find((e) => e.actor.startsWith("SAP"));
    const changed = new Set(Object.keys((lastSap?.detail as Record<string, number>) ?? {}));
    body.innerHTML = `<fieldset><legend>ヘッダ</legend><div class="form">
      <label>伝票タイプ</label><div class="val">UB 在庫転送オーダ（${o.kind ?? "補充"}）</div><label>購買伝票</label><div class="val">${doc}</div>
      <label>供給プラント</label><div class="val">${o.dc} ${storeName(o.dc)}</div><label>受入プラント</label><div class="val">${o.store} ${storeName(o.store)}</div>
      <label>納入日付</label><div class="val">${o.date.replaceAll("-", "/")}</div><label>作成者</label><div class="val">RFC_KINETIC</div></div></fieldset>
      <table class="alv"><tr><th>明細</th><th>品目</th><th>品目テキスト</th><th>発注数量</th><th>単位</th><th>納入日付</th><th>プラント</th></tr>
      ${Object.entries(o.lines).map(([p, q], i) => `<tr class="${changed.has(p) ? "changed" : ""}"><td class="n">${(i + 1) * 10}</td><td>${p}</td>
        <td>${esc(productName(S!, p))}</td><td class="n">${q}</td><td>${UNIT[p] ?? "PC"}</td><td>${o.date.replaceAll("-", "/")}</td><td>${o.store}</td></tr>`).join("")}
      </table>`;
    status(lastSap ? `${lastSap.time} 在庫転送オーダ ${doc} が変更されました（BAPI_PO_CHANGE）` : "伝票を表示しています");
  } else if (tx === "SLG1") {
    const rows = S.log.filter((e) => e.actor.startsWith("SAP") || (e.layer === "L2" && e.title.includes("SAP")));
    body.innerHTML = `<fieldset><legend>オブジェクト</legend><div class="form">
      <label>オブジェクト</label><div class="val">MM_PUR</div><label>外部 ID</label><div class="val">${Object.keys(S.systems.sap_orders).join(", ") || "-"}</div></div></fieldset>
      ${rows.length ? `<table class="alv"><tr><th>時刻</th><th>ユーザ</th><th>メッセージテキスト</th></tr>
      ${rows.map((e) => `<tr><td>${esc(e.time)}</td><td>${e.layer === "L2" ? "CDC_REPL" : "RFC_KINETIC"}</td><td>${esc(e.title)}</td></tr>`).join("")}</table>`
      : `<p class="empty">ログはありません。</p>`}`;
    status(`${rows.length} 件のメッセージ`);
  }
}
