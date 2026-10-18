// デモの画面の一覧。司令塔の画面一覧が使う。

export interface Screen {
  id: string;
  path: string;
  layer: "L1" | "L5";
  title: string;
}

export const SCREENS: Screen[] = [
  { id: "sap", path: "/l1/sap.html", layer: "L1", title: "SAP" },
  { id: "pos", path: "/l1/pos.html", layer: "L1", title: "POS" },
  { id: "wms", path: "/l1/wms.html", layer: "L1", title: "WMS" },
  { id: "handy", path: "/l1/handy.html", layer: "L1", title: "スタッフ端末" },
  { id: "bms", path: "/l1/bms.html", layer: "L1", title: "BMS" },
  { id: "tms", path: "/l1/tms.html", layer: "L1", title: "TMS" },
  { id: "manager", path: "/l5/manager.html", layer: "L5", title: "店長アプリ" },
  { id: "tower", path: "/l5/tower.html", layer: "L5", title: "コントロールタワー" },
  { id: "governance", path: "/l5/governance.html", layer: "L5", title: "ガバナンス" },
];
