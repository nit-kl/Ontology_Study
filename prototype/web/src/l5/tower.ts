// レイヤー5 コントロールタワー。供給網の担当が、地図とグラフを見る。
// 数字はレイヤー4 が取ってきたグラフの事実と、確定した計画、レイヤー1 の計測値。ここでは計算し直さない。
// UC1 は補充（発注と予測）、UC2 は電力（デマンドと温度）、UC3 は在庫融通（ルートと余り・不足）を出す。
import "./modern.css";
import "./tower.css";
import { hasContext, storeName, watch, type State } from "../lib/api";
import { $, esc } from "../lib/dom";
import { attachCrosshair, attachTooltips, divergingBars, legend, lineChart, orderRangeChart } from "./charts";

let S: State | null = null;
watch((s) => { S = s; render(); });

function render() {
  if (!S) return;
  $("#now").textContent = S.now;
  ({ uc1: renderUc1, uc2: renderUc2, uc3: renderUc3 })[S.scenario]();
  attachTooltips(document.body);
  attachCrosshair(document.body);
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
  $("#headline").textContent = "明日 10/24（土）の補充";
  const lines = s.plan?.lines ?? [];
  const ctx = hasContext(s.context) ? s.context : null;

  // 地図
  const st = sites();
  const events = s.master.events;
  const W = 520, H = 360;
  const { X, Y, kmPx } = projector({ points: [...st, ...events] }, W, H, 46);
  const st14 = st.find((x) => x.id === "ST-014")!;
  const evInfo = (id: string) => ctx?.events.find((e) => e.id === id);
  $("#map").innerHTML = `<div class="maplegend"><span><i class="s"></i>店</span><span><i class="d"></i>DC</span>
      <span><i class="e"></i>イベント</span><span><i class="r"></i>${ctx?.policy.r ?? 2}km</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="mapsvg" role="img" aria-label="店・配送センター・イベント会場の地図">
      <circle cx="${X(st14.lon)}" cy="${Y(st14.lat)}" r="${(ctx?.policy.r ?? 2) * kmPx}" class="ring"/>
      ${st.map((x) => x.kind === "Store"
        ? `<g data-tip="${esc(x.name)}"><circle cx="${X(x.lon)}" cy="${Y(x.lat)}" r="7" class="store"/>
           ${x.id === "ST-014"   // 近くにイベントが集まるので、1号店のラベルだけ点の下に置く
             ? `<text x="${X(x.lon)}" y="${Y(x.lat) + 22}" class="lbl" text-anchor="middle">${esc(x.name)}</text>`
             : `<text x="${X(x.lon) + 11}" y="${Y(x.lat) + 4}" class="lbl">${esc(x.name)}</text>`}</g>`
        : `<g data-tip="${esc(x.name)}"><rect x="${X(x.lon) - 7}" y="${Y(x.lat) - 7}" width="14" height="14" rx="2" class="dc"/>
           <text x="${X(x.lon) + 12}" y="${Y(x.lat) + 4}" class="lbl">${esc(x.name)}</text></g>`).join("")}
      ${events.map((e) => {
        const info = evInfo(e.id);
        const near = info?.nearby ?? false;
        const tip = `${e.name}|${e.attendance.toLocaleString()}人${info ? ` ・ ${info.km}km` : ""}`;
        const cx = X(e.lon), cy = Y(e.lat);
        // ラベルは選んで付ける: 小さなイベント（方針の人数未満）はツールチップだけ
        const labeled = e.attendance >= (ctx?.policy.min ?? 10000);
        return `<g data-tip="${esc(tip)}"><path d="M${cx},${cy - 9} L${cx + 9},${cy} L${cx},${cy + 9} L${cx - 9},${cy} Z" class="event ${ctx && !near ? "far" : ""}"/>
          ${labeled ? `<text x="${cx + 12}" y="${cy + 4}" class="lbl">${esc(e.name.replace(/の.*$/, ""))}</text>` : ""}</g>`;
      }).join("")}
    </svg>`;

  // 発注と予測
  const el = $("#chart");
  if (!lines.length) return void (el.innerHTML = `<p class="empty">―</p>`);
  const sorted = [...lines].sort((a, b) => Number(!!b.forecast) - Number(!!a.forecast) || b.quantity - a.quantity);
  el.innerHTML = legend() + orderRangeChart(sorted, 720);
}

