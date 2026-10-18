// レイヤー5 コントロールタワー。供給網の担当が、指標・ワークフローの進み具合・地図・グラフ・各層の動きを見る。
// 数字はレイヤー4 が取ってきたグラフの事実と、確定した計画、レイヤー1 の計測値。ここでは計算し直さない。
// UC1 は補充（発注と予測）、UC2 は電力（デマンドと温度）、UC3 は在庫融通（ルートと余り・不足）を出す。
import "./modern.css";
import "./tower.css";
import { hasContext, storeName, watch, type State } from "../lib/api";
import { $, $$, esc } from "../lib/dom";
import { attachCrosshair, attachTooltips, divergingBars, legend, lineChart, orderRangeChart } from "./charts";

let S: State | null = null;
let view: "chart" | "table" = "chart";

$$<HTMLButtonElement>(".seg button").forEach((b) => (b.onclick = () => {
  view = b.dataset.v as typeof view;
  $$<HTMLButtonElement>(".seg button").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));

watch((s) => { S = s; render(); });

function render() {
  if (!S) return;
  $("#now").textContent = S.now;
  ({ uc1: renderUc1, uc2: renderUc2, uc3: renderUc3 })[S.scenario]();
  renderFeed();
  attachTooltips(document.body);
  attachCrosshair(document.body);
}

function titles(headline: string, left: [string, string], right: [string, string]) {
  $("#headline").textContent = headline;
  $("#leftTitle").textContent = left[0];
  $("#leftSub").textContent = left[1];
  $("#rightTitle").textContent = right[0];
  $("#rightSub").textContent = right[1];
}

function kpis(items: [string, string, string, string][]) {
  $("#kpis").innerHTML = items.map(([k, v, u, d]) =>
    `<div class="kpi"><div class="k">${k}</div><div class="v">${v}${v !== "―" ? `<small>${u}</small>` : ""}</div><div class="d">${d}</div></div>`).join("");
}

function stepper(steps: [string, string][], doneCount: number) {
  const started = S!.workflow_state !== "待機";
  $("#stepper").innerHTML = steps.map(([t, sub], k) => {
    const cls = k < doneCount ? "done" : started && k === doneCount ? "now" : "";
    return `<div class="step ${cls}"><span class="n">${k < doneCount ? "✓" : k + 1}</span><div><b>${t}</b><span>${sub}</span></div></div>`;
  }).join("");
}

function statusPill(s: string) {
  const m: Record<string, [string, string]> = { 確定: ["good", "✓"], 承認不要: ["good", "✓"], 受け入れ済み: ["good", "✓"],
    承認待ち: ["warn", "⏳"], 取り消し: ["", "↺"], 却下: ["crit", "✕"] };
  const [cls, ic] = m[s] ?? ["", "•"];
  return `<span class="pill ${cls}">${ic} ${esc(s)}</span>`;
}

// ---- 地図（店・DC・イベント会場・配送ルート） ------------------------------------------

interface MapLayer { points: { lon: number; lat: number }[] }

function projector(layer: MapLayer, W: number, H: number, P: number) {
  const pts = layer.points;
  const latC = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const k = Math.cos((latC * Math.PI) / 180);
  const xs = pts.map((p) => p.lon * k), ys = pts.map((p) => p.lat);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((W - 2 * P) / (x1 - x0), (H - 2 * P) / (y1 - y0));
  const X = (lon: number) => P + (lon * k - x0) * scale + ((W - 2 * P) - (x1 - x0) * scale) / 2;
  const Y = (lat: number) => H - P - (lat - y0) * scale - ((H - 2 * P) - (y1 - y0) * scale) / 2;
  return { X, Y, kmPx: scale / 111.32 };
}

const sites = () => S!.master.sites.map((x) => ({ id: x.site_id, name: x.name, kind: x.kind, lat: +x.lat, lon: +x.lon }));

// ---- UC1 補充 ----------------------------------------------------------------

function renderUc1() {
  const s = S!;
  titles("明日 10/24（土）の補充 ・ 東部エリア",
    ["拠点とイベント", "GeoSPARQL で、1号店から2km以内・1万人以上のイベントを見る"],
    ["1号店の発注と予測", "明日の事情に関わる品目は需要予測で、それ以外は SAP の推奨数で発注"]);
  const lines = s.plan?.lines ?? [];
  const ctx = hasContext(s.context) ? s.context : null;
  const confirmed = lines.filter((l) => l.status === "確定");
  kpis([
    ["発注品目", lines.length ? `${lines.length}` : "―", "品", "1号店 → 東部 DC"],
    ["需要予測で決めた品目", lines.length ? `${lines.filter((l) => l.forecast).length}` : "―", "品", "近くのイベント・暑さ・新商品"],
    ["承認待ち", lines.length ? `${lines.filter((l) => l.status === "承認待ち").length}` : "―", "品", "推奨数の1.5倍を超える"],
    ["確定した数量", confirmed.length ? confirmed.reduce((n, l) => n + l.quantity, 0).toLocaleString() : "―", "個", `確定 ${confirmed.length} 品`],
    ["点検と在庫で直した品目", lines.length ? `${lines.filter((l) => l.history.some((h) => h.includes("DC の在庫") || h.includes("置き場"))).length}` : "―", "品", "置き場の容量・DC の在庫"],
    ["明日の予報", ctx?.max_temp != null ? `${ctx.max_temp}` : "―", "℃", "東部地域 最高気温"],
  ]);
  stepper([["発注案の作成", "10:00 KINETIC が起動"], ["点検と自動確定", "10:15 SHACL 合格"], ["店長の承認", "10:30"],
    ["発注の締め", "11:00"], ["入荷検品", "翌 06:40"]], ({ 待機: 0, 承認待ち: 2, 締め待ち: 4, 完了: 5 } as Record<string, number>)[s.workflow_state] ?? 1);

  // 地図
  const st = sites();
  const events = s.master.events;
  const W = 520, H = 360;
  const { X, Y, kmPx } = projector({ points: [...st, ...events] }, W, H, 46);
  const st14 = st.find((x) => x.id === "ST-014")!;
  const evInfo = (id: string) => ctx?.events.find((e) => e.id === id);
  $("#map").innerHTML = `<div class="maplegend"><span><i class="s"></i>店</span><span><i class="d"></i>配送センター</span>
      <span><i class="e"></i>明日のイベント</span><span><i class="r"></i>1号店から ${ctx?.policy.r ?? 2}km</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="mapsvg" role="img" aria-label="店・配送センター・イベント会場の地図">
      <circle cx="${X(st14.lon)}" cy="${Y(st14.lat)}" r="${(ctx?.policy.r ?? 2) * kmPx}" class="ring"/>
      ${st.map((x) => x.kind === "Store"
        ? `<g data-tip="${esc(`${x.name}（${x.id}）|店`)}"><circle cx="${X(x.lon)}" cy="${Y(x.lat)}" r="7" class="store"/>
           ${x.id === "ST-014"   // 近くにイベントが集まるので、1号店のラベルだけ点の下に置く
             ? `<text x="${X(x.lon)}" y="${Y(x.lat) + 22}" class="lbl" text-anchor="middle">${esc(x.name)}</text>`
             : `<text x="${X(x.lon) + 11}" y="${Y(x.lat) + 4}" class="lbl">${esc(x.name)}</text>`}</g>`
        : `<g data-tip="${esc(`${x.name}（${x.id}）|配送センター`)}"><rect x="${X(x.lon) - 7}" y="${Y(x.lat) - 7}" width="14" height="14" rx="2" class="dc"/>
           <text x="${X(x.lon) + 12}" y="${Y(x.lat) + 4}" class="lbl">${esc(x.name)}</text></g>`).join("")}
      ${events.map((e) => {
        const info = evInfo(e.id);
        const near = info?.nearby ?? false;
        const tip = `${e.name}|${e.start.slice(11, 16)} 開始 ・ ${e.attendance.toLocaleString()}人${info ? `|1号店から ${info.km}km ・ ${near ? "発注に反映" : "対象外"}` : ""}`;
        const cx = X(e.lon), cy = Y(e.lat);
        // ラベルは選んで付ける: 小さなイベント（方針の人数未満）はツールチップだけ
        const labeled = e.attendance >= (ctx?.policy.min ?? 10000);
        return `<g data-tip="${esc(tip)}"><path d="M${cx},${cy - 9} L${cx + 9},${cy} L${cx},${cy + 9} L${cx - 9},${cy} Z" class="event ${ctx && !near ? "far" : ""}"/>
          ${labeled ? `<text x="${cx + 12}" y="${cy + 4}" class="lbl">${esc(e.name.replace(/の.*$/, ""))}
            <tspan class="lbl2" dx="4">${e.attendance.toLocaleString()}人</tspan></text>` : ""}</g>`;
      }).join("")}
    </svg>`;

  // 発注と予測
  const el = $("#chart");
  if (!lines.length) return void (el.innerHTML = `<p class="empty">10:00 に発注案が作られると表示されます</p>`);
  const sorted = [...lines].sort((a, b) => Number(!!b.forecast) - Number(!!a.forecast) || b.quantity - a.quantity);
  el.innerHTML = view === "chart" ? legend() + orderRangeChart(sorted, 720)
    : `<table class="clean"><tr><th>品目</th><th class="n">推奨数</th><th class="n">予測</th><th class="n">80%の幅</th><th class="n">発注</th><th>状態</th></tr>
      ${sorted.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${l.recommended ?? "―"}</td><td class="n">${l.forecast?.mean ?? "―"}</td>
        <td class="n">${l.forecast ? `${l.forecast.lower}〜${l.forecast.upper}` : "―"}</td><td class="n"><b>${l.quantity}</b></td>
        <td>${statusPill(l.status)}</td></tr>`).join("")}</table>`;
}

// ---- UC2 電力 ----------------------------------------------------------------

function renderUc2() {
  const s = S!;
  const u = s.uc2!;
  const c = u.context;
  const b = s.systems.bms;
  const hist = b.history.filter((h) => h.time !== b.history[0].time || b.history.length === 1);
  const latest = b.history[b.history.length - 1];
  const peakKw = Math.max(...b.history.slice(1).map((h) => h.kw), 0);
  titles(`今日 ${s.day.slice(5).replace("-", "/")} の電力 ・ 1号店`,
    ["売場とケースの温度", "SHACL の見張りの基準（売場 27℃以下、冷凍 −18℃以下）と並べて見る"],
    ["受電点のデマンド", "契約電力と、何もしないときの見込みに対して、調整後の実績を見る"]);
  kpis([
    ["契約電力", `${b.contract_kw}`, "kW", "これを超えると基本料金が上がる"],
    ["何もしないときの見込み", c.projected_kw ? `${c.projected_kw}` : "―", "kW", "14:00〜15:00"],
    ["調整後の見込み", c.planned_kw ? `${c.planned_kw}` : "―", "kW", "電力ピークの方針の順に調整"],
    ["いまのデマンド", `${latest.kw}`, "kW", `${latest.time} 時点`],
    ["今日のピーク（実績）", b.history.length > 1 ? `${peakKw}` : "―", "kW", "12:45 以降の最大"],
    ["元に戻した設備", `${u.settings.filter((x) => x.revert).length}`, "台", "見張りの違反で、その設備だけ"],
  ]);
  stepper([["調整案の作成", "12:30 KINETIC が起動"], ["点検と自動確定", "12:35 承認不要"], ["霜取りと予冷", "12:45〜14:00"],
    ["ピークの見張り", "14:00〜15:00 5分ごと"], ["結果", "15:30"]],
    s.workflow_state === "待機" ? 0 : s.workflow_state === "実行待ち" ? 2 : s.workflow_state === "完了" ? 5 :
      (() => { const t = Number(s.now.slice(0, 2)) + Number(s.now.slice(3, 5)) / 60; return t < 14 ? 2 : t <= 15 ? 3 : 4; })());

  const series = (key: string) => hist.map((h) => ({ t: h.time, v: Number(h[key]) }));
  $("#map").innerHTML = `<div class="smalls">
      ${lineChart({ name: "窓際の売場 ZT-2", unit: "℃", points: series("ZT-2"), domain: [12.5, 15.5], yDomain: [25, 29],
        refs: [{ v: 27, label: "上限 27℃" }], band: [14, 15], bandLabel: "ピーク", width: 520, height: 190, caption: "窓際の惣菜コーナー（ZT-2）℃" })}
      ${lineChart({ name: "冷凍ケース FZ-01", unit: "℃", points: series("FZ-01-T1"), domain: [12.5, 15.5], yDomain: [-24, -16],
        refs: [{ v: -18, label: "上限 −18℃" }], band: [14, 15], width: 520, height: 190, caption: "冷凍ケース（FZ-01）℃" })}
    </div>`;
  const el = $("#chart");
  if (view === "chart") {
    el.innerHTML = lineChart({ name: "デマンド", unit: "kW", points: b.history.map((h) => ({ t: h.time, v: h.kw })), domain: [12.5, 15.5],
      yDomain: [700, 860], refs: [{ v: b.contract_kw, label: `契約電力 ${b.contract_kw}kW` },
        ...(c.projected_kw ? [{ v: c.projected_kw, label: `何もしないときの見込み ${c.projected_kw}kW` }] : [])],
      band: [14, 15], bandLabel: "ピークの時間", width: 720, height: 300 });
  } else {
    el.innerHTML = `<table class="clean"><tr><th>時刻</th><th class="n">デマンド kW</th><th class="n">ZT-2 ℃</th><th class="n">FZ-01 ℃</th><th class="n">外気温 ℃</th></tr>
      ${b.history.map((h) => `<tr><td>${h.time}</td><td class="n">${h.kw}</td><td class="n">${h["ZT-2"]}</td><td class="n">${h["FZ-01-T1"]}</td><td class="n">${h.OAT ?? "―"}</td></tr>`).join("")}</table>`;
  }
}

// ---- UC3 在庫融通 --------------------------------------------------------------

function renderUc3() {
  const s = S!;
  const u = s.uc3!;
  const c = u.context;
  titles(`今日 ${s.day.slice(5).replace("-", "/")} の夕方の在庫融通 ・ 近くの3店`,
    ["店と今夜の帰り便", "GeoSPARQL で、帰り便のルートが受け入れる店から1km以内を通るかを見る"],
    ["閉店までに余る数・足りない数", "3店の POS の在庫と今日の販売数から見積もる（日配品と惣菜）"]);
  const moved = u.transfers.reduce((n, t) => n + (t.status === "受け入れ済み" ? t.quantity : 0), 0);
  kpis([
    ["店間移動", u.transfers.length ? `${u.transfers.length}` : "―", "件", "帰り便だけで運ぶ"],
    ["移す数量", u.transfers.length ? `${u.transfers.reduce((n, t) => n + t.quantity, 0)}` : "―", "個", "数量の修正後"],
    ["承認待ち", u.transfers.length ? `${u.transfers.filter((t) => t.status === "承認待ち").length}` : "―", "件", "上限を超える受け入れ"],
    ["受け入れ済み", u.transfers.length ? `${moved}` : "―", "個", "2号店でスキャン済み"],
    ["見切り", u.markdowns.length ? `${u.markdowns.length}` : "―", "件", u.markdowns.map((m) => m.applied.join("・")).join(" ") || "19:00・20:30 に値引き"],
    ["数量を直した移動", u.transfers.length ? `${u.transfers.filter((t) => t.history.length).length}` : "―", "件", "取り出しで実数が足りない"],
  ]);
  stepper([["融通の案", "16:00 KINETIC が起動"], ["点検と自動確定", "16:10"], ["受け入れの承認", "16:15 2号店の店長"],
    ["帰り便で運ぶ", "17:05〜18:10"], ["見切り", "19:00・20:30"]],
    s.workflow_state === "待機" ? 0 : s.workflow_state === "承認待ち" ? 2 : s.workflow_state === "完了" ? 5 :
      (() => { const t = Number(s.now.slice(0, 2)) + Number(s.now.slice(3, 5)) / 60; return t < 17 ? 3 : t < 19 ? 3 + (t >= 18.17 ? 1 : 0) : 4; })());

  // 地図: 店とルート
  const st = sites().filter((x) => x.kind === "Store");
  const vs = s.systems.tms.vehicles;
  const W = 520, H = 360;
  const { X, Y, kmPx } = projector({ points: [...st, ...vs.flatMap((v) => v.route.map(([lon, lat]) => ({ lon, lat })))] }, W, H, 40);
  const st31 = st.find((x) => x.id === "ST-031")!;
  const radius = (c.policy?.radius ?? 1) * kmPx;
  $("#map").innerHTML = `<div class="maplegend"><span><i class="sn"></i>店</span><span><i class="v1"></i>V-14（1号店の配送車）</span>
      <span><i class="v2"></i>V-40（3号店の配送車）</span><span><i class="r"></i>2号店から ${c.policy?.radius ?? 1}km</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="mapsvg" role="img" aria-label="店と今夜の配送ルート">
      <circle cx="${X(st31.lon)}" cy="${Y(st31.lat)}" r="${radius}" class="ring"/>
      ${vs.map((v, i) => {
        const r = c.routes?.find((x) => x.vehicle === v.id);
        return `<g data-tip="${esc(`${v.id} ${v.name}|${v.route_label}${r ? `|2号店から ${r.km}km ・ ${r.eta} 着` : ""}`)}">
          <polyline points="${v.route.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(" ")}" class="route r${i + 1}"/></g>`;
      }).join("")}
      ${st.map((x) => `<g data-tip="${esc(`${x.name}（${x.id}）`)}"><circle cx="${X(x.lon)}" cy="${Y(x.lat)}" r="7" class="storeN"/>
        <text x="${X(x.lon)}" y="${Y(x.lat) - 12}" class="lbl" text-anchor="middle">${esc(x.name)}</text></g>`).join("")}
    </svg>
    ${u.transfers.length ? `<table class="clean" style="margin-top:10px"><tr><th>ID</th><th>内容</th><th>便</th><th>状態</th></tr>
      ${u.transfers.map((t) => `<tr><td>${t.id}</td><td>${esc(t.name)} ${t.quantity}<div class="muted">${storeName(t.source)} → ${storeName(t.dest)}</div></td>
        <td>${t.vehicle} ${t.eta}</td><td>${statusPill(t.status)}</td></tr>`).join("")}</table>` : ""}`;

  const el = $("#chart");
  const est = c.estimates ?? [];
  if (!est.length) return void (el.innerHTML = `<p class="empty">16:00 に案が作られると表示されます</p>`);
  const rows = [...est].sort((a, b) => a.product.localeCompare(b.product) || a.store.localeCompare(b.store));
  el.innerHTML = view === "chart"
    ? `<div class="legend"><span><i class="sw pos"></i>余る</span><span><i class="sw neg"></i>足りない</span></div>` +
      divergingBars(rows.map((e) => ({ label: `${storeName(e.store)} ${e.name}`, value: e.balance,
        tip: `${storeName(e.store)} ${e.name}|在庫 ${e.stock}・閉店までに売れる見込み ${e.rest}|${e.balance >= 0 ? "余る" : "足りない"} ${Math.abs(e.balance)}・期限 ${e.expiry}` })), 720)
    : `<table class="clean"><tr><th>店</th><th>商品</th><th class="n">在庫</th><th class="n">閉店までに売れる</th><th class="n">余る・足りない</th><th>期限</th></tr>
      ${rows.map((e) => `<tr><td>${storeName(e.store)}</td><td>${esc(e.name)}</td><td class="n">${e.stock}</td><td class="n">${e.rest}</td>
        <td class="n"><b>${e.balance > 0 ? "+" : ""}${e.balance}</b></td><td>${e.expiry}</td></tr>`).join("")}</table>`;
}

function renderFeed() {
  const rows = [...S!.log].reverse().slice(0, 10);
  $("#feed").innerHTML = rows.map((e) => `<div class="feedrow"><span class="t">${esc(e.time)}</span><span class="pill">${e.layer}</span>
    <span><span class="who">${esc(e.actor)}</span> ・ ${esc(e.title)}</span></div>`).join("");
}
