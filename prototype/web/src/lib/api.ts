// バックエンド（FastAPI）の状態の型と、状態を見張る仕組み。どの画面もこれを使う。

export type LayerId = "L1" | "L2" | "L3" | "L4" | "L5";
export type WorkflowState = "待機" | "承認待ち" | "締め待ち" | "実行待ち" | "実行中" | "完了" | "失敗";

export interface Forecast {
  product: string;
  mean: number;
  lower: number;
  upper: number;
  version: string;
  basis: string;
}

export interface Line {
  product: string;
  name: string;
  quantity: number;
  case_size: number;
  recommended: number | null;
  morning_stock: number;
  forecast: Forecast | null;
  reference: string | null;
  reason: string;
  approved_by: string | null;
  approved_quantity: number | null;
  status: string;
  history: string[];
  ratio: number | null;
}

export interface LogEntry {
  time: string;
  layer: LayerId;
  layer_name: string;
  actor: string;
  title: string;
  detail: unknown;
}

export interface EventInfo {
  id: string;
  label: string;
  type: string;
  type_label: string;
  attendance: number;
  km: number;
  nearby: boolean;
}

export interface Context {
  store: string;
  day: string;
  policy: { r: number; min: number; th: number; ratio: number };
  events: EventInfo[];
  max_temp: number | null;
  products: Record<string, { name: string; case: number; rec: number | null; reasons: string[]; similar?: string | null }>;
  event_type: string | null;
}

export interface Validation {
  label: string;
  shapes: string;
  conforms: boolean;
  results: { focus: string; check: string; message: string }[];
}

export interface AuditEntry {
  time: string;
  label: string;
  agent: string;
  rule: string | null;
  generated: string[];
  used: string[];
}

export interface ApprovalRequest {
  approver: string;
  approver_label: string;
  plan: string;
  kind?: "transfer";
  message: string;
  lines: ((Line | Transfer) & { why: string })[];
}

export type ScenarioId = "uc1" | "uc2" | "uc3";

export interface StaffTask {
  key: string;
  store: string;
  when: string;
  text: string;
  done: boolean;
  result?: string;
}

export interface BmsEquipment {
  id: string; type: string; name: string; feeds?: string; zone?: string; temp_zone?: string; kw?: number;
  setpoint?: number; auto_min?: number; auto_max?: number; auto_max_dim?: number; defrost?: number[];
}

export interface BmsRow { time: string; kw: number; [sensor: string]: number | string }

export interface Bms {
  now: string;
  contract_kw: number;
  equipment: BmsEquipment[];
  effective: Record<string, { setpoint?: number; dim?: number; precool?: boolean; output?: number; defrosting?: boolean }>;
  defrost: Record<string, number[]>;
  timed: { equipment: string; kind: string; value: number; from: string; to: string }[];
  sensors: Record<string, number>;
  history: BmsRow[];
  alarms: { time: string; sensor: string; text: string; value: number }[];
  commands: ({ time: string; equipment: string; kind: string } & Record<string, unknown>)[];
  zones: { id: string; name: string; window?: boolean }[];
}

export interface Vehicle {
  id: string; name: string; home: string; temp_zone: string; cold_hours: number; free_units: number;
  route_label: string; route: [number, number][]; eta_receiving: string; transit_minutes: number;
}

export interface PosItem { stock: number; sold_today: number; expiry?: string; reserved_online?: number }
export interface PriceLabel { store: string; product: string; base: number; discount: number; price: number; time: string; reason: string }

export interface Action { id: string; label: string; enabled: boolean; repeatable?: boolean }

export interface Setting {
  key: string; equipment: string; kind: string; label: string; saving_kw: number;
  values: Record<string, unknown>; status: string; revert: boolean;
}

export interface Uc2 {
  context: {
    day?: string; contract_kw?: number; margin_kw?: number; peak?: [number, number]; max_temp?: number;
    latest_kw?: number; other_kw?: number; projected_kw?: number; planned_kw?: number;
    defrost_in_peak?: string[]; steps?: { kind: string; saving: number; after: number }[];
  };
  settings: Setting[];
  next_time: string | null;
  times: string[];
  monitor: { time: string; conforms: boolean; results: Validation["results"] }[];
  notifications: { time: string; title: string; body: string }[];
}

export interface Transfer {
  id: string; product: string; name: string; quantity: number; source: string; dest: string; vehicle: string; eta: string;
  expiry: string; source_stock: number; source_reserved: number; price: number; status: string; amount: number;
  approved_by: string | null; history: string[];
}