// ---- UC2 電力 ----------------------------------------------------------------

function renderUc2() {
  const s = S!;
  const c = s.uc2!.context;
  const b = s.systems.bms;
  const hist = b.history.filter((h) => h.time !== b.history[0].time || b.history.length === 1);
  $("#headline").textContent = `今日 ${s.day.slice(5).replace("-", "/")} の電力 ・ 1号店`;
  const series = (key: string) => hist.map((h) => ({ t: h.time, v: Number(h[key]) }));
  $("#map").innerHTML = `<div class="smalls">
      ${lineChart({ name: "ZT-2", unit: "℃", points: series("ZT-2"), domain: [12.5, 15.5], yDomain: [25, 29],
        refs: [{ v: 27, label: "27℃" }], band: [14, 15], width: 520, height: 190, caption: "窓際の売場 ℃" })}
      ${lineChart({ name: "FZ-01", unit: "℃", points: series("FZ-01-T1"), domain: [12.5, 15.5], yDomain: [-24, -16],
        refs: [{ v: -18, label: "−18℃" }], band: [14, 15], width: 520, height: 190, caption: "冷凍ケース ℃" })}
    </div>`;
  $("#chart").innerHTML = lineChart({ name: "デマンド", unit: "kW", points: b.history.map((h) => ({ t: h.time, v: h.kw })), domain: [12.5, 15.5],
    yDomain: [700, 860], refs: [{ v: b.contract_kw, label: `契約 ${b.contract_kw}kW` },
      ...(c.projected_kw ? [{ v: c.projected_kw, label: `何もしないとき ${c.projected_kw}kW` }] : [])],
    band: [14, 15], width: 720, height: 300, caption: "デマンド kW" });
}

// ---- UC3 在庫融通 --------------------------------------------------------------

function renderUc3() {
  const s = S!;
  const c = s.uc3!.context;
  $("#headline").textContent = `今日 ${s.day.slice(5).replace("-", "/")} の在庫融通`;

  // 地図: 店とルート
  const st = sites().filter((x) => x.kind === "Store");
  const vs = s.systems.tms.vehicles;
  const W = 520, H = 360;
  const { X, Y, kmPx } = projector({ points: [...st, ...vs.flatMap((v) => v.route.map(([lon, lat]) => ({ lon, lat })))] }, W, H, 40);
  const st31 = st.find((x) => x.id === "ST-031")!;
  const radius = (c.policy?.radius ?? 1) * kmPx;
  $("#map").innerHTML = `<div class="maplegend"><span><i class="v1"></i>V-14</span><span><i class="v2"></i>V-40</span>
      <span><i class="r"></i>${c.policy?.radius ?? 1}km</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="mapsvg" role="img" aria-label="店と今夜の配送ルート">
      <circle cx="${X(st31.lon)}" cy="${Y(st31.lat)}" r="${radius}" class="ring"/>
      ${vs.map((v, i) => {
        const r = c.routes?.find((x) => x.vehicle === v.id);
        return `<g data-tip="${esc(`${v.id}${r ? `|${r.km}km ・ ${r.eta}` : ""}`)}">
          <polyline points="${v.route.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(" ")}" class="route r${i + 1}"/></g>`;
      }).join("")}
      ${st.map((x) => `<g><circle cx="${X(x.lon)}" cy="${Y(x.lat)}" r="7" class="storeN"/>
        <text x="${X(x.lon)}" y="${Y(x.lat) - 12}" class="lbl" text-anchor="middle">${esc(x.name)}</text></g>`).join("")}
    </svg>`;

  const el = $("#chart");
  const est = c.estimates ?? [];
  if (!est.length) return void (el.innerHTML = `<p class="empty">―</p>`);
  const rows = [...est].sort((a, b) => a.product.localeCompare(b.product) || a.store.localeCompare(b.store));
  el.innerHTML = `<div class="legend"><span><i class="sw pos"></i>余る</span><span><i class="sw neg"></i>足りない</span></div>` +
    divergingBars(rows.map((e) => ({ label: `${storeName(e.store)} ${e.name}`, value: e.balance,
      tip: `${storeName(e.store)} ${e.name}|在庫 ${e.stock}・売れる見込み ${e.rest}` })), 720);
}
