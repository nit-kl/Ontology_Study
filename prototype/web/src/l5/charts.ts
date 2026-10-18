// レイヤー5 のグラフの部品。SVG を文字列で組み、色は CSS の役割（--series-1 など）で塗る。
import "./charts.css";
import type { Line } from "../lib/api";
import { esc } from "../lib/dom";

/** 凡例。系列が2つ以上のときは必ず出す。 */
export function legend(): string {
  return `<div class="legend">
    <span><i class="sw bar"></i>発注数</span>
    <span><i class="sw band"></i>予測の80%の幅</span>
    <span><i class="sw tick"></i>SAP の推奨数</span>
  </div>`;
}

/**
 * 商品ごとの「発注数・予測の幅・推奨数」を横に並べたグラフ。
 * 1本の数直線（共通の軸）だけを使い、ラベルは文字の色で書く（系列の色は使わない）。
 */
export function orderRangeChart(lines: Line[], width = 640, compact = false): string {
  const rowH = compact ? 34 : 40;
  const labelW = compact ? 10 : 150;
  const top = 6;
  const axisH = 22;
  const max = Math.max(...lines.map((l) => Math.max(l.quantity, l.forecast?.upper ?? 0, l.recommended ?? 0))) * 1.1;
  const plotW = width - labelW - 44;
  const x = (v: number) => labelW + (v / max) * plotW;
  const ticks = niceTicks(max);
  const h = top + lines.length * rowH + axisH;

  const grid = ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${h - axisH}" class="grid"/>
    <text x="${x(t)}" y="${h - 6}" class="axis" text-anchor="middle">${t}</text>`).join("");

  const rows = lines.map((l, i) => {
    const cy = top + i * rowH + rowH / 2;
    const f = l.forecast;
    const tip = [l.name, `発注 ${l.quantity}`, f ? `予測 ${f.mean}（${f.lower}〜${f.upper}）` : "予測なし（推奨数のまま）",
      l.recommended != null ? `推奨数 ${l.recommended}` : "推奨数なし（新商品）", `状態 ${l.status}`].join("|");
    const barW = Math.max(0, x(l.quantity) - labelW);
    return `<g class="row" data-tip="${esc(tip)}">
      <rect x="0" y="${cy - rowH / 2}" width="${width}" height="${rowH}" class="hit"/>
      ${compact ? "" : `<text x="0" y="${cy + 4}" class="label">${esc(l.name)}</text>`}
      ${f ? `<rect x="${x(f.lower)}" y="${cy - 10}" width="${x(f.upper) - x(f.lower)}" height="20" rx="4" class="band"/>` : ""}
      <path d="${roundedBar(labelW, cy - 4, barW, 8)}" class="bar"/>
      ${l.recommended != null ? `<line x1="${x(l.recommended)}" x2="${x(l.recommended)}" y1="${cy - 12}" y2="${cy + 12}" class="tick"/>` : ""}
      <text x="${x(Math.max(l.quantity, f?.upper ?? 0)) + 6}" y="${cy + 4}" class="value">${l.quantity}</text>
    </g>`;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${h}" class="rangechart" role="img" aria-label="商品ごとの発注数と予測の幅と推奨数">
    ${grid}<line x1="${labelW}" x2="${labelW}" y1="${top}" y2="${h - axisH}" class="baseline"/>${rows}</svg>`;
}

/** 左端（基準線）は角、右端（データの端）だけ 4px 丸めた棒。 */
function roundedBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

