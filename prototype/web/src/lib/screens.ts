// デモの画面の一覧。司令塔の画面一覧と、各画面の「戻る」リンクが使う。

export interface Screen {
  id: string;
  path: string;
  layer: "L1" | "L5";
  title: string;
  who: string;
  look: string;
  uc: string;   // 主に使うシナリオ
}

export const SCREENS: Screen[] = [
  { id: "sap", path: "/l1/sap.html", layer: "L1", title: "SAP S/4HANA", who: "本部の購買・在庫担当", look: "SAP GUI", uc: "UC1・UC3" },
  { id: "pos", path: "/l1/pos.html", layer: "L1", title: "店舗管理システム（POS）", who: "各店の事務所", look: "Windows 98 の業務アプリ", uc: "UC1・UC3" },
  { id: "wms", path: "/l1/wms.html", layer: "L1", title: "WMS 東部 DC", who: "配送センターの在庫管理", look: "AS/400 のグリーン画面", uc: "UC1" },
  { id: "handy", path: "/l1/handy.html", layer: "L1", title: "スタッフ端末", who: "各店の売場スタッフ", look: "ハンディターミナル", uc: "UC1・UC3" },
  { id: "bms", path: "/l1/bms.html", layer: "L1", title: "BMS 設備監視盤", who: "1号店の設備担当", look: "古い中央監視の HMI", uc: "UC2" },
  { id: "tms", path: "/l1/tms.html", layer: "L1", title: "TMS 配車システム", who: "ネットスーパーの配車係", look: "2000年代のクライアントアプリ", uc: "UC3" },
  { id: "manager", path: "/l5/manager.html", layer: "L5", title: "店長アプリ", who: "1号店・2号店の店長", look: "スマホ・タブレット", uc: "UC1〜UC3" },
  { id: "tower", path: "/l5/tower.html", layer: "L5", title: "コントロールタワー", who: "供給網の担当", look: "ダッシュボード", uc: "UC1〜UC3" },
  { id: "governance", path: "/l5/governance.html", layer: "L5", title: "ガバナンス・コンソール", who: "監査・権限の担当", look: "来歴と権限", uc: "UC1〜UC3" },
];
