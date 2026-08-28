import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  // CloudBase 静态托管可部署在 /warehouse-online 这类子路径；相对资源路径
  // 能同时兼容子路径和根路径部署。
  base: "./",
  plugins: [react()],
  publicDir: path.resolve(import.meta.dirname, "../public"),
  build: { outDir: "dist", emptyOutDir: true },
});
