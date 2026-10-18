// レイヤー5 ガバナンス・コンソール。監査グラフ（PROV-O）の来歴、SHACL の規則の働き、ODRL の権限を見る。
import "./modern.css";
import "./governance.css";
import { productName, watch, type AuditEntry, type State } from "../lib/api";
import { $, esc } from "../lib/dom";

let S: State | null = null;
let selected = "";
let ruleNames: string[] = [];

fetch("/api/shapes").then((r) => r.text()).then((ttl) => {
  ruleNames = [...new Set([...ttl.matchAll(/sh:name\s+"([^"]+)"/g)].map((m) => m[1]))];
  if (S) renderRules();
});

$("#toggle").onclick = () => {
  const p = $("#turtle");
  p.hidden = !p.hidden;
  $("#toggle").textContent = p.hidden ? "Turtle を表示" : "Turtle を隠す";
};
$<HTMLSelectElement>("#linesel").onchange = (e) => { selected = (e.target as HTMLSelectElement).value; renderLineage(); };

watch((s) => { S = s; render(); });

// 監査グラフの明細の ID から、計画の番号（OP-0141/ など）を外す
const lineId = (g: string) => g.replace(/^(OP|PS)-\d+\//, "");
const lineLabel = (id: string) => { const n = productName(S!, id); return n === id ? id : `${id} ${n}`; };
const AGENTS: Record<string, string> = {
  "manager-ST014": "1号店の店長", "manager-ST031": "2号店の店長", "manager-ST040": "3号店の店長",
  OrderPolicy: "発注の方針（自動）", PeakPolicy: "電力ピークの方針（自動）", TransferPolicy: "在庫融通の方針（自動）",
};
const agentLabel = (a: string) => AGENTS[a] ?? a;
const usedLabel = (u: string) =>
  u.startsWith("v") ? `需要予測モデル ${u}` : u.startsWith("E-") ? `イベント ${u}` : u.startsWith("EM-") ? `電力メーター ${u}`
    : u.startsWith("V-") ? `配送車 ${u}（今夜のルート）` : u.startsWith("ST-") ? `店 ${u}`
    : u.includes("/") ? `予報 ${u.replace("/", " ")}` : u;

function render() {
  if (!S) return;
  $("#now").textContent = S.now;
  const products = [...new Set(S.audit.flatMap((a) => a.generated.map(lineId)))];
  if (!products.includes(selected)) {
    // 人の承認か、後から直したものがある明細を先に選ぶ（来歴が一番おもしろい）
    const counts = new Map(products.map((p) => [p, S!.audit.filter((a) => a.generated.some((g) => lineId(g) === p)).length]));
    selected = [...products].sort((a, b) => (counts.get(b)! - counts.get(a)!))[0] ?? "";
  }
  $("#linesel").innerHTML = products.map((p) => `<option value="${p}" ${p === selected ? "selected" : ""}>${esc(lineLabel(p))}</option>`).join("");
  renderLineage();
  renderActivities();
  renderRules();
  renderPerms();
  $("#turtle").textContent = S.audit_turtle;
}

function renderLineage() {
  const el = $("#lineage");
  if (!selected) return void (el.innerHTML = `<p class="empty">発注が確定すると、来歴が残ります</p>`);
  const acts = S!.audit.filter((a) => a.generated.some((g) => lineId(g) === selected));
  const used = [...new Set(acts.flatMap((a) => a.used))];
  const line = S!.plan?.lines.find((l) => l.product === selected);
  const W = 960, nodeW = 220, nodeH = 52, gap = 16;
  const colX = [20, 370, 720];
  const rows = Math.max(used.length, acts.length * 2, 1);
  const H = rows * (nodeH + gap) + 30;
  const yAt = (i: number, n: number) => (H - n * (nodeH + gap) + gap) / 2 + i * (nodeH + gap);
  const node = (x: number, y: number, kind: string, k: string, t: string) =>
    `<g class="node ${kind}"><rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="12"/>
      <text x="${x + 14}" y="${y + 20}" class="k">${esc(k)}</text><text x="${x + 14}" y="${y + 38}">${esc(t)}</text></g>`;
  const edge = (x1: number, y1: number, x2: number, y2: number, label: string) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" class="edge"/>
      <text x="${mx}" y="${(y1 + y2) / 2 - 6}" class="elabel" text-anchor="middle">${label}</text>`;
  };
  const lineY = yAt(0, 1);
  const actNodes: string[] = [], edges: string[] = [];
  acts.forEach((a, i) => {
    const y = yAt(i * 2, acts.length * 2);
    actNodes.push(node(colX[1], y, "act", `prov:Activity ・ ${a.time}`, shorten(a.label, 16)));
    actNodes.push(node(colX[1], y + nodeH + gap, "agent", "prov:wasAssociatedWith", agentLabel(a.agent)));
    edges.push(edge(colX[1] + nodeW, y + nodeH / 2, colX[2], lineY + nodeH / 2, "wasGeneratedBy"));
    a.used.forEach((u) => {
      const ui = used.indexOf(u);
      edges.push(edge(colX[0] + nodeW, yAt(ui, used.length) + nodeH / 2, colX[1], y + nodeH / 2, i === 0 && ui === 0 ? "used" : ""));
    });
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="flow" role="img" aria-label="発注の明細の来歴">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor" style="color: var(--text-3)"/></marker></defs>
    ${edges.join("")}
    ${used.map((u, i) => node(colX[0], yAt(i, used.length), "", "prov:used", usedLabel(u))).join("")}
    ${used.length ? "" : node(colX[0], yAt(0, 1), "", "prov:used", "なし")}
    ${actNodes.join("")}
    ${node(colX[2], lineY, "line", `生まれたもの ・ ${selected}`, line ? `${line.name} ${line.quantity}` : shorten(lineLabel(selected), 18))}
  </svg>`;
}

function shorten(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function renderActivities() {
  const el = $("#activities");
  if (!S!.audit.length) return void (el.innerHTML = `<p class="empty">まだ記録はありません</p>`);
  el.innerHTML = S!.audit.map((a: AuditEntry) => `<div class="act-item"><span class="t">${esc(a.time)}</span><div>
    <b>${esc(a.label)}</b>
    <div class="meta">${a.agent.startsWith("manager") ? '<span class="pill good">✓ 人が承認</span>' : '<span class="pill brand">⚙ 方針で自動</span>'}
      ${esc(agentLabel(a.agent))}${a.rule ? ` ・ 規則: ${esc(a.rule)}` : ""}</div>
    <div>${a.used.map((u) => `<span class="chip">${esc(usedLabel(u))}</span>`).join("")}</div>
    <div>${a.generated.map((g) => `<span class="chip">→ ${esc(lineLabel(lineId(g)))}</span>`).join("")}</div>
  </div></div>`).join("");
}

function renderRules() {
  const el = $("#rules");
  if (!S) return;
  const hits = new Map<string, number>();
  for (const v of S.validations) for (const r of v.results) hits.set(r.check, (hits.get(r.check) ?? 0) + 1);
  const ran = S.validations.length;
  el.innerHTML = ruleNames.map((n) => {
    const h = hits.get(n) ?? 0;
    return `<div class="rule"><div>${esc(n)}<small>${n === "承認" ? "確定のときだけ（再検証）" : "事前検証と確定のとき"}</small></div>
      ${!ran ? '<span class="pill">未実行</span>' : h ? `<span class="pill warn">⚠ 不合格 ${h} 回</span>` : '<span class="pill good">✓ 違反なし</span>'}</div>`;
  }).join("") || `<p class="empty">読み込み中…</p>`;
}

function renderPerms() {
  $("#perms").innerHTML = `<table class="clean"><tr><th>誰が</th><th>何を</th><th>対象</th><th>規則</th></tr>
    ${S!.permissions.map((p) => `<tr><td>${esc(p.label)}<div class="muted">${esc(p.assignee)}</div></td>
      <td><span class="chip">odrl:action ${esc(p.action)}</span></td><td>${esc(p.target)}</td><td>${esc(p.comment)}</td></tr>`).join("")}</table>
    <p class="sub" style="margin-top:12px">ここにない人（たとえば本部のバイヤー）が承認しても、SHACL の承認の点検が却下する。</p>`;
}
