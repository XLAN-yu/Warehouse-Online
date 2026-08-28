import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  publicDir: path.resolve(import.meta.dirname, "../public"),
  build: { outDir: "dist", emptyOutDir: true },
});
