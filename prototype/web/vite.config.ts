import { resolve } from "node:path";
import { defineConfig } from "vite";

// 画面ごとに HTML を分けたマルチページ構成。開発中は /api を FastAPI（8000番）へ渡す
const pages = {
  hub: "index.html",
  sap: "l1/sap.html",
  pos: "l1/pos.html",
  wms: "l1/wms.html",
  handy: "l1/handy.html",
  bms: "l1/bms.html",
  tms: "l1/tms.html",
  manager: "l5/manager.html",
  tower: "l5/tower.html",
  governance: "l5/governance.html",
};

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, resolve(__dirname, v)])),
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
});
