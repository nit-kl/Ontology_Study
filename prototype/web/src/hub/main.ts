// デモ司令塔。ワークフローを進めるボタン、各画面へのリンク、層ごとの出来事の流れ、
// レイヤー2〜4 の中身（明日の事情、予測と発注案、SHACL、ナレッジグラフ、確定イベント）を見る。
import "./hub.css";
import { act, hasContext, post, productName, storeName, switchScenario, watch, type LayerId, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";
import { SCREENS } from "../lib/screens";

const LAYERS: [LayerId, string, string][] = [
  ["L5", "業務画面とガバナンス", "店長アプリ・コントロールタワー・監査グラフ（PROV-O）・権限（ODRL）"],
  ["L4", "AI推論とキネティック実行", "AI エージェント・需要予測モデル・KINETIC"],
  ["L3", "ナレッジグラフ", "RDF ストア・OWL 推論・GeoSPARQL・SHACL"],
  ["L2", "セマンティックETL", "列と述語の対応表で三つ組に変換・CDC"],
  ["L1", "基幹システム", "SAP・POS・WMS・スタッフ端末・予報とイベント情報"],
];
type Tab = "context" | "plan" | "uc2plan" | "uc2monitor" | "uc3plan" | "shacl" | "kg" | "events";
const SCENARIO_TABS: Record<string, [Tab, string][]> = {
  uc1: [["context", "明日の事情（KG）"], ["plan", "予測と発注案"]],
  uc2: [["uc2plan", "見積もりと調整計画"], ["uc2monitor", "実行中の見張り"]],
  uc3: [["uc3plan", "見積もりと融通の案"]],
};
const COMMON_TABS: [Tab, string][] = [["shacl", "SHACL の点検"], ["kg", "ナレッジグラフ"], ["events", "確定イベントと Update"]];
const SAMPLE_QUERIES: Record<string, string> = {
  "明日の試合で売れ行きが伸びる商品（OWL のプロパティの連鎖）": `SELECT ?product ?label ?event WHERE {
  ?product ex:boostedByEvent ?event ; rdfs:label ?label .
  ?event ex:date "2026-10-24"^^xsd:date .
}`,
  "1号店からイベント会場までの距離（GeoSPARQL）": `SELECT ?event ?label ?km WHERE {
  ?event a ex:Event ; rdfs:label ?label ; geo:hasGeometry/geo:asWKT ?w .
  store:ST-014 geo:hasGeometry/geo:asWKT ?s .
  BIND (geof:distance(?s, ?w, uom:kilometre) AS ?km)
} ORDER BY ?km`,
  "卸側と小売側のコード（UnifiedSKU からの推論）": `SELECT ?retail ?wholesale WHERE {
  ?retail ex:sameProductCode ?wholesale .
  ?retail ex:caseSize ?c . ?wholesale ex:wholesale true .
}`,
  "区分の上の区分（SKOS の推移）": `SELECT ?product ?tree WHERE {
  ?product ex:inCategoryTree ?c . ?c skos:prefLabel ?tree .
  ?product ex:caseSize ?x .
} ORDER BY ?product`,
  "確定した発注計画（推論なし、Named Graph を指定）": `SELECT ?line ?q WHERE {
  GRAPH <urn:example:graph:plans> { ?line ex:quantity ?q }
}`,
};

let S: State;
let tab: Tab = (location.hash.slice(1) as Tab) || "context";
let seenLog = 0;
let playing = false;
const color = (l: string) => `var(--${l.toLowerCase()})`;
const json = (o: unknown) => esc(JSON.stringify(o, null, 2));

$("#screens").innerHTML = `<div class="screens">
  <h3>レイヤー1 基幹システム（レガシー）</h3>
  ${SCREENS.filter((s) => s.layer === "L1").map(screenLink).join("")}
  <h3>レイヤー5 業務アプリ（モダン）</h3>
  ${SCREENS.filter((s) => s.layer === "L5").map(screenLink).join("")}
</div>`;

function screenLink(s: (typeof SCREENS)[number]): string {
  return `<a class="screen" style="--c:${color(s.layer)}" href="${s.path}" target="${s.id}">
    <span class="uc">${esc(s.uc)}</span><b>${esc(s.title)}</b><span>${esc(s.who)} ・ ${esc(s.look)}</span></a>`;
}

async function run(p: ReturnType<typeof post>) {
  const r = await p;
  if (!r.ok) { playing = false; toast(r.message); return false; }
  S = r.state;
  render();
  return true;
}

/** 時刻を進める操作を、押せなくなるまで繰り返す（自動で進める）。 */
async function play(actionId: string) {
  playing = !playing;
  render();
  while (playing) {
    const a = S.actions.find((x) => x.id === actionId);
    if (!a?.enabled) break;
    if (!(await run(act(actionId)))) break;
    await new Promise((res) => setTimeout(res, 900));
  }
  playing = false;
  render();
}

watch((s) => { S = s; render(); });

function renderControls() {
  $("#subtitle").textContent = `${S.title} ・ ${S.day}`;
  $("#scenarios").innerHTML = S.scenarios.map((x) =>
    `<button data-s="${x.id}" class="${x.id === S.scenario ? "on" : ""}">${esc(x.title)}<small>${x.day}</small></button>`).join("");
  $$<HTMLButtonElement>("#scenarios button").forEach((b) => (b.onclick = async () => {
    playing = false;
    seenLog = 0;
    tab = SCENARIO_TABS[b.dataset.s!][0][0];
    location.hash = tab;
    await run(switchScenario(b.dataset.s as State["scenario"]));
  }));
  const firstEnabled = S.actions.find((a) => a.enabled)?.id;
  $("#steps").innerHTML = S.actions.map((a) => `<button data-a="${a.id}" class="${a.id === firstEnabled ? "primary" : ""}" ${a.enabled && !playing ? "" : "disabled"}>${esc(a.label)}</button>
      ${a.repeatable ? `<button class="play ${playing ? "on" : ""}" data-play="${a.id}" ${a.enabled || playing ? "" : "disabled"}>${playing ? "■ 止める" : "▶ 自動で進める"}</button>` : ""}`).join("") +
    `<button id="b-reset">リセット</button>`;
  $$<HTMLButtonElement>("#steps [data-a]").forEach((b) => (b.onclick = () => void run(act(b.dataset.a!))));
  $$<HTMLButtonElement>("#steps [data-play]").forEach((b) => (b.onclick = () => void play(b.dataset.play!)));
  $("#b-reset").onclick = () => { playing = false; seenLog = 0; void run(post("/api/reset")); };
}

function render() {
  renderControls();
  $("#clock").textContent = S.now;
  const st = $("#wfstate");
  st.textContent = "ワークフロー: " + S.workflow_state;
  st.className = "badge " + ({ 承認待ち: "wait", 完了: "ok", 失敗: "ng" } as Record<string, string>)[S.workflow_state];

  if (S.log.length < seenLog) seenLog = 0;
  const fresh = S.log.slice(seenLog);
  const active = new Set(fresh.map((e) => e.layer));
  $("#layers").innerHTML = LAYERS.map(([id, n, d]) =>
    `<div class="layer ${active.has(id) ? "active" : ""}" style="--c:${color(id)}"><b>${id} ${n}</b><span>${d}</span></div>`).join("");
  const tl = $("#timeline");
  tl.innerHTML = S.log.map((e) => `
    <div class="entry"><span class="t">${esc(e.time)}</span><span class="chip" style="--c:${color(e.layer)}">${e.layer}</span><b>${esc(e.actor)}</b>
    ${esc(e.title)}${e.detail != null ? `<pre>${json(e.detail)}</pre>` : ""}</div>`).join("");
  $$(".entry", tl).forEach((el) => (el.onclick = () => el.classList.toggle("open")));
  if (fresh.length) tl.scrollTop = tl.scrollHeight;
  seenLog = S.log.length;

  const tabs = [...SCENARIO_TABS[S.scenario], ...COMMON_TABS];
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  $("#tabs").innerHTML = tabs.map(([k, n]) => `<button class="tab ${k === tab ? "on" : ""}" data-k="${k}">${n}</button>`).join("");
  $$<HTMLButtonElement>(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.k as Tab; location.hash = tab; render(); }));
  const view = $("#view");
  ({ context: vContext, plan: vPlan, uc2plan: vUc2Plan, uc2monitor: vUc2Monitor, uc3plan: vUc3Plan,
     shacl: vShacl, kg: vKg, events: vEvents })[tab](view);
}

