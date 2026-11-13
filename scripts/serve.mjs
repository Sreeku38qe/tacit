// Serves the site. With --demo it also lets you act as the demo community's members and runs a keeper.
//
//   node scripts/serve.mjs            # the public site: read-only, or connect your own wallet
//   node scripts/serve.mjs --demo     # needs the demo accounts' keys in ~/.near-credentials
//
// Demo mode binds to localhost only and signs with testnet keys held on this computer.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NEAR, ROOT, call, fileTransfer, hasKey, loadAccount, view } from "./lib.mjs";

const DEMO = process.argv.includes("--demo");
const PORT = Number(process.env.PORT || 4173);
const WEB = path.join(ROOT, "web");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const { contract: TACIT, dao: DAO } = deployment;
const HQ = TACIT.split(".").slice(1).join(".");

const ROLES = { meera: "steward", lena: "member", ines: "council", tomas: "council", arjun: "council", visitor: "outsider" };
const people = Object.entries(ROLES).map(([name, role]) => ({
  id: `${name}.${HQ}`,
  name: name[0].toUpperCase() + name.slice(1),
  role,
}));

const actions = {
  file: async (who, { budgetId, payee, amount, title, notes }) => {
    const filed = await fileTransfer(who, DAO, { receiver: payee, amount, title, notes });
    const res = await call(who, TACIT, "register_spend", { budget_id: budgetId, proposal_id: String(filed.proposalId) }, { gas: 120 });
    return { ...res, proposalId: filed.proposalId };
  },
  object: (who, { spendId, reason }) => call(who, TACIT, "object", { spend_id: spendId, reason }, { gas: 120 }),
  advance: (who, { spendId }) => call(who, TACIT, "advance", { spend_id: spendId }, { gas: 200 }),
  pause: (who, { budgetId }) => call(who, TACIT, "pause_budget", { budget_id: budgetId }, { gas: 100 }),
  vote: (who, { proposalId, action, kind }) => call(who, DAO, "act_proposal", { id: Number(proposalId), action, proposal: kind }, { gas: 150 }),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(JSON.parse(raw || "{}")));
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleDemo(req, res) {
  if (req.method === "GET") return json(res, 200, people.filter((p) => hasKey(p.id)));
  const { persona, name, params } = await readBody(req);
  if (!people.some((p) => p.id === persona) || !actions[name]) return json(res, 400, { error: "Unknown person or action." });
  try {
    const out = await actions[name](loadAccount(persona), params);
    if (!out.ok) return json(res, 422, { error: out.failures.join("; "), hash: out.hash });
    return json(res, 200, { hash: out.hash, value: out.value });
  } catch (err) {
    return json(res, 500, { error: String(err.message || err) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/demo/")) {
    if (!DEMO) return json(res, 404, { error: "Demo mode is off." });
    try {
      return await handleDemo(req, res);
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
  const file = path.join(WEB, relative);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tacit on http://127.0.0.1:${PORT} ${DEMO ? "(demo mode)" : ""}`);
});

// The keeper. Anyone may call advance, so this is a convenience with no special powers.
if (DEMO) {
  const keeper = loadAccount(HQ);
  const running = new Set();
  const closing = async (spend) => {
    if (running.has(spend.id)) return;
    running.add(spend.id);
    try {
      await call(keeper, TACIT, "advance", { spend_id: spend.id }, { gas: 200 });
    } catch (err) {
      console.warn("keeper", spend.id, String(err.message || err));
    } finally {
      running.delete(spend.id);
    }
  };
  setInterval(async () => {
    try {
      const count = await view(TACIT, "count_spends", { dao: DAO });
      const spends = await view(TACIT, "list_spends", { dao: DAO, from: Math.max(0, count - 12), limit: 12 });
      const budgets = await view(TACIT, "list_budgets", { dao: DAO, from: 0, limit: 10 });
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      for (const s of spends) {
        const grace = s.last_objection_attempt ? BigInt(s.last_objection_attempt) + 30_000_000_000n : 0n;
        const budget = budgets.find((b) => b.id === s.budget_id);
        const fresh = budget?.resumed_at ? BigInt(budget.resumed_at) + BigInt(budget.window_ns) : 0n;
        const deadline = fresh > BigInt(s.deadline) ? fresh : BigInt(s.deadline);
        if (budget?.paused_by) continue;
        if (s.status === "Silent" && nowNs > deadline + 3_000_000_000n && nowNs > grace) closing(s);
        if (s.status === "Paying" && nowNs > BigInt(s.voted_at) + 21_000_000_000n) {
          const p = await view(DAO, "get_proposal", { id: Number(s.proposal_id) }).catch(() => null);
          if (!p || p.status !== "Failed") closing(s);
        }
        if (s.status === "Contested") {
          const p = await view(DAO, "get_proposal", { id: Number(s.proposal_id) }).catch(() => null);
          if (p && p.status !== "InProgress") closing(s);
        }
      }
    } catch (err) {
      console.warn("keeper loop", String(err.message || err));
    }
  }, 4000);
}
void NEAR;
