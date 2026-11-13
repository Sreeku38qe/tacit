// Deploys Tacit, creates a demo community on Sputnik DAO, and installs Tacit through the DAO's own votes.
// Safe to re-run: every step checks whether it has already happened.
//
//   node scripts/deploy.mjs <path-to-tacit.wasm>
import fs from "node:fs";
import path from "node:path";
import {
  NEAR,
  NETWORK,
  ROOT,
  actions,
  balanceOf,
  call,
  ensureSubaccount,
  exists,
  explorer,
  loadAccount,
  send,
  teraToGas,
  toNear,
  view,
} from "./lib.mjs";

const HQ = process.env.TACIT_HQ || "tacit-hq.testnet";
const CONTRACT = process.env.TACIT_CONTRACT || `v1.${HQ}`;
const FACTORY = "sputnikv2.testnet";
const DAO_NAME = process.env.TACIT_DAO_NAME || "sunday-makers";
const DAO = `${DAO_NAME}.${FACTORY}`;
const person = (name) => `${name}.${HQ}`;
const council = ["ines", "tomas", "arjun"].map(person);
const members = ["meera", "lena"].map(person);
const payees = ["community-hall"].map(person);
const SEVEN_DAYS_NS = "604800000000000";
const BOND = NEAR("0.01");

const wasm = process.argv[2];
if (!wasm) throw new Error("usage: node scripts/deploy.mjs <path-to-tacit.wasm>");

const deployment = { network: NETWORK, contract: CONTRACT, dao: DAO, factory: FACTORY, people: {}, txs: {} };
const remember = (key, hash) => {
  deployment.txs[key] = hash;
  console.log(`  ${key}: ${explorer(hash)}`);
};
const must = (res, what) => {
  if (!res.ok) throw new Error(`${what}: ${res.failures.join("; ")}`);
  return res;
};

const hq = loadAccount(HQ);
console.log(`HQ ${HQ} has ${toNear(await balanceOf(HQ))} NEAR`);

// 1. The accounts.
for (const id of [...council, ...members]) await ensureSubaccount(hq, id, "0.12");
for (const id of payees) await ensureSubaccount(hq, id, "0.02");
deployment.people = { council, members, payees };

// 2. The contract.
const code = fs.readFileSync(wasm);
if (!(await exists(CONTRACT))) {
  const needed = (code.length / 100_000 + 0.5).toFixed(2);
  await ensureSubaccount(hq, CONTRACT, needed);
}
const tacit = loadAccount(CONTRACT);
const state = await view(CONTRACT, "version").catch(() => null);
if (state === null) {
  const res = await send(tacit, CONTRACT, [
    actions.deployContract(code),
    actions.functionCall("new", {}, teraToGas(30), 0n),
  ]);
  must(res, "deploy");
  remember("deploy", res.hash);
} else {
  console.log(`  contract already deployed, version ${state}`);
}

// 3. The community's DAO, on the unmodified Sputnik factory.
const permissions = ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"];
const policy = {
  roles: [
    { name: "council", kind: { Group: council }, permissions, vote_policy: {} },
    { name: "members", kind: { Group: members }, permissions: ["transfer:AddProposal"], vote_policy: {} },
    { name: "all", kind: "Everyone", permissions: ["transfer:AddProposal"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: BOND,
  proposal_period: SEVEN_DAYS_NS,
  bounty_bond: BOND,
  bounty_forgiveness_period: "86400000000000",
};
if (!(await exists(DAO))) {
  const args = {
    config: { name: DAO_NAME, purpose: "A weekend makerspace run by its members", metadata: "" },
    policy,
  };
  const res = await call(
    hq,
    FACTORY,
    "create",
    { name: DAO_NAME, args: Buffer.from(JSON.stringify(args)).toString("base64") },
    { gas: 300, deposit: NEAR("5.55") },
  );
  must(res, "create DAO");
  remember("create_dao", res.hash);
}

// 4. Give the treasury something to spend. It also has to keep covering the DAO's own storage.
const target = BigInt(NEAR(process.env.TACIT_TREASURY || "7"));
const held = BigInt(await balanceOf(DAO));
if (held < target) {
  const topUp = target - held;
  const free = BigInt(await balanceOf(HQ));
  const amount = topUp < free - BigInt(NEAR("0.3")) ? topUp : free - BigInt(NEAR("0.3"));
  if (amount > 0n) {
    const res = await send(hq, DAO, [actions.transfer(amount)]);
    must(res, "fund treasury");
    remember("fund_treasury", res.hash);
  }
}

// 5. Install: two ordinary proposals, passed by the council's own votes.
// A transaction reserves gas up front at about 10x the gas price, so signers keep a float.
const keepFloat = async (accountId, near) => {
  const have = BigInt(await balanceOf(accountId));
  const want = BigInt(NEAR(near));
  if (have >= want) return;
  must(await send(hq, accountId, [actions.transfer(want - have)]), `float for ${accountId}`);
};
for (const id of [council[0], council[1], ...members]) await keepFloat(id, "0.3");

const propose = async (description, kind) => {
  const last = await view(DAO, "get_last_proposal_id");
  const recent = await view(DAO, "get_proposals", { from_index: Math.max(0, last - 20), limit: 20 });
  const open = recent.find((p) => p.description === description && p.status === "InProgress");
  if (open) return open.id;
  const proposer = loadAccount(council[0]);
  const res = await call(proposer, DAO, "add_proposal", { proposal: { description, kind } }, { gas: 50, deposit: BOND });
  must(res, "add_proposal");
  return res.value;
};
const passByCouncil = async (id, kind, label) => {
  for (const name of council.slice(0, 2)) {
    const { votes, status } = await view(DAO, "get_proposal", { id });
    if (status !== "InProgress" || votes[name]) continue;
    const res = await call(loadAccount(name), DAO, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: 150 });
    must(res, `vote on ${label}`);
    remember(`${label}_vote_${name.split(".")[0]}`, res.hash);
  }
};

const currentPolicy = await view(DAO, "get_policy");
const installed = currentPolicy.roles.some((r) => r.name === "tacit");
if (!installed) {
  const kind = {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name: "tacit",
        kind: { Group: [CONTRACT] },
        permissions: ["transfer:VoteApprove"],
        vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
      },
    },
  };
  const id = await propose(
    "* Title: Install Tacit <br>* Notes: Adds one role holding one permission. It lets the Tacit contract cast a yes vote on transfers it has checked.",
    kind,
  );
  await passByCouncil(id, kind, "install_role");
}