export interface MarkdownPlan {
  id: string; product: string; name: string; store: string; expiry: string; surplus: number;
  steps: [number, number][]; status: string; applied: string[];
}

export interface Uc3 {
  context: {
    day?: string;
    policy?: Record<string, number>;
    nearby?: { a: string; b: string; km: number }[];
    routes?: { vehicle: string; home: string; store: string; km: number; eta: string; free: number; label: string }[];
    estimates?: { store: string; product: string; name: string; stock: number; sold_today: number; rest: number;
      balance: number; expiry: string; reserved: number; runout: number | null }[];
  };
  transfers: Transfer[];
  markdowns: MarkdownPlan[];
  next_time: string | null;
  timeline: string[];
}

export interface Systems {
  sap_orders: Record<string, { kind?: string; store: string; dc: string; date: string; lines: Record<string, number> }>;
  wms_allocations: Record<string, Record<string, number>>;
  wms_stock: Record<string, Record<string, number>>;
  pos_incoming: Record<string, Record<string, number>>;
  pos_stock: Record<string, Record<string, number>>;
  pos_sold_today: Record<string, Record<string, number>>;
  pos_detail: Record<string, Record<string, PosItem>>;
  pos_labels: PriceLabel[];
  staff_tasks: StaffTask[];
  bms: Bms;
  tms: { vehicles: Vehicle[]; stops: { vehicle: string; store: string; time: string; purpose: string; status: string }[] };
}

export interface Master {
  products: Record<string, string>[];
  replenishment: Record<string, string>[];
  sites: Record<string, string>[];
  events: { id: string; name: string; type: string; start: string; attendance: number; lat: number; lon: number }[];
  weather: { area: string; area_name: string; date: string; max_celsius: number }[];
  planogram: Record<string, string>[];
}

export interface State {
  scenario: ScenarioId;
  scenarios: { id: ScenarioId; title: string; day: string }[];
  title: string;
  day: string;
  actions: Action[];
  uc2?: Uc2;
  uc3?: Uc3;
  now: string;
  workflow_state: WorkflowState;
  context: Context | Record<string, never>;
  plan: { id: string; store: string; delivery_date: string; lines: Line[] } | null;
  validations: Validation[];
  approval_request: ApprovalRequest | null;
  cloud_events: Record<string, unknown>[];
  last_update: string;
  systems: Systems;
  kg_stats: { graph: string; name: string; triples: number }[];
  inferred_only: number;
  audit: AuditEntry[];
  audit_turtle: string;
  log: LogEntry[];
  revision: number;
  master: Master;
  permissions: { assignee: string; label: string; action: string; target: string; comment: string }[];
}

export const hasContext = (c: State["context"]): c is Context => "events" in c;

export async function getState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

/** 操作を送る。409（今の状態では受け付けない）などは、メッセージを返す。 */
export async function post(path: string): Promise<{ ok: true; state: State } | { ok: false; message: string }> {
  const r = await fetch(path, { method: "POST" });
  const body = await r.json();
  return r.ok ? { ok: true, state: body } : { ok: false, message: body.detail ?? r.statusText };
}

/**
 * 状態を見張る。ほかの画面での操作も反映されるように、軽い /api/revision を一定間隔で聞き、
 * 変わったときだけ /api/state を取り直して onChange を呼ぶ。
 */
export function watch(onChange: (s: State) => void, intervalMs = 1200): { refresh: () => Promise<void> } {
  let key = "";
  const refresh = async () => {
    const s = await getState();
    key = "";
    onChange(s);
  };
  const tick = async () => {
    try {
      const r = await (await fetch("/api/revision")).json();
      const k = `${r.instance}:${r.revision}:${r.state}`;
      if (k !== key) {
        key = k;
        onChange(await getState());
      }
    } catch {
      /* サーバーが止まっている間は、次の間隔でまた聞く */
    }
  };
  void tick();
  setInterval(tick, intervalMs);
  return { refresh };
}

/** ワークフローの操作を送る（start / approve / advance）。 */
export const act = (action: string) => post(`/api/action/${action}`);

/** シナリオを切り替える（その日付と元データで最初から）。 */
export const switchScenario = (id: ScenarioId) => post(`/api/scenario/${id}`);

export const STORE_NAMES: Record<string, string> = { "ST-014": "1号店", "ST-031": "2号店", "ST-040": "3号店", "DC-01": "東部 DC" };
export const storeName = (id: string) => STORE_NAMES[id] ?? id;

/** 商品コード（小売側）から名前を引く。 */
export function productName(s: State, code: string): string {
  const p = s.master.products.find((x) => x.retail_code === code || x.wholesale_code === code);
  return p ? p.name : code;
}
