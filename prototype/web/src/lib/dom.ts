// 小さな DOM の道具。フレームワークを使わず、文字列のテンプレートで画面を組む。

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`要素が見つからない: ${sel}`);
  return el;
};

export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 数値を3桁区切りに。 */
export const num = (n: number | null | undefined): string => (n == null ? "―" : n.toLocaleString("ja-JP"));

/** 画面のどこにも出せるトースト。 */
export function toast(message: string, cls = ""): void {
  const t = document.createElement("div");
  t.className = `toast ${cls}`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/** 文字列の表示幅（全角は2、半角は1）。グリーン画面で桁をそろえるのに使う。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)) ? 2 : 1;
  }
  return w;
}

/** 表示幅で右詰め・左詰めにする。はみ出す分は切る。 */
export function pad(s: string | number, width: number, align: "left" | "right" = "left"): string {
  let str = String(s);
  while (displayWidth(str) > width) str = str.slice(0, -1);
  const fill = " ".repeat(width - displayWidth(str));
  return align === "left" ? str + fill : fill + str;
}
