// レイヤー1 スタッフ端末（ハンディターミナル風）。KINETIC から届いた作業を受け、翌朝の入荷検品をスキャンする。
// 入荷検品の完了は、KINETIC にイベントとして届く（デモでは /api/advance を呼ぶ）。
import "./handy.css";
import { act, productName, storeName, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type Scr = "menu" | "tasks" | "receive";
const STORES = ["ST-014", "ST-031", "ST-040"];
let STORE = new URLSearchParams(location.search).get("store") ?? "ST-014";
let S: State | null = null;
let scr: Scr = (["menu", "tasks", "receive"] as const).find((k) => k === location.hash.slice(1)) ?? "menu";
let taskCount = 0;
let busy = false;

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 2200;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.08);
  } catch {
    /* 音が出せない環境では鳴らさない */
  }
}

async function scanReceive() {
  if (!S || S.scenario !== "uc1" || S.workflow_state !== "締め待ち" || busy) return;
  busy = true;
  render();
  beep();
  const r = await act("advance");
  busy = false;
  if (!r.ok) return toast(r.message);
  S = r.state;
  beep();
  render();
}

function key(k: string) {
  if (k === "CLR") scr = "menu";
  else if (k === "F1") STORE = STORES[(STORES.indexOf(STORE) + 1) % STORES.length];
  else if (k === "1" || k === "2") scr = k === "1" ? "tasks" : "receive";
  else if (k === "SCAN" || (k === "ENT" && scr === "receive")) {
    scr = "receive";
    void scanReceive();
  }
  render();
}

$$<HTMLElement>(".keys b").forEach((b) => (b.onclick = () => key(b.dataset.k!)));
document.addEventListener("keydown", (e) => {
  const map: Record<string, string> = { Escape: "CLR", Enter: "ENT", " ": "SCAN" };
  if (/^[12]$/.test(e.key)) key(e.key);
  else if (map[e.key]) { e.preventDefault(); key(map[e.key]); }
});

watch((s) => {
  const n = s.systems.staff_tasks.length;
  if (S && n > taskCount) { toast("作業を受信"); beep(); }
  taskCount = n;
  S = s;
  render();
});

function render() {
  if (!S) return;
  const lcd = $("#lcd");
  const tasks = S.systems.staff_tasks.filter((t) => t.store === STORE);
  const incoming = S.systems.pos_incoming[STORE] ?? {};
  const order = S.systems.sap_orders["STO-0141"]?.lines ?? {};
  $("#apptitle").textContent = `${storeName(STORE)}  ${S.now}`;

  if (scr === "menu") {
    lcd.innerHTML = `
      <button class="menuitem" data-k="1"><b>1</b>作業（${tasks.filter((t) => !t.done).length}）</button>
      <button class="menuitem" data-k="2"><b>2</b>入荷検品</button>`;
    $$<HTMLElement>(".menuitem", lcd).forEach((b) => (b.onclick = () => key(b.dataset.k!)));
  } else if (scr === "tasks") {
    lcd.innerHTML = tasks.map((t) => `<div class="task ${t.done ? "done" : ""}"><span class="when">${esc(t.when)}</span><br>${esc(t.text)}${t.result ? `<br>→ ${esc(t.result)}` : ""}</div>`).join("");
  } else if (S.scenario !== "uc1") {
    const stops = S.systems.tms.stops.filter((x) => x.store === STORE);
    lcd.innerHTML = stops.length ? `<table class="list">
      ${stops.map((x) => `<tr class="${x.status === "完了" ? "ok" : ""}"><td>${x.vehicle} ${esc(x.purpose)}</td><td class="n">${x.status === "完了" ? "✔ " : ""}${x.time}</td></tr>`).join("")}</table>` : "";
  } else {
    const done = S.workflow_state === "完了";
    const rows = done ? order : incoming;
    const can = S.workflow_state === "締め待ち" && STORE === "ST-014";
    lcd.innerHTML = `
      ${Object.keys(rows).length ? `<table class="list">
        ${Object.entries(rows).map(([p, q]) => `<tr class="${done ? "ok" : ""}"><td>${esc(productName(S!, p))}</td><td class="n">${done ? "✔ " : ""}${q}</td></tr>`).join("")}</table>` : ""}
      ${done ? "" : `<button class="bigbtn" id="scan" ${can && !busy ? "" : "disabled"}>${busy ? "…" : "SCAN"}</button>`}`;
    document.getElementById("scan")?.addEventListener("click", () => void scanReceive());
  }
}
