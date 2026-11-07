/**
 * Screenshot helper with real device metrics (Chrome headless honours
 * --window-size inconsistently, which makes mobile screenshots lie).
 *
 *   node scripts/shot.mjs <url> <out.png> <width> <height> [mobile]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , url = "http://localhost:3000/", out = "/tmp/shot.png", w = "1440", h = "1600", mobile = "", clickText = "", cookie = ""] = process.argv;
const width = Number(w);
const height = Number(h);
const isMobile = mobile === "mobile";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), "cdp-"));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}

const wsUrl = await target();
const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: isMobile,
  screenWidth: width,
  screenHeight: height,
});
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.enable");
await send("Network.enable");
if (cookie) {
  const [name, ...rest] = cookie.split("=");
  await send("Network.setCookie", {
    name,
    value: rest.join("="),
    domain: new URL(url).hostname,
    path: "/",
  });
}
await send("Page.navigate", { url });
await sleep(2500);
if (clickText) {
  await send("Runtime.evaluate", {
    expression: `(() => { const target = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(clickText)}); if (!target) return "not-found"; target.click(); return "clicked"; })()`,
    returnByValue: true,
  });
  await sleep(700);
}
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`wrote ${out} at ${width}x${height}${isMobile ? " (mobile)" : ""}`);
ws.close();
chrome.kill("SIGKILL");
process.exit(0);
