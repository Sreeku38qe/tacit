// Records the shots for the demo video: the real site, driving the real contract on live testnet.
//
//   node scripts/serve.mjs --demo     (in another terminal)
//   node demo/record.mjs [shot ...]   shots: old census hero post object refused report install
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickOn, installCursor, moveTo, openBrowser, startRecording, typeInto } from "./capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(HERE, "out", "shots");
const BASE = process.env.BASE || "http://127.0.0.1:4173";
const { contract } = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const HQ = contract.split(".").slice(1).join(".");
const HALL = `community-hall.${HQ}`;
const ZOOM = "html { zoom: 1.42; }";
const SINCE = process.env.SINCE || 0;
const wanted = process.argv.slice(2);
const want = (name) => !wanted.length || wanted.includes(name);

const { browser, page } = await openBrowser();
page.on("pageerror", (err) => console.warn("page error:", err.message));

async function shot(name, fn) {
  if (!want(name)) return;
  console.log("shot", name);
  const dir = path.join(OUT, name);
  const events = {};
  const mark = (key) => {
    events[key] = Date.now() / 1000;
    console.log("  ", key);
  };
  let stop;
  await fn({
    begin: async () => {
      await installCursor(page);
      stop = await startRecording(page, dir);
      mark("start");
    },
    mark,
  });
  mark("end");
  const n = await stop();
  fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify(events));
  console.log(`   ${n} frames`);
}

async function open(url) {
  // A URL that differs only by its hash would not reload, and would keep the previous person.
  await page.goto("about:blank");
  await page.goto(`${BASE}${url}`, { waitUntil: "load" });
  await page.addStyleTag({ content: ZOOM });
  await page.evaluate(() => document.fonts.ready);
}

const OLD_WAY = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=League+Gothic&family=Libre+Franklin:wght@400;500;600;700&display=swap">
</head><body style="margin:0;display:grid;place-items:center;height:100vh;padding:0">
<svg width="0" height="0" style="position:absolute"><filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6"/></filter></svg>
<article class="notice" style="width:980px;padding:30px 34px 30px;gap:12px;zoom:1.5;margin-top:-30px">
  <div class="notice-head"><span class="notice-no" style="font-size:17px">Treasury request</span><span class="chip chip-other" id="chip" style="font-size:17px">Waiting for votes</span></div>
  <h3 style="font-size:64px;padding-right:0">Hall rental for Sunday's workshop</h3>
  <p class="pay" style="font-size:30px"><strong style="font-size:34px">0.3 NEAR</strong> to community-hall</p>
  <dl class="meta" style="font-size:24px"><div><dt>Requested by</dt><dd>meera</dd></div><div><dt>Yes votes</dt><dd id="yes">0 of 3</dd></div></dl>
  <div class="clock" style="margin-top:14px"><span class="clock-left" id="left" style="font-size:72px">7 days</span><span class="clock-say" style="font-size:28px" id="say">left to vote</span><div class="fuse"><i id="fuse" style="width:100%"></i></div></div>
  <div class="rubber red" id="stamp" hidden style="top:auto;bottom:34px;right:44px"><b style="font-size:76px">Expired</b><small style="font-size:18px">Nobody said no</small></div>
