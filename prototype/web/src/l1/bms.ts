// レイヤー1 BMS（中央監視の HMI 風）。店舗設備の状態と計測値、警報、外部（KINETIC）から受けた制御コマンドを見る。
// 時刻つきの設定を受け付けて設備を動かすだけで、何をするかは判断しない。
import "./bms.css";
import { watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type View = "plan" | "demand" | "commands";
const VIEWS: [View, string][] = [["plan", "系統図"], ["demand", "デマンド"], ["commands", "操作履歴"]];
let S: State | null = null;
let view: View = VIEWS.some(([k]) => k === location.hash.slice(1)) ? (location.hash.slice(1) as View) : "plan";
let ackAlarms = 0;
let cmdCount = 0;

$("#menu").innerHTML = VIEWS.map(([k, n]) => `<button data-v="${k}">${n}</button>`).join("");
$$<HTMLButtonElement>("#menu button").forEach((b) => (b.onclick = () => { view = b.dataset.v as View; render(); }));

watch((s) => {
  const n = s.systems.bms.commands.length;
  if (S && n > cmdCount) toast(`制御コマンド ${n - cmdCount} 件受信`);
  cmdCount = n;
  if (s.systems.bms.alarms.length < ackAlarms) ackAlarms = 0;
  S = s;
  render();
});

const kindName: Record<string, string> = { defrost: "霜取り", setpoint: "設定温度", dim: "調光", output: "出力", precool: "予冷", revert: "戻す" };

function render() {
  if (!S) return;
  const b = S.systems.bms;
  $$<HTMLButtonElement>("#menu button").forEach((x) => x.classList.toggle("on", x.dataset.v === view));
  $("#clock").textContent = b.now;
  const latest = b.history[b.history.length - 1];
  const unacked = b.alarms.slice(ackAlarms);
  const last = unacked[unacked.length - 1];
  const al = $("#alarm");
  al.className = "alarm" + (last ? " on" : "");
  al.innerHTML = last ? `▲ ${esc(last.time)} ${esc(last.text)} ${last.value}℃ <button id="ack">確認</button>` : "";
  document.getElementById("ack")?.addEventListener("click", () => { ackAlarms = b.alarms.length; render(); });
  const main = $("#main");
  const eff = b.effective;

  if (view === "plan") {
    main.innerHTML = `<div class="panel"><div class="in plan">
      ${b.zones.map((z, i) => {
        const zt = `ZT-${i + 1}`, ahu = `AHU-${i + 1}`;
        const v = b.sensors[zt];
        const lz = b.equipment.filter((e) => e.type === "LightingZone" && e.zone === z.id);
        return `<div class="zone ${z.window ? "window" : ""}"><b>${esc(z.name)}</b><br>
          <span class="led ${v > 27 ? "warn" : ""}">${v.toFixed(1)}℃</span>
          <div class="eq"><span class="lamp on"></span>${ahu} ${eff[ahu].setpoint}℃</div>
          ${lz.map((l) => `<div class="eq"><span class="lamp ${eff[l.id].dim ? "amber" : "on"}"></span>${l.id} ${eff[l.id].dim || 100}%</div>`).join("")}
        </div>`;
      }).join("")}
    </div></div>
    <div class="panel"><div class="in">
      <div class="eq">FZ-01 <span class="led small ${b.sensors["FZ-01-T1"] > -18 ? "warn" : ""}">${b.sensors["FZ-01-T1"].toFixed(1)}℃</span>
        ${eff["FZ-01"].setpoint}℃ ${eff["FZ-01"].precool ? "予冷" : ""} ${eff["FZ-01"].output}%</div>
      <div class="cases" style="margin-top:8px">${Object.keys(b.defrost).map((rc) => `<div class="case ${eff[rc].defrosting ? "defrost" : ""}">
        <span class="lamp ${eff[rc].defrosting ? "amber" : "on"}"></span>${rc}</div>`).join("")}</div>
    </div></div>
    <div class="panel"><div class="in"><span class="led ${latest.kw > b.contract_kw ? "warn" : ""}">${latest.kw} kW</span> / ${b.contract_kw} kW</div></div>`;
  } else if (view === "demand") {
    main.innerHTML = `<div class="panel"><div class="in">${trend(S)}</div></div>`;
  } else {
    main.innerHTML = `<div class="panel"><div class="in"><table class="grid">
      <tr><th>時刻</th><th>機器</th><th>種別</th><th>内容</th></tr>
      ${b.commands.map((c) => `<tr><td>${c.time}</td><td>${c.equipment}</td><td>${kindName[c.kind] ?? c.kind}</td>
        <td>${c.kind === "defrost" ? (c.value as number[]).join(", ") : c.kind === "revert" ? "" : `${c.value} (${c.from}〜${c.to})`}</td></tr>`).join("")}
      </table></div></div>`;
  }
}

function trend(s: State): string {
  const b = s.systems.bms;
  const rows = b.history;
  const W = 900, H = 320, L = 50, R = 20, T = 16, B = 30;
  const t0 = 12.5, t1 = 15.5;
  const toH = (t: string) => { const [h, m] = t.split(":").map(Number); return h + m / 60; };
  const x = (h: number) => L + ((h - t0) / (t1 - t0)) * (W - L - R);
  const y = (kw: number) => T + (1 - (kw - 700) / (850 - 700)) * (H - T - B);
  const pts = rows.map((r) => `${x(toH(r.time)).toFixed(1)},${y(r.kw).toFixed(1)}`).join(" ");
  const grid = [700, 725, 750, 775, 800, 825, 850].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join("");
  const xs = ["12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"].map((t) =>
    `<line x1="${x(toH(t))}" x2="${x(toH(t))}" y1="${T}" y2="${H - B}" class="gl"/><text x="${x(toH(t))}" y="${H - 10}" class="ax" text-anchor="middle">${t}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="デマンドの推移">
    <rect x="${x(14)}" y="${T}" width="${x(15) - x(14)}" height="${H - T - B}" class="peak"/>
    ${grid}${xs}
    <line x1="${L}" x2="${W - R}" y1="${y(b.contract_kw)}" y2="${y(b.contract_kw)}" class="contract"/>
    <text x="${W - R - 4}" y="${y(b.contract_kw) - 6}" class="lbl" text-anchor="end">契約 ${b.contract_kw}kW</text>
    <polyline points="${pts}" class="line"/>
  </svg>`;
}
