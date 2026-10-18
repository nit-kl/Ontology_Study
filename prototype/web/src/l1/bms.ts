// レイヤー1 BMS（中央監視の HMI 風）。店舗設備の状態と計測値、警報、外部（KINETIC）から受けた制御コマンドを見る。
// 時刻つきの設定を受け付けて設備を動かすだけで、何をするかは判断しない。
import "./bms.css";
import { watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type View = "plan" | "cases" | "hvac" | "demand" | "alarms" | "commands";
const VIEWS: [View, string][] = [["plan", "系統図"], ["cases", "冷凍・冷蔵"], ["hvac", "空調・照明"],
  ["demand", "電力デマンド"], ["alarms", "警報履歴"], ["commands", "操作履歴"]];
let S: State | null = null;
let view: View = VIEWS.some(([k]) => k === location.hash.slice(1)) ? (location.hash.slice(1) as View) : "plan";
let ackAlarms = 0;
let cmdCount = 0;

$("#menu").innerHTML = VIEWS.map(([k, n]) => `<button data-v="${k}">${n}</button>`).join("");
$$<HTMLButtonElement>("#menu button").forEach((b) => (b.onclick = () => { view = b.dataset.v as View; render(); }));

watch((s) => {
  const n = s.systems.bms.commands.length;
  if (S && n > cmdCount) toast(`外部連携: 制御コマンド ${n - cmdCount} 件を受信`);
  cmdCount = n;
  if (s.systems.bms.alarms.length < ackAlarms) ackAlarms = 0;
  S = s;
  render();
});

const kindName: Record<string, string> = { defrost: "霜取りスケジュール", setpoint: "設定温度", dim: "調光", output: "出力", precool: "予冷", revert: "通常に戻す" };

function render() {
  if (!S) return;
  const b = S.systems.bms;
  $$<HTMLButtonElement>("#menu button").forEach((x) => x.classList.toggle("on", x.dataset.v === view));
  $("#clock").textContent = b.now;
  const latest = b.history[b.history.length - 1];
  const unacked = b.alarms.slice(ackAlarms);
  const al = $("#alarm");
  al.className = "alarm" + (unacked.length ? " on" : "");
  al.innerHTML = unacked.length
    ? `▲ 警報 ${esc(unacked[unacked.length - 1].time)} ${esc(unacked[unacked.length - 1].text)}  現在値 ${unacked[unacked.length - 1].value}℃ <button id="ack">確認</button>`
    : `● 警報なし`;
  document.getElementById("ack")?.addEventListener("click", () => { ackAlarms = b.alarms.length; render(); });
  $("#status").innerHTML = `<span>デマンド ${latest.kw} kW / 契約 ${b.contract_kw} kW</span><span>外気温 ${b.sensors.OAT ?? "-"} ℃</span>
    <span>時刻つき設定 ${b.timed.length} 件</span><span>通信: 正常（上位連携 KINETIC）</span>`;
  const main = $("#main");
  const eff = b.effective;
  const eq = Object.fromEntries(b.equipment.map((e) => [e.id, e]));

  if (view === "plan") {
    main.innerHTML = `<div class="panel"><h3>系統図 ─ 売場</h3><div class="in plan">
      ${b.zones.map((z, i) => {
        const zt = `ZT-${i + 1}`, ahu = `AHU-${i + 1}`;
        const v = b.sensors[zt];
        const lz = b.equipment.filter((e) => e.type === "LightingZone" && e.zone === z.id);
        return `<div class="zone ${z.window ? "window" : ""}"><b>${esc(z.name)}</b><br>
          <span class="led ${v > 27 ? "warn" : ""}">${v.toFixed(1)}℃</span> <small>${zt}</small>
          <div class="eq"><span class="lamp on"></span>${ahu} 設定 ${eff[ahu].setpoint}℃${eff[ahu].setpoint !== eq[ahu].setpoint ? "（スケジュール）" : ""}</div>
          ${lz.map((l) => `<div class="eq"><span class="lamp ${eff[l.id].dim ? "amber" : "on"}"></span>${l.id} ${eff[l.id].dim ? `調光 ${eff[l.id].dim}%` : "点灯 100%"}</div>`).join("")}
        </div>`;
      }).join("")}
    </div></div>
    <div class="panel"><h3>系統図 ─ 冷凍・冷蔵ケース</h3><div class="in">
      <div class="eq">FZ-01 冷凍ケース <span class="led small ${b.sensors["FZ-01-T1"] > -18 ? "warn" : ""}">${b.sensors["FZ-01-T1"].toFixed(1)}℃</span>
        設定 ${eff["FZ-01"].setpoint}℃ ${eff["FZ-01"].precool ? "【予冷中】" : ""} 出力 ${eff["FZ-01"].output}%</div>
      <div class="cases" style="margin-top:8px">${Object.keys(b.defrost).map((rc) => `<div class="case ${eff[rc].defrosting ? "defrost" : ""}">
        <span class="lamp ${eff[rc].defrosting ? "amber" : "on"}"></span>${rc}<br>${eff[rc].defrosting ? "霜取中" : "冷却中"}</div>`).join("")}</div>
    </div></div>
    <div class="panel"><h3>受電点</h3><div class="in">EM-014 デマンド <span class="led ${latest.kw > b.contract_kw ? "warn" : ""}">${latest.kw} kW</span>
      契約電力 ${b.contract_kw} kW ／ 外気温 <span class="led small">${(b.sensors.OAT ?? 0).toFixed(1)}℃</span></div></div>`;
  } else if (view === "cases") {
    main.innerHTML = `<div class="panel"><h3>冷蔵ケース 霜取りスケジュール</h3><div class="in"><table class="grid">
      <tr><th>機器</th><th>名称</th><th>状態</th><th>霜取り時刻</th><th>霜取り電力</th></tr>
      ${Object.entries(b.defrost).map(([rc, hs]) => `<tr><td>${rc}</td><td>${esc(eq[rc].name)}</td><td>${eff[rc].defrosting ? "霜取中" : "冷却中"}</td>
        <td>${hs.map((h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`).join("  ")}</td><td>4 kW</td></tr>`).join("")}
      </table></div></div>
      <div class="panel"><h3>冷凍ケース FZ-01</h3><div class="in">庫内 <span class="led small">${b.sensors["FZ-01-T1"].toFixed(1)}℃</span>
        設定 ${eff["FZ-01"].setpoint}℃ ／ 出力 ${eff["FZ-01"].output}% ／ 自動範囲 ${eq["FZ-01"].auto_min}〜${eq["FZ-01"].auto_max}℃</div></div>`;
  } else if (view === "hvac") {
    main.innerHTML = `<div class="panel"><h3>空調機・照明 ─ 時刻つき設定（上位連携）</h3><div class="in"><table class="grid">
      <tr><th>機器</th><th>種別</th><th>値</th><th>開始</th><th>終了</th></tr>
      ${b.timed.map((t) => `<tr><td>${t.equipment}</td><td>${kindName[t.kind] ?? t.kind}</td><td>${t.value}</td><td>${t.from}</td><td>${t.to}</td></tr>`).join("") ||
        `<tr><td colspan="5">登録なし</td></tr>`}</table></div></div>
      <div class="panel"><h3>空調機 現在値</h3><div class="in"><table class="grid"><tr><th>機器</th><th>受持区画</th><th>設定</th><th>標準</th><th>自動範囲</th></tr>
      ${b.equipment.filter((e) => e.type === "AirHandlingUnit").map((e) => `<tr><td>${e.id}</td><td>${e.feeds}</td><td>${eff[e.id].setpoint}℃</td>
        <td>${e.setpoint}℃</td><td>${e.auto_min}〜${e.auto_max}℃</td></tr>`).join("")}</table></div></div>`;
  } else if (view === "demand") {
    main.innerHTML = `<div class="panel"><h3>電力デマンド トレンド（EM-014）</h3><div class="in">${trend(S)}</div></div>`;
  } else if (view === "alarms") {
    main.innerHTML = `<div class="panel"><h3>警報履歴</h3><div class="in"><table class="grid"><tr><th>発生</th><th>点</th><th>内容</th><th>値</th></tr>
      ${b.alarms.map((a) => `<tr><td>${a.time}</td><td>${a.sensor}</td><td>${esc(a.text)}</td><td>${a.value}℃</td></tr>`).join("") ||
        `<tr><td colspan="4">警報はありません</td></tr>`}</table></div></div>`;
  } else {
    main.innerHTML = `<div class="panel"><h3>操作履歴（上位連携からの制御コマンドを含む）</h3><div class="in"><table class="grid">
      <tr><th>時刻</th><th>操作元</th><th>機器</th><th>種別</th><th>内容</th></tr>
      ${b.commands.map((c) => `<tr><td>${c.time}</td><td class="ext">KINETIC</td><td>${c.equipment}</td><td>${kindName[c.kind] ?? c.kind}</td>
        <td>${c.kind === "defrost" ? (c.value as number[]).join(", ") : c.kind === "revert" ? "標準値へ" : `${c.value} (${c.from}〜${c.to})`}</td></tr>`).join("") ||
        `<tr><td colspan="5">操作はありません</td></tr>`}</table></div></div>`;
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
    <text x="${W - R - 4}" y="${y(b.contract_kw) - 6}" class="lbl" text-anchor="end">契約電力 ${b.contract_kw}kW</text>
    <text x="${x(14) + 4}" y="${T + 14}" class="lbl">ピーク時間帯</text>
    <polyline points="${pts}" class="line"/>
    <text x="${L + 4}" y="${T + 14}" class="ax">kW（15分デマンド）</text>
  </svg>`;
}
