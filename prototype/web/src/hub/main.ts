// デモ司令塔。シナリオの切り替え、ワークフローの操作、各画面へのリンク、出来事の流れ、レイヤー3〜4 の中身を見る。
import "./hub.css";
import { act, hasContext, post, productName, storeName, switchScenario, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";
import { SCREENS } from "../lib/screens";

type Tab = "context" | "plan" | "uc2plan" | "uc2monitor" | "uc3plan" | "shacl" | "sparql";
const SCENARIO_TABS: Record<string, [Tab, string][]> = {
  uc1: [["context", "明日の事情"], ["plan", "発注案"]],
  uc2: [["uc2plan", "調整計画"], ["uc2monitor", "見張り"]],
  uc3: [["uc3plan", "融通の案"]],
};
const COMMON_TABS: [Tab, string][] = [["shacl", "SHACL"], ["sparql", "SPARQL"]];
const SAMPLE_QUERIES: Record<string, string> = {
  "明日の試合で売れる商品（プロパティの連鎖）": `SELECT ?product ?label ?event WHERE {
  ?product ex:boostedByEvent ?event ; rdfs:label ?label .
  ?event ex:date "2026-10-24"^^xsd:date .
}`,
  "1号店からイベント会場までの距離（GeoSPARQL）": `SELECT ?event ?label ?km WHERE {
  ?event a ex:Event ; rdfs:label ?label ; geo:hasGeometry/geo:asWKT ?w .
  store:ST-014 geo:hasGeometry/geo:asWKT ?s .
  BIND (geof:distance(?s, ?w, uom:kilometre) AS ?km)
} ORDER BY ?km`,
  "卸側と小売側のコード（推論）": `SELECT ?retail ?wholesale WHERE {
  ?retail ex:sameProductCode ?wholesale .
  ?retail ex:caseSize ?c . ?wholesale ex:wholesale true .
}`,
  "区分の上の区分（SKOS の推移）": `SELECT ?product ?tree WHERE {
  ?product ex:inCategoryTree ?c . ?c skos:prefLabel ?tree .
  ?product ex:caseSize ?x .
} ORDER BY ?product`,
  "確定した発注計画（推論なし）": `SELECT ?line ?q WHERE {
  GRAPH <urn:example:graph:plans> { ?line ex:quantity ?q }
}`,
};

let S: State;
let tab: Tab = (location.hash.slice(1) as Tab) || "context";
let seenLog = 0;
let playing = false;
const color = (l: string) => `var(--${l.toLowerCase()})`;
const json = (o: unknown) => esc(JSON.stringify(o, null, 2));

$("#screens").innerHTML = `<div class="screens">${SCREENS.map((s) =>
  `<a class="screen" style="--c:${color(s.layer)}" href="${s.path}" target="${s.id}">${esc(s.title)}</a>`).join("")}</div>`;

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
      ${a.repeatable ? `<button class="play ${playing ? "on" : ""}" data-play="${a.id}" ${a.enabled || playing ? "" : "disabled"}>${playing ? "■" : "▶"}</button>` : ""}`).join("") +
    `<button id="b-reset">リセット</button>`;
  $$<HTMLButtonElement>("#steps [data-a]").forEach((b) => (b.onclick = () => void run(act(b.dataset.a!))));
  $$<HTMLButtonElement>("#steps [data-play]").forEach((b) => (b.onclick = () => void play(b.dataset.play!)));
  $("#b-reset").onclick = () => { playing = false; seenLog = 0; void run(post("/api/reset")); };
}

function render() {
  renderControls();
  $("#clock").textContent = S.now;
  const st = $("#wfstate");
  st.textContent = S.workflow_state;
  st.className = "badge " + ({ 承認待ち: "wait", 完了: "ok", 失敗: "ng" } as Record<string, string>)[S.workflow_state];

  if (S.log.length < seenLog) seenLog = 0;
  const fresh = S.log.slice(seenLog);
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
     shacl: vShacl, sparql: vSparql })[tab](view);
}

const notYet = (el: HTMLElement) => (el.innerHTML = `<p class="empty">―</p>`);

function badge(s: string) {
  const k = ({ 確定: "ok", 承認不要: "ok", 承認待ち: "wait", 却下: "ng" } as Record<string, string>)[s] ?? "";
  return `<span class="badge ${k}">${esc(s)}</span>`;
}

function vContext(el: HTMLElement) {
  const c = S.context;
  if (!hasContext(c)) return notYet(el);
  el.innerHTML = `
    <div class="scroll"><table><tr><th>イベント</th><th class="n">来場</th><th class="n">1号店から</th><th></th></tr>
    ${c.events.map((e) => `<tr><td>${esc(e.label)}</td><td class="n">${e.attendance.toLocaleString()}</td>
      <td class="n">${e.km} km</td><td>${e.nearby ? '<span class="badge ok">対象</span>' : '<span class="badge">対象外</span>'}</td></tr>`).join("")}</table></div>
    <p>最高気温 <b>${c.max_temp}℃</b></p>
    <table><tr><th>商品</th><th>理由</th><th>似た商品</th></tr>
    ${Object.entries(c.products).filter(([, i]) => i.reasons.length).map(([, i]) =>
      `<tr><td>${esc(i.name)}</td><td>${i.reasons.map(esc).join("<br>")}</td><td>${i.similar ? esc(productName(S, i.similar)) : ""}</td></tr>`).join("")}
    </table>`;
}

function vPlan(el: HTMLElement) {
  if (!S.plan) return notYet(el);
  el.innerHTML = `
    <div class="scroll"><table><tr><th>商品</th><th class="n">推奨</th><th class="n">予測</th><th class="n">発注</th><th>状態</th><th>経緯</th></tr>
    ${S.plan.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${l.recommended ?? ""}</td>
      <td class="n">${l.forecast ? `${l.forecast.mean}<br><span class="history">${l.forecast.lower}〜${l.forecast.upper}</span>` : ""}</td>
      <td class="n"><b>${l.quantity}</b></td><td>${badge(l.status)}</td>
      <td class="history">${l.history.map(esc).join(" → ")}</td></tr>`).join("")}
    </table></div>`;
}

function vShacl(el: HTMLElement) {
  if (!S.validations.length) return notYet(el);
  el.innerHTML = S.validations.map((v) => `<div class="row">${v.conforms ? '<span class="badge ok">合格</span>' : '<span class="badge ng">不合格</span>'}
      <b>${esc(v.label)}</b></div>
      ${v.results.length ? `<table>${v.results.map((r) =>
        `<tr><td>${esc(r.focus)}</td><td>${esc(r.check)}</td><td>${esc(r.message)}</td></tr>`).join("")}</table>` : ""}`).join("");
}

function vSparql(el: HTMLElement) {
  el.innerHTML = `
    <div class="row"><select id="sample">${Object.keys(SAMPLE_QUERIES).map((k) => `<option>${esc(k)}</option>`).join("")}</select>
      <label><input type="checkbox" id="inf" checked> 推論</label><button class="primary" id="run">実行</button></div>
    <textarea id="q"></textarea><div id="qres"></div>`;
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
      : '<p class="empty">0 件</p>';
  };
}

