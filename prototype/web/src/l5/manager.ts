// レイヤー5 店長アプリ（スマホ・タブレット）。承認の依頼を受けて承認し、自動で動いたことの知らせを受ける。
// 画面に出すのは、レイヤー3 の事前検証に合格した提案だけ。承認はレイヤー3 の SHACL で再検証される。
// UC1 と UC2 は1号店の店長、UC3 は受け入れる2号店の店長が使う。右上のアイコンで切り替える。
import "./modern.css";
import "./manager.css";
import { act, hasContext, storeName, watch, type Line, type State, type Transfer } from "../lib/api";
import { $, $$, esc, toast } from "../lib/dom";
import { attachTooltips, legend, orderRangeChart } from "./charts";

type Tab = "home" | "approve" | "notices";
const USERS = [{ id: "manager-ST014", store: "ST-014" }, { id: "manager-ST031", store: "ST-031" }];
let S: State | null = null;
let tab: Tab = (["home", "approve", "notices"] as const).find((k) => k === location.hash.slice(1)) ?? "home";
let user = loadUser();
let sending = false;
let seenRequest = "";

function loadUser(): string {
  try {
    return localStorage.getItem("manager-user") ?? USERS[0].id;
  } catch {
    return USERS[0].id;
  }
}

function setUser(id: string) {
  user = id;
  try {
    localStorage.setItem("manager-user", id);
  } catch {
    /* 保存できない環境では、このページを開いている間だけ覚える */
  }
}

const me = () => USERS.find((u) => u.id === user)!;
const mine = (s: State) => !!s.approval_request && s.approval_request.approver === user;

$(".avatar").addEventListener("click", () => {
  setUser(USERS[(USERS.findIndex((u) => u.id === user) + 1) % USERS.length].id);
  toast(`${storeName(me().store)}の店長に切り替えました`);
  render();
});