// A deposit prepays storage: each payment costs a budget about 0.011 NEAR of it.
const createBudget = async (input, title, deposit) => {
  const kind = {
    FunctionCall: {
      receiver_id: CONTRACT,
      actions: [
        {
          method_name: "create_budget",
          args: Buffer.from(JSON.stringify({ input })).toString("base64"),
          deposit: NEAR(deposit),
          gas: "50000000000000",
        },
      ],
    },
  };
  const id = await propose(`* Title: ${title} <br>* Notes: One vote now, instead of one vote per payment.`, kind);
  await passByCouncil(id, kind, `budget_${input.label.replace(/\s+/g, "_").toLowerCase()}`);
};

const budgets = await view(CONTRACT, "list_budgets", { dao: DAO, from: 0, limit: 10 });
if (!budgets.some((b) => b.label === "Workshop costs")) {
  await createBudget(
    {
      label: "Workshop costs",
      token: null,
      stewards: [person("meera")],
      open: false,
      allow_self_pay: false,
      window_secs: 120,
      period_secs: 30 * 86400,
      cap: NEAR("3"),
      base_limit: NEAR("0.3"),
      step: NEAR("0.1"),
      max_limit: NEAR("1"),
      expires_at: null,
    },
    "Approve the Workshop costs budget",
    "0.25",
  );
}
if (!budgets.some((b) => b.label === "Open pot")) {
  await createBudget(
    {
      label: "Open pot",
      token: null,
      stewards: [],
      open: true,
      allow_self_pay: true,
      window_secs: 60,
      period_secs: 86400,
      cap: NEAR("0.2"),
      base_limit: NEAR("0.01"),
      step: "0",
      max_limit: NEAR("0.01"),
      expires_at: null,
    },
    "Approve the Open pot budget",
    "0.25",
  );
}
// Two budgets only the automated test uses. The public board hides labels starting with "E2E".
if (!budgets.some((b) => b.label === "E2E steward")) {
  await createBudget(
    {
      label: "E2E steward",
      token: null,
      stewards: [person("meera")],
      open: false,
      allow_self_pay: false,
      window_secs: 300,
      period_secs: 30 * 86400,
      cap: NEAR("3"),
      base_limit: NEAR("0.3"),
      step: NEAR("0.1"),
      max_limit: NEAR("1"),
      expires_at: null,
    },
    "Approve the E2E steward budget",
    "0.25",
  );
}
if (!budgets.some((b) => b.label === "E2E open")) {
  await createBudget(
    {
      label: "E2E open",
      token: null,
      stewards: [],
      open: true,
      allow_self_pay: true,
      window_secs: 240,
      period_secs: 86400,
      cap: NEAR("0.2"),
      base_limit: NEAR("0.01"),
      step: "0",
      max_limit: NEAR("0.01"),
      expires_at: null,
    },
    "Approve the E2E open budget",
    "0.1",
  );
}

const finalBudgets = await view(CONTRACT, "list_budgets", { dao: DAO, from: 0, limit: 10 });
deployment.budgets = finalBudgets.map((b) => ({ id: b.id, label: b.label }));
const file = path.join(ROOT, "deployments", `${NETWORK}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}
fs.writeFileSync(
  file,
  JSON.stringify({ ...previous, ...deployment, txs: { ...(previous.txs || {}), ...deployment.txs } }, null, 2) + "\n",
);
console.log(`Contract ${CONTRACT}`);
console.log(`DAO      ${DAO} holding ${toNear(await balanceOf(DAO))} NEAR`);
console.log(`Budgets  ${finalBudgets.map((b) => `#${b.id} ${b.label}`).join(", ")}`);
console.log(`HQ left  ${toNear(await balanceOf(HQ))} NEAR`);
