// レイヤー5 店長アプリ（スマホ）。AI が自動で済ませたことを見せ、店長の判断が要るものだけを承認してもらう。
// 画面に出すのは、レイヤー3 の事前検証に合格した提案だけ。承認はレイヤー3 の SHACL で再検証される。
// UC1・UC2 は1号店の店長、UC3 は受け入れる2号店の店長が使う。
import "./modern.css";
import "./manager.css";
import { act, hasContext, storeName, watch, type Line, type State, type Transfer } from "../lib/api";
import { $, esc, toast } from "../lib/dom";
import { attachTooltips, orderRangeChart } from "./charts";

const STORE_OF: Record<string, string> = { "manager-ST014": "ST-014", "manager-ST031": "ST-031" };
let S: State | null = null;
let user = "";
let sending = false;

watch((s) => {
  user = s.scenario === "uc3" ? "manager-ST031" : "manager-ST014";
  S = s;
  render();
});

async function approve() {
  sending = true;
  render();
  const r = await act("approve");
  sending = false;
  if (!r.ok) return toast(r.message);
  S = r.state;
  const done = $("#done");
  done.hidden = false;
  setTimeout(() => (done.hidden = true), 1600);
  render();
}

const store = () => STORE_OF[user];
const mine = () => !!S?.approval_request && S.approval_request.approver === user;
const hour = (now: string) => Number(now.replace("翌 ", "").slice(0, 2));

function render() {
  if (!S) return;
  $("#clock").textContent = S.now.replace("翌 ", "");
  $("#store").textContent = `${storeName(store())} ・ ${store()}`;
  $("#avatar").textContent = storeName(store()).replace("号店", "");
  const h = hour(S.now);
  $("#hello").textContent = `${S.now.startsWith("翌") || h < 11 ? "おはようございます" : h < 17 ? "こんにちは" : "おつかれさまです"}、店長`;
  const el = $("#screen");
  el.innerHTML = hero() + (mine() ? approval() : "") + timeline();
  document.getElementById("approve")?.addEventListener("click", () => void approve());
  attachTooltips(el);
}

// ---- いちばん上のカード（今日の仕事のまとめ） -------------------------------------

/** AI が方針の範囲内で自動で確定した件数と、店長の判断が要る件数。 */
function counts(): [number, number] {
  const s = S!;
  const auto = s.audit.filter((a) => !a.agent.startsWith("manager")).length + (s.uc2?.notifications.length ?? 0);
  return [auto, mine() ? s.approval_request!.lines.length : 0];
}

function hero(): string {
  const s = S!;
  const [auto, need] = counts();
  const head = (eyebrow: string, title: string, body: string) =>
    `<section class="hero"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${body}
      <div class="tally"><div><b>${auto}</b><span>AI が自動で処理</span></div><div class="${need ? "need" : ""}"><b>${need}</b><span>あなたの判断</span></div></div></section>`;

  if (s.scenario === "uc1") {
    const ctx = hasContext(s.context) ? s.context : null;
    const ev = ctx?.events.find((e) => e.nearby);
    const title = ({ 待機: "10:00 に AI が発注を作ります", 承認待ち: need ? `${need}品だけ確認してください` : "承認を待っています",
      締め待ち: "明日の発注は確定しました", 完了: "今朝の入荷は検品済みです" } as Record<string, string>)[s.workflow_state] ?? "";
    const chips = ctx ? `<div class="chips">
        ${ev ? `<span class="chip-lg">⚽ ${esc(ev.label.replace(/の.*$/, ""))} ${(ev.attendance / 10000).toFixed(0)}万人</span>` : ""}
        <span class="chip-lg">☀ 最高 ${ctx.max_temp}℃</span>
        ${Object.values(ctx.products).filter((p) => p.reasons.includes("明日発売")).map((p) => `<span class="chip-lg">✦ ${esc(p.name)} 発売</span>`).join("")}
      </div>` : "";
    return head("明日 10/24（土）の発注", title, chips);
  }
  if (s.scenario === "uc2") {
    const c = s.uc2!.context;
    const b = s.systems.bms;
    const latest = b.history[b.history.length - 1];
    const title = ({ 待機: "12:30 に AI が調整を決めます", 実行待ち: "今日の調整は AI が決めました", 実行中: "ピークを AI が見張っています",
      完了: "今日も契約電力の範囲内でした" } as Record<string, string>)[s.workflow_state] ?? "";
    const body = `<div class="power">
        <div class="kw"><b>${latest.kw}</b><span>kW いま</span></div>
        ${c.projected_kw ? `<div class="saved"><s>${c.projected_kw}</s> → <b>${c.planned_kw}</b> kW<span>何もしないとき → AI の計画</span></div>` : ""}
      </div>${spark(b.history.map((r) => r.kw), b.contract_kw)}`;
    return head(`今日 ${s.day.slice(5).replace("-", "/")} の電力`, title, body);
  }
  const u = s.uc3!;
  const inbound = u.transfers.filter((t) => t.dest === store());
  const title = mine() ? `${need}件だけ確認してください` : inbound.length ? `今夜 ${inbound.length} 便が届きます` : "16:00 に AI が融通を決めます";
  const body = inbound.length ? `<div class="chips">${inbound.map((t) =>
    `<span class="chip-lg">🚚 ${esc(t.name)} ${t.quantity} ・ ${t.eta}</span>`).join("")}</div>` : "";
  return head(`今日 ${s.day.slice(5).replace("-", "/")} の夕方`, title, body);
}