watch((s) => {
  // 自分宛ての依頼が新しく届いたら、承認のタブへ。シナリオに合わせて使う人も切り替える
  if (s.approval_request && s.approval_request.approver !== user && USERS.some((u) => u.id === s.approval_request!.approver)) {
    setUser(s.approval_request.approver);
  }
  const key = s.approval_request ? `${s.scenario}:${s.approval_request.plan}:${s.approval_request.lines.length}` : "";
  if (key && key !== seenRequest && S) {
    toast("承認の依頼が届きました");
    tab = "approve";
  }
  seenRequest = key;
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
  toast("承認しました");
  render();
}

function render() {
  if (!S) return;
  $(".eyebrow").textContent = `${storeName(me().store)} ・ ${me().store}`;
  $(".avatar").textContent = storeName(me().store).replace("店", "");
  $(".hello").textContent = `${greeting(S.now)}、店長`;
  const tabs: [Tab, string, string][] = [["home", "⌂", "ホーム"], ["approve", "✓", "承認"], ["notices", "🔔", "お知らせ"]];
  $("#tabbar").innerHTML = tabs.map(([k, ic, n]) => `<button class="${k === tab ? "on" : ""}" data-k="${k}"><span class="ic">${ic}</span>${n}
    ${k === "approve" && mine(S!) ? `<span class="badge">${S!.approval_request!.lines.length}</span>` : ""}</button>`).join("");
  $$<HTMLButtonElement>("#tabbar button").forEach((b) => (b.onclick = () => { tab = b.dataset.k as Tab; render(); }));
  const el = $("#screen");
  ({ home: vHome, approve: vApprove, notices: vNotices })[tab](el);
  attachTooltips(el);
}

function greeting(now: string) {
  const h = Number(now.replace("翌 ", "").slice(0, 2));
  return now.startsWith("翌") || h < 11 ? "おはようございます" : h < 17 ? "こんにちは" : "おつかれさまです";
}

function hero(eyebrow: string, title: string, body: string, stats: [string | number, string][]) {
  return `<section class="card hero"><div class="eyebrow">${eyebrow}</div><h2>${title}</h2><p>${body}</p>
    <div class="stats">${stats.map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("")}</div></section>`;
}

function vHome(el: HTMLElement) {
  const s = S!;
  const pendingMine = mine(s);
  const cta = pendingMine ? `<button class="btn" id="go-approve">承認の依頼を見る（${s.approval_request!.lines.length}件）</button>` : "";
  if (s.scenario === "uc1") {
    const lines = s.plan?.lines ?? [];
    const ctx = hasContext(s.context) ? s.context : null;
    const ev = ctx?.events.find((e) => e.nearby);
    const title = ({ 待機: "明日の発注は 10:00 に作られます", 承認待ち: "明日の発注に、あなたの承認が要ります",
      締め待ち: "明日の発注は確定しました", 完了: "今朝の入荷は検品済みです", 失敗: "発注の作成が止まりました" } as Record<string, string>)[s.workflow_state] ?? "";
    el.innerHTML = hero(`明日 10/24（土）の発注 ・ ${esc(s.now)}`, title,
      s.workflow_state === "承認待ち" ? "ふだんより大きく増やす品目だけ確認してください。" : "方針の範囲内の品目は自動で確定します。",
      [[s.audit.filter((a) => a.agent === "OrderPolicy").flatMap((a) => a.generated).length, "自動で確定"],
       [lines.filter((l) => l.status === "承認待ち").length, "承認待ち"],
       [lines.reduce((n, l) => n + (l.status === "確定" ? l.quantity : 0), 0).toLocaleString(), "確定した数量"]]) + cta + `
      <section class="card"><h2>明日の事情</h2><p class="sub">本部のナレッジグラフが見つけたこと</p>
      ${ctx ? `<div class="context">
        <div class="ic">⚽</div><div><b>${ev ? esc(ev.label) : "近くの大きなイベントはなし"}</b>
          <span>${ev ? `18:00 開始 ・ ${ev.attendance.toLocaleString()}人 ・ 店から ${ev.km}km` : ""}</span></div>
        <div class="ic">☀</div><div><b>予報 最高 ${ctx.max_temp}℃</b><span>暑い日の基準は ${ctx.policy.th}℃</span></div>
        <div class="ic">✦</div><div><b>${Object.values(ctx.products).filter((p) => p.reasons.includes("明日発売")).map((p) => esc(p.name)).join("、") || "新商品なし"}</b>
          <span>明日発売</span></div></div>` : `<p class="empty">10:00 の発注の作成のあとに表示されます</p>`}</section>`;
  } else if (s.scenario === "uc2") {
    const c = s.uc2!.context;
    const latest = s.systems.bms.history[s.systems.bms.history.length - 1];
    const title = ({ 待機: "今日の電力調整は 12:30 に決まります", 実行待ち: "今日の電力調整が決まりました（自動）",
      実行中: "電力調整を実行中です", 完了: "今日のピークは契約電力の範囲内でした", 失敗: "調整の作成が止まりました" } as Record<string, string>)[s.workflow_state] ?? "";
    el.innerHTML = hero(`今日 ${s.day.slice(5).replace("-", "/")} の電力 ・ ${esc(s.now)}`, title,
      "方針の範囲内の調整なので、承認は要りません。外れたら、その設備だけ自動で元に戻します。",
      [[c.projected_kw ? `${c.projected_kw}` : "―", "何もしないとき kW"], [c.planned_kw ? `${c.planned_kw}` : "―", "計画 kW"], [`${latest.kw}`, "いま kW"]]) +
      `<section class="card"><h2>最新のお知らせ</h2><p class="sub">自動で動いたことは、すべて届きます</p>${noticeList(4)}</section>`;
  } else {
    const u = s.uc3!;
    const incoming = u.transfers.filter((t) => t.dest === me().store);
    const outgoing = u.transfers.filter((t) => t.source === me().store);
    const title = me().store === "ST-031" ? (pendingMine ? "今夜の受け入れに、あなたの承認が要ります" : incoming.length ? "今夜、ほかの店から商品が届きます" : "今夜の在庫融通は 16:00 に決まります")
      : outgoing.length ? "今夜、2号店へ商品を送ります" : "今夜の在庫融通は 16:00 に決まります";
    el.innerHTML = hero(`今日 ${s.day.slice(5).replace("-", "/")} の夕方 ・ ${esc(s.now)}`, title,
      "上限以内の移動と見切りは自動で確定します。上限を超える受け入れだけ、受け入れる店の店長が承認します。",
      [[incoming.length, "受け入れ"], [outgoing.length, "送り出し"], [u.markdowns.filter((m) => m.store === me().store).length, "見切り"]]) + cta +
      `<section class="card"><h2>${storeName(me().store)}に関わる移動</h2><p class="sub">ネットスーパー配送車の帰り便で運びます</p>
        ${[...incoming, ...outgoing].map(transferItem).join("") || `<p class="empty">16:00 の案のあとに表示されます</p>`}</section>`;
  }
  document.getElementById("go-approve")?.addEventListener("click", () => { tab = "approve"; render(); });
}

function transferItem(t: Transfer & { why?: string }) {
  const inbound = t.dest === me().store;
  return `<div class="item">
    <div><div class="name">${esc(t.name)}</div><div class="muted">${inbound ? `${storeName(t.source)}から` : `${storeName(t.dest)}へ`} ・ ${t.vehicle} ${t.eta} 着</div></div>
    <div class="qty"><b>${t.quantity}</b></div>
    ${t.why ? `<div class="why"><span class="pill warn">⚠ ${esc(t.why.split("。")[0])}</span></div>` : `<div class="why"><span class="pill ${t.status.includes("済") || t.status === "確定" ? "good" : ""}">${esc(t.status)}</span> ${t.history.map(esc).join(" ")}</div>`}
  </div>`;
}

function lineItem(l: Line & { why?: string }) {
  return `<div class="item">
    <div><div class="name">${esc(l.name)}</div><div class="muted">${esc(l.reason)}</div></div>
    <div class="qty">${l.recommended != null ? `<s>${l.recommended}</s>` : ""}<b>${l.quantity}</b></div>
    <div class="viz">${orderRangeChart([l], 400, true)}</div>
    ${l.why ? `<div class="why">${l.ratio ? `<span class="pill warn">⚠ 推奨数の ${l.ratio} 倍</span> ` : ""}${esc(l.forecast?.basis ?? "")}</div>` : ""}
  </div>`;
}

function vApprove(el: HTMLElement) {
  const s = S!;
  const a = s.approval_request;
  if (!a || a.approver !== user) {
    const ok = [...s.audit].reverse().find((x) => x.agent === user);
    el.innerHTML = `<section class="card done">
      <div class="check">${ok ? "✓" : "…"}</div>
      <h2>${ok ? "承認済み" : a ? `この依頼は${esc(a.approver_label)}宛てです` : "承認の依頼はありません"}</h2>
      <p class="muted">${ok ? `${ok.time} に承認しました。本部と店のシステムに反映されています。` : a ? "右上のアイコンで切り替えられます。" : "依頼が届くと、ここに表示されます。"}</p>
    </section>`;
    return;
  }
  const isTransfer = a.kind === "transfer";
  const est = isTransfer ? s.uc3!.context.estimates?.find((e) => e.store === me().store && e.product === (a.lines[0] as Transfer).product) : null;
  el.innerHTML = `
    <section class="card">
      <div class="eyebrow">承認の依頼 ・ ${esc(a.plan)}</div>
      <h2 style="margin-top:6px">${esc(a.message)}</h2>
      <p class="sub">本部の点検（SHACL）は合格済み。${isTransfer ? "上限（50個かつ15,000円）を超える受け入れなので、受け入れる店の店長の承認が要ります。" : "推奨数の1.5倍を超えるので、店長の承認が要ります。"}</p>
      ${isTransfer ? (a.lines as (Transfer & { why: string })[]).map(transferItem).join("") +
        (est ? `<div class="context" style="margin-top:12px"><div class="ic">📦</div><div><b>いまの在庫 ${est.stock}、閉店までに売れる見込み ${est.rest}</b>
          <span>${est.runout ? `${Math.floor(est.runout)}時ごろ品切れの見込み ・ ` : ""}足りない数 ${-est.balance}</span></div></div>` : "")
        : legend() + (a.lines as (Line & { why: string })[]).map(lineItem).join("")}
    </section>
    <div class="cta">
      <button class="btn" id="approve" ${sending ? "disabled" : ""}>${sending ? "送信中…" : isTransfer ? "受け入れを承認する" : `${a.lines.length}品の発注を承認する`}</button>
    </div>`;
  $("#approve").onclick = () => void approve();
}

function noticeList(limit = 50): string {
  const s = S!;
  const fromAudit = s.audit.map((a) => ({ time: a.time, title: a.label, body: `${a.agent.startsWith("manager") ? "店長が承認" : "方針により自動"}${a.rule ? ` ・ ${a.rule}` : ""}`,
    approved: a.agent.startsWith("manager"), chips: a.generated.map((g) => g.split("/").pop()!) }));
  const fromUc2 = (s.uc2?.notifications ?? []).map((n) => ({ time: n.time, title: n.title, body: n.body, approved: false, chips: [] as string[] }));
  const items = [...fromAudit, ...fromUc2].sort((x, y) => y.time.localeCompare(x.time)).slice(0, limit);
  return items.length ? items.map((n) => `<div class="notice"><div class="dot">${n.approved ? "✓" : "⚙"}</div>
    <div><b>${esc(n.title)}</b><span>${esc(n.time)} ・ ${esc(n.body)}</span>
    <div>${n.chips.slice(0, 6).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}${n.chips.length > 6 ? `<span class="chip">ほか ${n.chips.length - 6}</span>` : ""}</div></div></div>`).join("")
    : `<p class="empty">まだお知らせはありません</p>`;
}

function vNotices(el: HTMLElement) {
  el.innerHTML = `<section class="card"><h2>お知らせ</h2><p class="sub">自動で確定したことも、すべてここに届きます</p>${noticeList()}</section>`;
}
