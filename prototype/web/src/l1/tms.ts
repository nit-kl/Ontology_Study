// レイヤー1 TMS（2000年代の配車クライアント風）。ネットスーパー配送車の今夜のルートと、立ち寄りの指示。
// 立ち寄りは KINETIC から Webhook で足される。ここでは判断しない。
import "./tms.css";
import { storeName, watch, type State } from "../lib/api";
import { $, esc, toast } from "../lib/dom";

let S: State | null = null;
let stopCount = 0;

watch((s) => {
  const n = s.systems.tms.stops.length;
  if (S && n > stopCount) toast("立寄り指示を受信");
  stopCount = n;
  S = s;
  render();
});

function render() {
  if (!S) return;
  const { stops } = S.systems.tms;
  $("#page").innerHTML = `${routeMap(S)}
    ${stops.length ? `<table class="grid">
      <tr><th>車番</th><th>立寄り先</th><th>時刻</th><th>内容</th><th>状態</th></tr>
      ${stops.map((s) => `<tr class="add"><td>${s.vehicle}</td><td>${storeName(s.store)}</td><td>${s.time}</td><td>${esc(s.purpose)}</td><td>${esc(s.status)}</td></tr>`).join("")}
      </table>` : ""}`;
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
      <text x="${X(v.route[0][0]) + 6}" y="${Y(v.route[0][1]) + 16}" class="t">${v.id}</text>`).join("")}
    ${sites.map((p) => `<rect x="${X(p.lon) - 6}" y="${Y(p.lat) - 6}" width="12" height="12" class="store"/>
      <text x="${X(p.lon) + 9}" y="${Y(p.lat) - 8}" class="t">${storeName(p.id)}</text>`).join("")}
  </svg>`;
}