function hm(h: number): string {
  return `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
}

const KIND_NAMES: Record<string, string> = { DefrostShift: "霜取りをずらす", Precool: "冷凍ケースの予冷",
  Setpoint: "空調の設定温度", Dimming: "照明の調光" };

function vUc2Plan(el: HTMLElement) {
  const u = S.uc2!;
  const c = u.context;
  if (!c.projected_kw) return notYet(el);
  el.innerHTML = `
    <table><tr><th>調整</th><th class="n">kW</th></tr>
      <tr><td>何もしないとき</td><td class="n">${c.projected_kw}</td></tr>
      ${c.steps!.map((s) => `<tr><td>${esc(KIND_NAMES[s.kind] ?? s.kind)}（−${s.saving}）</td><td class="n">${s.after}</td></tr>`).join("")}</table>
    <table class="mt"><tr><th>設定</th><th>状態</th></tr>${u.settings.map((s) => `<tr><td>${esc(s.label)}</td><td>${badge(s.status)}</td></tr>`).join("")}</table>`;
}

function vUc2Monitor(el: HTMLElement) {
  const u = S.uc2!;
  if (!u.monitor.length) return notYet(el);
  el.innerHTML = `<table><tr><th>時刻</th><th>結果</th><th>違反</th></tr>${u.monitor.map((m) => `<tr><td>${m.time}</td>
      <td>${m.conforms ? '<span class="badge ok">OK</span>' : '<span class="badge ng">違反</span>'}</td>
      <td>${m.results.map((r) => `${esc(r.focus)}: ${esc(r.message)}`).join("<br>")}</td></tr>`).join("")}</table>`;
}

function vUc3Plan(el: HTMLElement) {
  const u = S.uc3!;
  const c = u.context;
  if (!c.estimates) return notYet(el);
  el.innerHTML = `
    <div class="scroll"><table><tr><th>店</th><th>商品</th><th class="n">在庫</th><th class="n">閉店まで</th><th class="n">過不足</th><th>期限</th></tr>
    ${c.estimates.map((e) => `<tr><td>${storeName(e.store)}</td><td>${esc(e.name)}</td><td class="n">${e.stock}</td>
      <td class="n">${e.rest}</td><td class="n"><b>${e.balance > 0 ? "+" : ""}${e.balance}</b></td><td>${e.expiry}</td></tr>`).join("")}</table></div>
    <table class="mt"><tr><th>案</th><th>状態</th><th>経緯</th></tr>
    ${u.transfers.map((t) => `<tr><td>${esc(t.name)} ${t.quantity}: ${storeName(t.source)} → ${storeName(t.dest)}（${t.vehicle} ${t.eta}）</td>
      <td>${badge(t.status)}</td><td class="history">${t.history.map(esc).join("<br>")}</td></tr>`).join("")}
    ${u.markdowns.map((m) => `<tr><td>${storeName(m.store)} ${esc(m.name)}: ${m.steps.map(([h, d]) =>
      `${hm(h)} ${d}%引き`).join("、")}</td><td>${badge(m.status)}</td>
      <td class="history">${m.applied.join("、")}</td></tr>`).join("")}</table>`;
}
