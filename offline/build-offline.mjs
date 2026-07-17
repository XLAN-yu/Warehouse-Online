import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(directory, "dist");
const appDirectory = path.resolve(directory, "../app");

await mkdir(output, { recursive: true });

const sourceCss = await readFile(path.join(appDirectory, "globals.css"), "utf8");
const browserCss = sourceCss
  .replace(/@import "tailwindcss";\r?\n\r?\n/, "")
  .replace(/@theme inline \{[\s\S]*?\}\r?\n\r?\n/, "");

await writeFile(path.join(output, "signal-lab.css"), browserCss, "utf8");

await build({
  entryPoints: [path.join(directory, "src/main.tsx")],
  outfile: path.join(output, "signal-lab.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
});

console.log("Offline Signal Lab bundle created.");
