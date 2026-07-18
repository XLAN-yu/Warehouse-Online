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
  assert.match(html, /时频变换/);
  assert.match(html, /时频立方体/);
  assert.match(html, /傅里叶几何/);
  assert.match(html, /旋转向量 · 实时叠加波形/);
  assert.match(html, /自定义频率分量/);
  assert.match(html, /og:image/);
  assert.match(html, /Content-Security-Policy/);
});

test("keeps real-time transforms and offline distribution wired into the project", async () => {
  const [workbench, engine, cube, geometry, layout, packageJson, offlineReadme] =
    await Promise.all([
      readFile(new URL("../app/SignalWorkbench.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/signalEngine.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/TimeFrequencyCube.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/FourierGeometryLab.tsx", import.meta.url), "utf8"),
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
  assert.match(workbench, /useState<ToolMode>\("geometry"\)/);
  assert.match(engine, /export function convolutionFrame/);
  assert.match(engine, /export function linearCombineSignals/);
  assert.match(engine, /export function parsevalEnergy/);
  assert.match(engine, /nextPowerOfTwo/);
  assert.match(cube, /discrete/);
  assert.match(cube, /frequencyX/);
  assert.match(cube, /resetAmplitude/);
  assert.match(cube, /updateFrequency/);
  assert.match(cube, /component-frequency-editor/);
  assert.match(geometry, /requestAnimationFrame/);
  assert.match(geometry, /旋转向量 · 实时叠加波形/);
  assert.match(geometry, /谐波个数/);
  assert.match(geometry, /customComponents/);
  assert.match(geometry, /添加频率/);
  assert.match(geometry, /恢复默认/);
  assert.match(layout, /openGraph/);
  assert.match(layout, /Content-Security-Policy/);
  assert.match(packageJson, /"build": "vinext build"/);
  assert.match(offlineReadme, /index\.html/);
});
