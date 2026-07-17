import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Signal Lab workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Signal Lab · 信号分析工具<\/title>/);
  assert.match(html, /Signal Lab/);
  assert.match(html, /连续时间/);
  assert.match(html, /离散时间/);
  assert.match(html, /傅里叶性质/);
  assert.match(html, /时频立方体/);
  assert.match(html, /实时数值采样/);
  assert.match(html, /og:image/);
  assert.match(html, /Content-Security-Policy/);
});

test("keeps real-time transforms and offline distribution wired into the project", async () => {
  const [workbench, engine, cube, layout, packageJson, offlineReadme] =
    await Promise.all([
      readFile(new URL("../app/SignalWorkbench.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/signalEngine.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/TimeFrequencyCube.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../offline/README.md", import.meta.url), "utf8"),
    ]);

  assert.match(workbench, /discreteSampleCount/);
  assert.match(workbench, /domainSnapshots/);
  assert.match(workbench, /convolutionFrame/);
  assert.match(workbench, /propertyId/);
  assert.match(workbench, /linearA/);
  assert.match(workbench, /spectrum-bin-stem/);
  assert.match(workbench, /MAX_ZOOM = 16/);
  assert.match(workbench, /DEFAULT_DISCRETE_SAMPLE_COUNT = 128/);
  assert.match(workbench, /slider-reset/);
  assert.match(engine, /export function convolutionFrame/);
  assert.match(engine, /export function linearCombineSignals/);
  assert.match(engine, /export function parsevalEnergy/);
  assert.match(engine, /nextPowerOfTwo/);
  assert.match(cube, /discrete/);
  assert.match(cube, /frequencyX/);
  assert.match(cube, /resetAmplitude/);
  assert.match(layout, /openGraph/);
  assert.match(layout, /Content-Security-Policy/);
  assert.match(packageJson, /"build": "vinext build"/);
  assert.match(offlineReadme, /index\.html/);
});