const notYet = (el: HTMLElement, msg = "① ワークフローを起動すると表示されます。") => (el.innerHTML = `<p class="empty">${msg}</p>`);

function badge(s: string) {
  const k = ({ 確定: "ok", 承認不要: "ok", 承認待ち: "wait", 却下: "ng" } as Record<string, string>)[s] ?? "";
  return `<span class="badge ${k}">${esc(s)}</span>`;
}

function vContext(el: HTMLElement) {
  const c = S.context;
  if (!hasContext(c)) return notYet(el);
  const pol = c.policy;
  el.innerHTML = `
    <p class="note">AI が SPARQL でナレッジグラフに聞いた「明日（${c.day}）は何がある日か」。近くのイベントは GeoSPARQL の距離で、
    関わる商品は OWL のプロパティの連鎖（商品 → 区分 → よく売れる事情 → イベント）で推論する。推論の結果はストアに足さない
    （推論で増えた三つ組 ${S.inferred_only} 個は、問い合わせのたびに作るコピーの中だけにある）。</p>
    <h2>明日のイベント（発注の方針: ${pol.r}km 以内、${pol.min.toLocaleString()}人以上）</h2>
    <div class="scroll"><table><tr><th>ID</th><th>イベント</th><th>種類</th><th class="n">来場見込み</th><th class="n">1号店から</th><th>判定</th></tr>
    ${c.events.map((e) => `<tr><td>${e.id}</td><td>${esc(e.label)}</td><td>${esc(e.type_label)}</td><td class="n">${e.attendance.toLocaleString()}</td>
      <td class="n">${e.km} km</td><td>${e.nearby ? '<span class="badge ok">近くの大きなイベント</span>'
      : `<span class="badge">対象外（${e.km > pol.r ? "遠い" : "小さい"}）</span>`}</td></tr>`).join("")}</table></div>
    <p>予報の最高気温: <b>${c.max_temp}℃</b>（暑い日の基準 ${pol.th}℃）</p>
    <h2>明日の事情に関わる商品（OWL 推論）</h2>
    <table><tr><th>商品</th><th>理由</th><th>似た商品</th></tr>
    ${Object.entries(c.products).filter(([, i]) => i.reasons.length).map(([p, i]) =>
      `<tr><td>${p} ${esc(i.name)}</td><td>${i.reasons.map(esc).join("<br>")}</td><td>${i.similar ? `${i.similar} ${esc(productName(S, i.similar))}` : "―"}</td></tr>`).join("")}
    </table>
    <p class="note">それ以外の商品（${Object.values(c.products).filter((i) => !i.reasons.length).map((i) => esc(i.name)).join("、")}）は、SAP の推奨数のまま発注する。</p>`;
}