function niceTicks(max: number): number[] {
  const step = [5, 10, 20, 25, 50, 100].find((s) => max / s <= 6) ?? 100;
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

/** data-tip を持つ要素にツールチップを付ける。区切りは「|」、1行目を見出しにする。 */
export function attachTooltips(root: HTMLElement): void {
  let tip = document.querySelector<HTMLDivElement>(".tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    document.body.appendChild(tip);
  }
  const t = tip;
  root.querySelectorAll<SVGElement | HTMLElement>("[data-tip]").forEach((el) => {
    el.addEventListener("mousemove", (e) => {
      const [head, ...rest] = (el.getAttribute("data-tip") ?? "").split("|");
      t.innerHTML = `<b>${esc(head)}</b>${rest.map(esc).join("<br>")}`;
      t.style.display = "block";
      const me = e as MouseEvent;
      t.style.left = Math.min(me.clientX + 14, innerWidth - 280) + "px";
      t.style.top = me.clientY + 14 + "px";
    });
    el.addEventListener("mouseleave", () => (t.style.display = "none"));
  });
}

// ---- 折れ線（時間の推移）。系列は1本、基準線は文字で名前を付ける ----------------------------

export interface LineSpec {
  name: string;
  unit: string;
  points: { t: string; v: number }[];
  domain: [number, number];   // 時刻（時）の範囲
  yDomain: [number, number];
  refs?: { v: number; label: string }[];
  band?: [number, number];    // 時間帯の網掛け（ピークの時間など）
  bandLabel?: string;
  width?: number;
  height?: number;
  caption?: string;           // 小さなグラフを並べるときの見出し
}

const toHours = (t: string) => { const [h, m] = t.replace("翌 ", "").split(":").map(Number); return h + m / 60; };

export function lineChart(spec: LineSpec): string {
  const W = spec.width ?? 640, H = spec.height ?? 240, L = 44, R = 16, T = 14, B = 26;
  const [d0, d1] = spec.domain, [y0, y1] = spec.yDomain;
  const x = (h: number) => L + ((h - d0) / (d1 - d0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const step = (y1 - y0) / 4;
  const yt = Array.from({ length: 5 }, (_, i) => y0 + i * step);
  const xt: number[] = [];
  for (let h = Math.ceil(d0 * 2) / 2; h <= d1 + 1e-9; h += 0.5) xt.push(h);
  const pts = spec.points.map((p) => [x(toHours(p.t)), y(p.v)] as const);
  const path = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const data = JSON.stringify(spec.points.map((p) => ({ x: x(toHours(p.t)), t: p.t, v: p.v })));
  return `<div class="linewrap" data-points='${esc(data)}' data-name="${esc(spec.name)}" data-unit="${esc(spec.unit)}" data-w="${W}">
    ${spec.caption ? `<div class="linecap">${esc(spec.caption)}</div>` : ""}
    <svg viewBox="0 0 ${W} ${H}" class="linechart" role="img" aria-label="${esc(spec.name)}の推移">
    ${spec.band ? `<rect x="${x(spec.band[0])}" y="${T}" width="${x(spec.band[1]) - x(spec.band[0])}" height="${H - T - B}" class="band"/>
      <text x="${x(spec.band[0]) + 4}" y="${T + 12}" class="axis">${esc(spec.bandLabel ?? "")}</text>` : ""}
    ${yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${Number(v.toFixed(1))}</text>`).join("")}
    ${xt.map((h) => `<text x="${x(h)}" y="${H - 8}" class="axis" text-anchor="middle">${Math.floor(h)}:${h % 1 ? "30" : "00"}</text>`).join("")}
    ${(spec.refs ?? []).map((r) => `<line x1="${L}" x2="${W - R}" y1="${y(r.v)}" y2="${y(r.v)}" class="ref"/>
      <text x="${W - R}" y="${y(r.v) - 5}" class="reflabel" text-anchor="end">${esc(r.label)}</text>`).join("")}
    ${pts.length ? `<path d="${path}" class="line"/>` : ""}
    ${last ? `<circle cx="${last[0]}" cy="${last[1]}" r="4" class="endpt"/>` : ""}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    </svg></div>`;
}

/** 折れ線の上で、ポインタに一番近い時刻に縦線を合わせ、その時刻の値を出す。 */
export function attachCrosshair(root: HTMLElement): void {
  let tip = document.querySelector<HTMLDivElement>(".tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    document.body.appendChild(tip);
  }
  const t = tip;
  root.querySelectorAll<HTMLDivElement>(".linewrap").forEach((wrap) => {
    const pts: { x: number; t: string; v: number }[] = JSON.parse(wrap.dataset.points ?? "[]");
    const svg = wrap.querySelector("svg")!;
    const cross = wrap.querySelector<SVGLineElement>(".cross")!;
    const W = Number(wrap.dataset.w);
    svg.addEventListener("mousemove", (e) => {
      if (!pts.length) return;
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      const p = pts.reduce((a, b) => (Math.abs(b.x - vx) < Math.abs(a.x - vx) ? b : a));
      cross.setAttribute("x1", String(p.x));
      cross.setAttribute("x2", String(p.x));
      cross.setAttribute("visibility", "visible");
      t.innerHTML = `<b>${esc(p.t)}</b>${esc(wrap.dataset.name)} ${p.v}${esc(wrap.dataset.unit)}`;
      t.style.display = "block";
      t.style.left = Math.min(e.clientX + 14, innerWidth - 220) + "px";
      t.style.top = e.clientY + 14 + "px";
    });
    svg.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); t.style.display = "none"; });
  });
}

// ---- 分岐の横棒（余る ↔ 足りない）。0 を中心に、余るは青、足りないは赤 ------------------------

export function divergingBars(rows: { label: string; value: number; tip: string }[], width = 640): string {
  const rowH = 30, labelW = 170, T = 8, B = 24;
  const max = Math.max(10, ...rows.map((r) => Math.abs(r.value))) * 1.15;
  const plotW = width - labelW - 20;
  const x0 = labelW + plotW / 2;
  const x = (v: number) => x0 + (v / max) * (plotW / 2);
  const H = T + rows.length * rowH + B;
  return `<svg viewBox="0 0 ${width} ${H}" class="divchart" role="img" aria-label="店と商品ごとの、閉店までに余る数と足りない数">
    <line x1="${x0}" x2="${x0}" y1="${T}" y2="${H - B}" class="mid"/>
    <text x="${x(-max * 0.5)}" y="${H - 6}" class="axis" text-anchor="middle">← 足りない</text>
    <text x="${x(max * 0.5)}" y="${H - 6}" class="axis" text-anchor="middle">余る →</text>
    ${rows.map((r, i) => {
      const cy = T + i * rowH + rowH / 2;
      const w = Math.abs(x(r.value) - x0);
      const pos = r.value >= 0;
      return `<g class="row" data-tip="${esc(r.tip)}"><rect x="0" y="${cy - rowH / 2}" width="${width}" height="${rowH}" class="hit"/>
        <text x="0" y="${cy + 4}" class="label">${esc(r.label)}</text>
        ${r.value ? `<rect x="${pos ? x0 : x0 - w}" y="${cy - 7}" width="${w}" height="14" rx="3" class="${pos ? "pos" : "neg"}"/>` : ""}
        <text x="${pos ? x(r.value) + 6 : x(r.value) - 6}" y="${cy + 4}" class="value" text-anchor="${pos ? "start" : "end"}">${r.value > 0 ? "+" : ""}${r.value}</text></g>`;
    }).join("")}</svg>`;
}
