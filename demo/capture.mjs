// Screen capture helpers for the demo video. A real browser driving the real site against live testnet.
// Frames come from Chrome's screencast at full 1920x1080, with their true timestamps.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

export async function openBrowser() {
  const browser = await chromium.launch({ headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "light" });
  const page = await context.newPage();
  return { browser, context, page };
}

// A visible cursor, because headless Chrome draws none.
const CURSOR = `
(() => {
  if (window.__cursor) return;
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:99999;pointer-events:none;transform:translate(960px,620px);transition:transform .55s cubic-bezier(.3,.8,.3,1);';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-6.6.9L16 21l-3 1.3-3.5-7.2L5 19z" fill="#15211d" stroke="#fff" stroke-width="1.4"/></svg>';
  document.documentElement.appendChild(c);
  const zoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  window.__cursor = (x, y) => { c.style.transform = 'translate(' + (x / zoom()) + 'px,' + (y / zoom()) + 'px)'; };
  window.__ripple = (x, y) => {
    const z = zoom();
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;z-index:99998;pointer-events:none;width:14px;height:14px;border-radius:50%;left:' + (x / z - 7) + 'px;top:' + (y / z - 7) + 'px;border:3px solid #4a37ae;transition:transform .45s ease-out,opacity .45s ease-out;';
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(4.5)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 520);
  };
})();`;

export async function installCursor(page) {
  await page.evaluate(CURSOR);
}

export async function moveTo(page, locator) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([px, py]) => window.__cursor(px, py), [x, y]);
  await page.waitForTimeout(620);
  return { x, y };
}

export async function clickOn(page, locator) {
  const { x, y } = await moveTo(page, locator);
  await page.evaluate(([px, py]) => window.__ripple(px, py), [x, y]);
  await page.waitForTimeout(120);
  await locator.click();
}

export async function typeInto(page, locator, text, delay = 34) {
  await clickOn(page, locator);
  await locator.pressSequentially(text, { delay });
}

/** Record until stop() is called. Writes numbered JPEGs and frames.json with each frame's time. */
export async function startRecording(page, dir, quality = 92) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (event) => {
    const name = `f${String(n).padStart(6, "0")}.jpg`;
    n += 1;
    fs.writeFileSync(path.join(dir, name), Buffer.from(event.data, "base64"));
    frames.push({ name, t: event.metadata.timestamp });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch {
      // The session ended between the frame and the ack.
    }
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    const end = Date.now() / 1000;
    fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames, end }, null, 0));
    return frames.length;
  };
}