function vPlan(el: HTMLElement) {
  if (!S.plan) return notYet(el);
  el.innerHTML = `
    <p class="note">数を出すのは需要予測モデル（履歴の蓄積先で学習）。ナレッジグラフは、どの商品に予測を使うかと、その特徴（イベント・予報・似た商品）を渡す。
    発注数は予測に近いケースの倍数。</p>
    <div class="scroll"><table><tr><th>商品</th><th class="n">推奨数</th><th class="n">予測（80%の幅）</th><th class="n">朝の在庫見込み</th>
      <th class="n">発注</th><th class="n">倍率</th><th>状態</th><th>経緯</th></tr>
    ${S.plan.lines.map((l) => `<tr><td>${l.product}<br>${esc(l.name)}</td><td class="n">${l.recommended ?? "なし"}</td>
      <td class="n">${l.forecast ? `${l.forecast.mean}<br><span class="history">${l.forecast.lower}〜${l.forecast.upper}</span>` : "―"}</td>
      <td class="n">${l.morning_stock}</td><td class="n"><b>${l.quantity}</b></td><td class="n">${l.ratio ?? "―"}</td>
      <td>${badge(l.status)}</td>
      <td class="history">${l.forecast ? esc(l.forecast.basis) + "<br>" : ""}${l.history.map(esc).join(" → ")}</td></tr>`).join("")}
    </table></div>`;
}

