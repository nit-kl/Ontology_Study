// レイヤー1 スタッフ端末（ハンディターミナル風）。KINETIC から届いた作業を受け、翌朝の入荷検品をスキャンする。
// 入荷検品の完了は、KINETIC にイベントとして届く（デモでは /api/advance を呼ぶ）。
import "./handy.css";
import { act, productName, storeName, watch, type State } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";

type Scr = "menu" | "tasks" | "receive" | "stock";
const STORES = ["ST-014", "ST-031", "ST-040"];
let STORE = new URLSearchParams(location.search).get("store") ?? "ST-014";
let S: State | null = null;
let scr: Scr = (["menu", "tasks", "receive", "stock"] as const).find((k) => k === location.hash.slice(1)) ?? "menu";
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
  if (k === "CLR" || k === "F4") scr = "menu";
  else if (k === "F1" && scr === "menu") STORE = STORES[(STORES.indexOf(STORE) + 1) % STORES.length];
  else if (scr === "menu" && ["1", "2", "3"].includes(k)) scr = ({ "1": "tasks", "2": "receive", "3": "stock" } as Record<string, Scr>)[k];
  else if (k === "SCAN" || (k === "ENT" && scr === "receive")) {
    scr = "receive";
    void scanReceive();
  }
  render();
}

$$<HTMLElement>(".keys b").forEach((b) => (b.onclick = () => key(b.dataset.k!)));
document.addEventListener("keydown", (e) => {
  const map: Record<string, string> = { Escape: "CLR", Enter: "ENT", " ": "SCAN" };
  if (/^[0-9]$/.test(e.key)) key(e.key);
  else if (map[e.key]) { e.preventDefault(); key(map[e.key]); }
});

watch((s) => {
  const n = s.systems.staff_tasks.length;
  if (S && n > taskCount) { toast("新しい作業を受信しました"); beep(); }
  taskCount = n;
  S = s;
  render();
});

function render() {
  if (!S) return;
  $("#cetime").textContent = S.now;
  const lcd = $("#lcd");
  const tasks = S.systems.staff_tasks.filter((t) => t.store === STORE);
  const incoming = S.systems.pos_incoming[STORE] ?? {};
  const order = S.systems.sap_orders["STO-0141"]?.lines ?? {};
  const soft = (labels: string[]) => ($("#softkeys").innerHTML = labels.map((l) => `<span>${esc(l)}</span>`).join(""));

  if (scr === "menu") {
    $("#apptitle").textContent = `店舗作業メニュー  ${storeName(STORE)}`;
    lcd.innerHTML = `
      <button class="menuitem" data-k="1"><b>1</b>作業一覧（${tasks.filter((t) => !t.done).length}件）</button>
      <button class="menuitem" data-k="2"><b>2</b>入荷検品</button>
      <button class="menuitem" data-k="3"><b>3</b>在庫照会</button>
      <div class="msg">番号キーで選択してください<br>F1 で店舗を切り替え（いま: ${storeName(STORE)}）</div>`;
    $$<HTMLElement>(".menuitem", lcd).forEach((b) => (b.onclick = () => key(b.dataset.k!)));
    soft(["F1:店舗", "F2:-", "F3:-", "F4:戻る"]);
  } else if (scr === "tasks") {
    $("#apptitle").textContent = "作業一覧";
    lcd.innerHTML = tasks.length
      ? tasks.map((t) => `<div class="task ${t.done ? "done" : ""}"><span class="when">${esc(t.when)}</span><br>${esc(t.text)}${t.result ? `<br>→ ${esc(t.result)}` : ""}</div>`).join("")
      : `<div class="msg">作業はありません</div>`;
    soft(["F1:-", "F2:-", "F3:-", "F4:戻る"]);
  } else if (scr === "receive") {
    if (S.scenario !== "uc1") {
      $("#apptitle").textContent = `入荷検品  ${storeName(STORE)}`;
      const stops = S.systems.tms.stops.filter((x) => x.store === STORE);
      lcd.innerHTML = stops.length ? `<table class="list"><tr><th>便・内容</th><th>時刻</th></tr>
        ${stops.map((x) => `<tr class="${x.status === "完了" ? "ok" : ""}"><td>${x.vehicle} ${esc(x.purpose)}</td><td class="n">${x.status === "完了" ? "✔ " : ""}${x.time}</td></tr>`).join("")}</table>
        <div class="msg">便が着いた時刻に、届いたケースをスキャンします（司令塔で時刻を進める）</div>`
        : `<div class="msg">この店への入荷予定はありません</div>`;
      soft(["F1:-", "F2:-", "SCAN:-", "F4:戻る"]);
      return;
    }
    $("#apptitle").textContent = "入荷検品  STO-0141";
    const done = S.workflow_state === "完了";
    const rows = done ? order : incoming;
    const can = S.workflow_state === "締め待ち" && STORE === "ST-014";
    lcd.innerHTML = `
      <div>納品元: DC-01 東部DC<br>納品予定: 10/24 06:30</div>
      ${Object.keys(rows).length ? `<table class="list"><tr><th>商品</th><th>数</th></tr>
        ${Object.entries(rows).map(([p, q]) => `<tr class="${done ? "ok" : ""}"><td>${esc(productName(S!, p))}</td><td class="n">${done ? "✔ " : ""}${q}</td></tr>`).join("")}</table>`
        : `<div class="msg">入荷予定はまだありません</div>`}
      ${done ? `<div class="msg ok">検品完了。POS の在庫に反映しました。</div>`
        : `<button class="bigbtn" id="scan" ${can && !busy ? "" : "disabled"}>${busy ? "送信中…" : "SCAN で検品開始"}</button>
           <div class="msg">${can ? "翌朝 06:40、納品されたケースをスキャンします" : "発注の締め（11:00）のあとに検品できます"}</div>`}`;
    document.getElementById("scan")?.addEventListener("click", () => void scanReceive());
    soft(["F1:-", "F2:-", "SCAN:検品", "F4:戻る"]);
  } else {
    $("#apptitle").textContent = "在庫照会";
    const stock = S.systems.pos_stock[STORE] ?? {};
    lcd.innerHTML = `<table class="list"><tr><th>商品</th><th>在庫</th></tr>
      ${Object.entries(stock).map(([p, q]) => `<tr><td>${esc(productName(S!, p))}</td><td class="n">${q}</td></tr>`).join("")}</table>`;
    soft(["F1:-", "F2:-", "F3:-", "F4:戻る"]);
  }
}