/** デマンドの小さな折れ線。契約電力を点線で引く。 */
function spark(values: number[], contract: number): string {
  if (values.length < 2) return "";
  const W = 300, H = 56, lo = 700, hi = 860;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="デマンドの推移">
    <line x1="0" x2="${W}" y1="${y(contract)}" y2="${y(contract)}" class="limit"/>
    <polygon points="0,${H} ${pts} ${W},${H}" class="area"/><polyline points="${pts}" class="ln"/></svg>`;
}

// ---- 承認のカード ----------------------------------------------------------------

function approval(): string {
  const a = S!.approval_request!;
  const isTransfer = a.kind === "transfer";
  return `<section class="card ask">
      <div class="ask-head"><span class="pulse"></span>判断が必要です</div>
      <p class="ask-msg">${esc(a.message)}</p>
      ${isTransfer ? (a.lines as Transfer[]).map(transferItem).join("") : (a.lines as Line[]).map(lineItem).join("")}
      <div class="ai-note">🛡 AI の案は本部のルール点検に合格済みです</div>
    </section>
    <div class="cta"><button class="btn" id="approve" ${sending ? "disabled" : ""}>${sending ? "送信中…" : isTransfer ? "受け入れる" : `${a.lines.length}品の発注を承認`}</button></div>`;
}

function lineItem(l: Line): string {
  const reasons = l.reason.replace(/近くのイベント E-\d+/, "近くの試合").split("、");
  return `<div class="item">
    <div class="item-top">
      <div><div class="name">${esc(l.name)}</div><div class="reasons">${reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div></div>
      <div class="qty">${l.recommended != null ? `<s>${l.recommended}</s>` : ""}<b>${l.quantity}</b>${l.ratio ? `<em>×${l.ratio}</em>` : ""}</div>
    </div>
    <div class="viz">${orderRangeChart([l], 400, true)}</div>
  </div>`;
}

function transferItem(t: Transfer): string {
  const est = S!.uc3!.context.estimates?.find((e) => e.store === store() && e.product === t.product);
  return `<div class="route">
      <div class="stop"><b>${storeName(t.source)}</b><span>余り</span></div>
      <div class="truck"><span>🚚 ${t.vehicle}</span><i></i><span>${t.eta} 着</span></div>
      <div class="stop me"><b>${storeName(t.dest)}</b><span>あなたの店</span></div>
    </div>
    <div class="item-top"><div class="name">${esc(t.name)}</div><div class="qty"><b>${t.quantity}</b></div></div>
    ${est ? `<div class="reasons"><span>在庫 ${est.stock}</span><span>閉店まで ${est.rest} 売れる見込み</span>${est.runout ? `<span>${Math.floor(est.runout)}時ごろ品切れ</span>` : ""}</div>` : ""}`;
}

// ---- お知らせ ------------------------------------------------------------------

function timeline(): string {
  const s = S!;
  const items = [
    ...s.audit.map((a) => ({ time: a.time, title: a.label, body: a.rule ?? "", kind: a.agent.startsWith("manager") ? "ok" : "auto" })),
    ...(s.uc2?.notifications ?? []).map((n) => ({ time: n.time, title: n.title, body: n.body, kind: n.title.includes("戻しました") ? "warn" : "auto" })),
  ].sort((x, y) => y.time.localeCompare(x.time));
  const icon: Record<string, string> = { ok: "✓", auto: "⚡", warn: "↺" };
  return `<section class="card"><h2>AI がやったこと</h2>
    ${items.map((n) => `<div class="tl ${n.kind}"><div class="dot">${icon[n.kind]}</div>
      <div><b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ""}</div><time>${esc(n.time)}</time></div>`).join("")
      || `<div class="empty-tl"><div>☕</div>まだ何もありません。<br>AI が動いたら、ここに届きます。</div>`}
  </section>`;
}