function vShacl(el: HTMLElement) {
  if (!S.validations.length) return notYet(el);
  el.innerHTML = `
    <p class="note">AI の案は、SHACL を通らないとストアに入らない。事前検証は何も書き換えず、確定のときは承認の点検も足して再検証する。
    承認が要るかどうかも、承認の点検（推奨数の1.5倍、ODRL の権限）が決める。</p>
    ${S.validations.map((v) => `<div class="row">${v.conforms ? '<span class="badge ok">合格</span>' : '<span class="badge ng">不合格</span>'}
      <b>${esc(v.label)}</b><span class="history">${esc(v.shapes)}</span></div>
      ${v.results.length ? `<table><tr><th>明細</th><th>点検</th><th>理由</th></tr>${v.results.map((r) =>
        `<tr><td>${esc(r.focus)}</td><td>${esc(r.check)}</td><td>${esc(r.message)}</td></tr>`).join("")}</table>` : ""}`).join("")}
    <div class="row"><button id="show-shapes">SHACL の定義を見る</button></div><pre id="shapes" hidden></pre>`;
  $("#show-shapes").onclick = async () => {
    const p = $("#shapes");
    p.textContent = await (await fetch("/api/shapes")).text();
    p.hidden = false;
  };
}

function vKg(el: HTMLElement) {
  el.innerHTML = `<h2>ストアの Named Graph</h2>
    <table><tr><th>Named Graph</th><th>中身</th><th class="n">三つ組</th></tr>${S.kg_stats.map((g) =>
      `<tr><td><code>${esc(g.graph)}</code></td><td>${esc(g.name)}</td><td class="n">${g.triples}</td></tr>`).join("")}
      <tr><td></td><td>推論で増える分（ストアには入れない）</td><td class="n">${S.inferred_only}</td></tr></table>
    <h2 class="mt">SPARQL で問い合わせる</h2>
    <div class="row"><select id="sample">${Object.keys(SAMPLE_QUERIES).map((k) => `<option>${esc(k)}</option>`).join("")}</select>
      <label><input type="checkbox" id="inf" checked> OWL 推論あり</label><button class="primary" id="run">実行</button></div>
    <textarea id="q"></textarea><div id="qres"></div>
    <p class="note">接頭辞 ex:, sku:, store:, cat:, event:, geo:, geof:, uom:, skos:, rdfs:, xsd: は宣言済み。</p>
    <h2 class="mt">Named Graph の中身（Turtle）</h2>
    <div class="row"><select id="gsel">${["plans", "state", "master", "policy", "ontology", "cdc"].map((g) => `<option>${g}</option>`).join("")}</select>
      <button id="gshow">表示</button></div><pre id="gout" hidden></pre>`;
  const sample = $<HTMLSelectElement>("#sample");
  const setQ = () => {
    $<HTMLTextAreaElement>("#q").value = SAMPLE_QUERIES[sample.value];
    $<HTMLInputElement>("#inf").checked = !sample.value.includes("推論なし");
  };
  sample.onchange = setQ;
  setQ();
  $("#run").onclick = async () => {
    const r = await fetch("/api/sparql", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: $<HTMLTextAreaElement>("#q").value, inferred: $<HTMLInputElement>("#inf").checked }) });
    const body = await r.json();
    if (!r.ok) return void ($("#qres").innerHTML = `<pre>${esc(body.detail)}</pre>`);
    const rows: Record<string, string>[] = body.rows;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    $("#qres").innerHTML = rows.length ? `<div class="scroll"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows.map((row) =>
      `<tr>${cols.map((c) => `<td>${esc(row[c].replace(/^urn:example:/, ""))}</td>`).join("")}</tr>`).join("")}</table></div>`
      : '<p class="empty">結果なし</p>';
  };
  $("#gshow").onclick = async () => {
    const p = $("#gout");
    p.textContent = await (await fetch("/api/graph/" + $<HTMLSelectElement>("#gsel").value)).text();
    p.hidden = false;
  };
}