</article>
<script>
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.play = async (p) => {
  const t0 = performance.now();
  const until = (s) => wait(Math.max(0, s * 1000 - (performance.now() - t0)));
  await until(p.yesAt);
  document.getElementById('yes').textContent = '1 of 3';
  await until(p.drainAt);
  const days = 7 * 24, left = document.getElementById('left'), fuse = document.getElementById('fuse');
  const step = (p.drainFor * 1000) / days;
  for (let h = days; h >= 0; h -= 1) {
    const d = Math.floor(h / 24);
    left.textContent = d ? d + ' day' + (d === 1 ? '' : 's') : h + ' hours';
    fuse.style.width = (100 * h / days) + '%';
    await wait(step);
  }
  await until(p.stampAt);
  left.textContent = '0 hours';
  document.getElementById('chip').textContent = 'Expired';
  const stamp = document.getElementById('stamp');
  stamp.hidden = false;
  stamp.parentElement.classList.add('just');
};
</script></body></html>`;

const plan = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "out", "plan.json"), "utf8"));
  } catch {
    return { old: { yesAt: 8, drainAt: 10.5, drainFor: 3.2, stampAt: 15 }, hero: { stampAt: 3 } };
  }
})();

await shot("old", async ({ begin, mark }) => {
  await page.goto(`${BASE}/`);
  await page.setContent(OLD_WAY, { waitUntil: "load" });
  await page.addStyleTag({ path: path.join(ROOT, "web", "style.css") });
  await page.evaluate(() => document.fonts.ready);
  await begin();
  await page.waitForTimeout(400);
  mark("zero");
  await page.evaluate((p) => window.play(p), plan.old);
  mark("stamped");
  await page.waitForTimeout(3500);
});

await shot("hero", async ({ begin, mark }) => {
  await open("/?as=meera#");
  await page.addStyleTag({ content: ".flip .now { visibility: hidden; animation: none; }" });
  await page.waitForTimeout(500);
  await begin();
  await page.waitForTimeout(200);
  mark("zero");
  await page.waitForTimeout(plan.hero.stampAt * 1000);
  await page.addStyleTag({ content: ".flip .now { visibility: visible; animation: thump 0.55s cubic-bezier(0.3, 1.4, 0.6, 1) both; }" });
  mark("stamped");
  await page.waitForTimeout(3500);
});

await shot("census", async ({ begin, mark }) => {
  await open("/?as=meera#");
  await page.waitForSelector(".ledger .bars");
  await page.evaluate(() => document.querySelector(".ledger").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(600);
  await begin();
  await page.waitForTimeout(9000);
  mark("facts");
  await page.evaluate(() => window.scrollBy({ top: 500, behavior: "smooth" }));
  await page.waitForTimeout(6000);
});

await shot("post", async ({ begin, mark }) => {
  await open(`/?as=meera&since=${SINCE}#board`);
  await page.waitForSelector("#f-title");
  await begin();
  await page.waitForTimeout(1500);
  await moveTo(page, page.locator("#budgets .budget").first());
  mark("budget");
  await page.waitForTimeout(3500);
  await typeInto(page, page.locator("#f-title"), "Hall rental for Sunday's workshop");
  await typeInto(page, page.locator("#f-payee"), HALL, 14);
  await typeInto(page, page.locator("#f-amount"), "0.3");
  mark("typed");
  await clickOn(page, page.locator("#f-submit"));
  mark("clicked");
  await page.locator(".notice:first-child .clock-left").waitFor({ timeout: 90000 });
  mark("clock");
  await moveTo(page, page.locator(".notice:first-child .meta"));
  await page.locator(".notice:first-child .chip-silent").filter({ hasText: "Confirming" }).waitFor({ timeout: 240000 });
  mark("confirming");
  await page.locator(".notice:first-child .rubber").waitFor({ timeout: 120000 });
  mark("stamped");
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.querySelector("#records").scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(1200);
  await moveTo(page, page.locator("#records table"));
  mark("records");
  await page.waitForTimeout(6000);
});

await shot("object", async ({ begin, mark }) => {
  await open(`/?as=meera&since=${SINCE}#board`);
  await page.waitForSelector("#f-title");
  await begin();
  await page.waitForTimeout(800);
  await typeInto(page, page.locator("#f-title"), "Deposit to a vendor nobody knows", 18);
  await typeInto(page, page.locator("#f-payee"), `visitor.${HQ}`, 12);
  await typeInto(page, page.locator("#f-amount"), "0.25");
  await clickOn(page, page.locator("#f-submit"));
  await page.locator(".notice:first-child .clock-left").waitFor({ timeout: 90000 });
  mark("posted");
  await page.waitForTimeout(1200);
  await clickOn(page, page.locator("#persona"));
  await page.selectOption("#persona", `lena.${HQ}`);
  mark("lena");
  await page.waitForTimeout(1200);
  await clickOn(page, page.locator(".notice:first-child [data-start-object]"));
  await typeInto(page, page.locator(".notice:first-child input[name=reason]"), "Nobody has met this vendor. Let's talk first.", 28);
  mark("typed");
  await clickOn(page, page.locator(".notice:first-child button[type=submit]"));
  await page.locator(".notice:first-child .rubber.red").waitFor({ timeout: 60000 });
  mark("stamped");
  await page.waitForTimeout(5000);
});

await shot("refused", async ({ begin, mark }) => {
  await open(`/?as=meera&since=${SINCE}#board`);
  await page.waitForSelector("#f-title");
  await begin();
  await page.waitForTimeout(600);
  await typeInto(page, page.locator("#f-title"), "New tools for the workshop", 16);
  await typeInto(page, page.locator("#f-payee"), HALL, 10);
  await typeInto(page, page.locator("#f-amount"), "2");
  mark("typed");
  await clickOn(page, page.locator("#f-submit"));
  await page.locator("#toast:not([hidden])").filter({ hasText: "limit" }).waitFor({ timeout: 90000 });
  mark("toast");
  await page.waitForTimeout(3500);
});

await shot("report", async ({ begin, mark }) => {
  await open("/?as=meera#report");
  await page.waitForSelector("#dao-input");
  await begin();
  await page.waitForTimeout(600);
  await typeInto(page, page.locator("#dao-input"), "open-web-academy.sputnik-dao.near", 16);
  await clickOn(page, page.locator("#lookup button"));
  await page.locator(".tiles").waitFor({ timeout: 60000 });
  mark("report");
  await page.waitForTimeout(6000);
});

await shot("install", async ({ begin }) => {
  await open("/?as=meera#install");
  await page.waitForSelector("#copy-role");
  await begin();
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector("#install-out").scrollIntoView({ behavior: "smooth", block: "start" }));
  await page.waitForTimeout(4000);
});

await browser.close();
