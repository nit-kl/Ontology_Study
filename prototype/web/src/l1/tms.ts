// レイヤー1 TMS（2000年代の配車クライアント風）。ネットスーパー配送車の台帳、今夜のルート、立ち寄りの指示。
// 立ち寄りは KINETIC から Webhook で足される。ここでは判断しない。
import "./tms.css";
import { storeName, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type Tab = "vehicles" | "routes" | "stops" | "log";
const TABS: [Tab, string][] = [["vehicles", "車両一覧"], ["routes", "配送ルート"], ["stops", "立寄り指示"], ["log", "連携履歴"]];
let S: State | null = null;
let tab: Tab = TABS.some(([k]) => k === location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : "vehicles";
let stopCount = 0;

$("#tabs").innerHTML = TABS.map(([k, n]) => `<button data-t="${k}">${n}</button>`).join("");
$$<HTMLButtonElement>("#tabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.t as Tab; render(); }));

watch((s) => {
  const n = s.systems.tms.stops.length;
  if (S && n > stopCount) toast("本部連携: 立寄り指示を受信しました");
  stopCount = n;
  S = s;
  render();
});

function render() {
  if (!S) return;
  $$<HTMLButtonElement>("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
  const { vehicles, stops } = S.systems.tms;
  const page = $("#page");
  $("#st1").textContent = `車両 ${vehicles.length} 台 ／ 立寄り ${stops.length} 件`;
  $("#st2").textContent = `運行日 ${S.day.replaceAll("-", "/")}  ${S.now}`;

  if (tab === "vehicles") {
    page.innerHTML = `<div class="grp"><span class="cap">車両マスタ</span><table class="grid">
      <tr><th>車番</th><th>名称</th><th>所属店</th><th>温度帯</th><th>保冷時間</th><th>空き(ケース)</th><th>今夜の運行</th></tr>
      ${vehicles.map((v) => `<tr><td>${v.id}</td><td>${esc(v.name)}</td><td>${storeName(v.home)}</td><td>${v.temp_zone === "Chilled" ? "冷蔵" : v.temp_zone}</td>
        <td class="n">${v.cold_hours}h</td><td class="n">${v.free_units}</td><td>${esc(v.route_label)}</td></tr>`).join("")}</table></div>`;
  } else if (tab === "routes") {
    page.innerHTML = `<div class="legend"><span><i style="border-color:#2a78d6"></i>V-14 のルート</span><span><i style="border-color:#eb6834;border-top-style:dashed"></i>V-40 のルート</span>
      <span>□ 店舗</span><span>┄ 2号店から 1km</span></div>${routeMap(S)}`;
  } else if (tab === "stops") {
    page.innerHTML = `<div class="grp"><span class="cap">立寄り指示（本部連携で追加）</span>${stops.length ? `<table class="grid">
      <tr><th>車番</th><th>立寄り先</th><th>予定時刻</th><th>内容</th><th>状態</th></tr>
      ${stops.map((s) => `<tr class="add"><td>${s.vehicle}</td><td>${storeName(s.store)}</td><td>${s.time}</td><td>${esc(s.purpose)}</td><td>${esc(s.status)}</td></tr>`).join("")}
      </table>` : `<p class="empty">立寄り指示はありません。</p>`}</div>`;
  } else {
    const rows = S.log.filter((e) => e.actor.includes("TMS") || e.title.includes("帰り便") || e.title.includes("立ち寄り"));
    page.innerHTML = `<div class="grp"><span class="cap">外部連携の履歴</span><table class="grid"><tr><th>時刻</th><th>相手</th><th>内容</th></tr>
      ${rows.map((e) => `<tr><td>${esc(e.time)}</td><td>${e.layer === "L1" ? "本部（Webhook）" : "本部"}</td><td>${esc(e.title)}</td></tr>`).join("") ||
        `<tr><td colspan="3">履歴はありません</td></tr>`}</table></div>`;
  }
}

function routeMap(s: State): string {
  const sites = s.master.sites.filter((x) => x.kind === "Store").map((x) => ({ id: x.site_id, lon: +x.lon, lat: +x.lat }));
  const vs = s.systems.tms.vehicles;
  const all = [...sites.map((p) => [p.lon, p.lat]), ...vs.flatMap((v) => v.route)];
  const lons = all.map((p) => p[0]), lats = all.map((p) => p[1]);
  const W = 900, H = 420, P = 40;
  const k = Math.cos((35.68 * Math.PI) / 180);
  const [x0, x1, y0, y1] = [Math.min(...lons) * k, Math.max(...lons) * k, Math.min(...lats), Math.max(...lats)];
  const sc = Math.min((W - 2 * P) / (x1 - x0), (H - 2 * P) / (y1 - y0));
  const X = (lon: number) => P + (lon * k - x0) * sc;
  const Y = (lat: number) => H - P - (lat - y0) * sc;
  const r1km = sc / 111.32;
  const gridLines = Array.from({ length: 12 }, (_, i) => `<line x1="${(i * W) / 11}" x2="${(i * W) / 11}" y1="0" y2="${H}" class="grid1"/>`).join("") +
    Array.from({ length: 7 }, (_, i) => `<line x1="0" x2="${W}" y1="${(i * H) / 6}" y2="${(i * H) / 6}" class="grid1"/>`).join("");
  const st31 = sites.find((x) => x.id === "ST-031")!;
  return `<svg viewBox="0 0 ${W} ${H}" class="map" role="img" aria-label="今夜の配送ルート">${gridLines}
    <circle cx="${X(st31.lon)}" cy="${Y(st31.lat)}" r="${r1km}" class="ring"/>
    ${vs.map((v, i) => `<polyline points="${v.route.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(" ")}" class="route r${i + 1}"/>
      <text x="${X(v.route[0][0]) + 6}" y="${Y(v.route[0][1]) + 16}" class="t">${v.id} 出庫</text>`).join("")}
    ${sites.map((p) => `<rect x="${X(p.lon) - 6}" y="${Y(p.lat) - 6}" width="12" height="12" class="store"/>
      <text x="${X(p.lon) + 9}" y="${Y(p.lat) - 8}" class="t">${storeName(p.id)}（${p.id}）</text>`).join("")}
  </svg>`;
}