function vEvents(el: HTMLElement) {
  if (!S.cloud_events.length) return notYet(el);
  el.innerHTML = `<p class="note">SHACL に合格して SPARQL Update が成功するたびに、KINETIC へ確定イベント（CloudEvents）が出る。
    KINETIC はこれを受けてレイヤー1 へ書き戻す。</p>
    <h2>最後に実行した SPARQL Update</h2><pre>${esc(S.last_update)}</pre>
    <h2 class="mt">確定イベント（CloudEvents）</h2><pre>${json(S.cloud_events)}</pre>`;
}

function hm(h: number): string {
  return `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
}

const KIND_NAMES: Record<string, string> = { DefrostShift: "1. 霜取りの時刻をずらす", Precool: "2. 冷凍ケースの予冷と出力",
  Setpoint: "3. 空調の設定温度", Dimming: "4. 照明の調光" };

function vUc2Plan(el: HTMLElement) {
  const u = S.uc2!;
  const c = u.context;
  if (!c.projected_kw) return notYet(el);
  el.innerHTML = `
    <p class="note">AI がナレッジグラフから「ピークに動かせる設備」（OWL: 動かせる幅を持つ設備）と、その電力・動かせる幅を読み、
    何もしないときの 14:00〜15:00 のデマンドを見積もる。電力ピークの方針の順（霜取り → 冷凍ケース → 空調 → 照明）に調整を足し、
    契約電力 ${c.contract_kw}kW から余裕 ${c.margin_kw}kW を引いた値を下回ったら止める。</p>
    <table><tr><th>見積もり</th><th class="n">kW</th></tr>
      <tr><td>その他の店の負荷（直近 ${c.latest_kw}kW から設備の分を引き、予報 ${c.max_temp}℃ の分を足す）</td><td class="n">${c.other_kw}</td></tr>
      <tr><td>霜取りがピークに重なる冷蔵ケース（${c.defrost_in_peak!.length}台）</td><td class="n">${c.defrost_in_peak!.length * 4}</td></tr>
      <tr><td><b>何もしないときの 14:00〜15:00</b></td><td class="n"><b>${c.projected_kw}</b></td></tr></table>
    <h2 class="mt">方針の順に足した調整</h2>
    <table><tr><th>調整</th><th class="n">削れる分</th><th class="n">足したあと</th></tr>
      ${c.steps!.map((s) => `<tr><td>${esc(KIND_NAMES[s.kind] ?? s.kind)}</td><td class="n">−${s.saving}</td><td class="n">${s.after}</td></tr>`).join("")}</table>
    <h2 class="mt">調整計画（BMS へ書き戻す時刻つきの設定）</h2>
    <table><tr><th>設定</th><th>状態</th></tr>${u.settings.map((s) => `<tr><td>${esc(s.label)}</td><td>${badge(s.status)}</td></tr>`).join("")}</table>`;
}

function vUc2Monitor(el: HTMLElement) {
  const u = S.uc2!;
  if (!u.monitor.length) return notYet(el, "14:00 になると、KINETIC が5分ごとに SHACL で見張りを頼みます。② で時刻を進めてください。");
  el.innerHTML = `<p class="note">BMS の計測値はレイヤー2 がストリームで受け、ストアの各センサーの最新の観測を差し替える。
    KINETIC は 14:00〜15:00 のあいだ5分ごとに、その最新の観測を SHACL の見張りの規則で点検させる。違反したら、どの空調機が
    その区画を受け持つか（OWL: センサー → 区画 → 空調機）を見て、その設備だけを戻す。</p>
    <table><tr><th>時刻</th><th>結果</th><th>違反</th></tr>${u.monitor.map((m) => `<tr><td>${m.time}</td>
      <td>${m.conforms ? '<span class="badge ok">違反なし</span>' : '<span class="badge ng">違反</span>'}</td>
      <td>${m.results.map((r) => `${esc(r.focus)}: ${esc(r.message)}`).join("<br>")}</td></tr>`).join("")}</table>`;
}

function vUc3Plan(el: HTMLElement) {
  const u = S.uc3!;
  const c = u.context;
  if (!c.estimates) return notYet(el);
  el.innerHTML = `
    <p class="note">AI がナレッジグラフに近くの店（GeoSPARQL、${c.policy!.near}km 以内）、期限の短い商品（SKOS の区分「日配品」「惣菜」を OWL でたどる）、
    今夜の帰り便のルートを聞き、3店の POS に在庫と今日の販売数を聞いて、閉店までに余る数と足りない数を見積もる。</p>
    <h2>閉店までの見積もり</h2>
    <div class="scroll"><table><tr><th>店</th><th>商品</th><th class="n">在庫</th><th class="n">今日の販売</th><th class="n">閉店までに売れる</th><th class="n">余る・足りない</th><th>期限</th></tr>
    ${c.estimates.map((e) => `<tr><td>${storeName(e.store)}</td><td>${esc(e.name)}</td><td class="n">${e.stock}</td><td class="n">${e.sold_today}</td>
      <td class="n">${e.rest}</td><td class="n"><b>${e.balance > 0 ? "+" : ""}${e.balance}</b></td><td>${e.expiry}</td></tr>`).join("")}</table></div>
    <h2 class="mt">帰り便が立ち寄れる店（GeoSPARQL: ルートから ${c.policy!.radius}km 以内）</h2>
    <table><tr><th>車</th><th>所属</th><th>立ち寄れる店</th><th class="n">ルートから</th><th>着</th></tr>
    ${c.routes!.map((r) => `<tr><td>${r.vehicle}</td><td>${storeName(r.home)}</td><td>${storeName(r.store)}</td><td class="n">${r.km}km</td><td>${r.eta}</td></tr>`).join("")}</table>
    <h2 class="mt">融通と見切りの案</h2>
    <table><tr><th>ID</th><th>内容</th><th class="n">金額</th><th>状態</th><th>経緯</th></tr>
    ${u.transfers.map((t) => `<tr><td>${t.id}</td><td>${esc(t.name)} ${t.quantity}: ${storeName(t.source)} → ${storeName(t.dest)}（${t.vehicle} ${t.eta}）</td>
      <td class="n">${t.amount.toLocaleString()}円</td><td>${badge(t.status)}</td><td class="history">${t.history.map(esc).join("<br>")}</td></tr>`).join("")}
    ${u.markdowns.map((m) => `<tr><td>${m.id}</td><td>${storeName(m.store)}の${esc(m.name)}（余り ${m.surplus}）: ${m.steps.map(([h, d]) =>
      `${hm(h)} から${d}%引き`).join("、")}</td><td></td><td>${badge(m.status)}</td>
      <td class="history">${m.applied.length ? `適用済み ${m.applied.join("、")}` : ""}</td></tr>`).join("")}</table>`;
}
