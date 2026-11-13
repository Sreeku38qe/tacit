// Read-only proof of how Tacit is installed. Needs no account and no keys.
//
//   node scripts/verify.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, provider, toNear, view } from "./lib.mjs";

const { contract: TACIT, dao: DAO } = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));

const show = (label, value) => console.log(`${label.padEnd(44)} ${value}`);
let problems = 0;
const expect = (label, ok, value = "") => {
  if (!ok) problems += 1;
  console.log(`${ok ? "OK  " : "BAD "} ${label}${value !== "" ? `: ${value}` : ""}`);
};

console.log("The contract");
show("  account", TACIT);
show("  version", await view(TACIT, "version"));
const keys = await provider.viewAccessKeyList({ accountId: TACIT, finalityQuery: { finality: "final" } }).catch(() => null);
if (keys) {
  show("  access keys on the contract account", keys.keys.length);
  console.log(keys.keys.length ? "  (still has a key, so its code can still be changed)" : "  (no keys, so nobody can change its code)");
}

console.log("\nHow it sits inside the DAO");
show("  DAO", DAO);
const policy = await view(DAO, "get_policy");
const role = policy.roles.find((r) => r.kind.Group?.includes(TACIT));
expect("Tacit has a role in the DAO's own policy", !!role, role?.name);
expect("Tacit is alone in that role", role?.kind.Group.length === 1);
expect("the role holds exactly one permission", role?.permissions.length === 1, role?.permissions.join(", "));
expect("that permission is approving transfers", role?.permissions[0] === "transfer:VoteApprove");
expect("Tacit cannot add proposals, change policy or upgrade", !role?.permissions.some((p) => /AddProposal|policy|upgrade|config|\*:/.test(p)));
const council = policy.roles.find((r) => r.name === "council");
show("  council", council.kind.Group.join(", "));
show("  council vote needed without Tacit", JSON.stringify(policy.default_vote_policy.threshold));

console.log("\nStanding budgets");
const budgets = await view(TACIT, "list_budgets", { dao: DAO, from: 0, limit: 10 });
for (const b of budgets) {
  show(`  #${b.id} ${b.label}`, `${toNear(b.spent)} of ${toNear(b.cap)} NEAR used, window ${Number(b.window_ns) / 1e9}s, ${b.paused_by ? "PAUSED" : "active"}`);
}

console.log("\nPayments that went through silence");
const count = await view(TACIT, "count_spends", { dao: DAO });
const spends = await view(TACIT, "list_spends", { dao: DAO, from: Math.max(0, count - 60), limit: 60 });
const silent = spends.filter((s) => s.status === "Paid" && s.route === "Silence");
show("  paid by silence (recent)", silent.length);
for (const s of silent.slice(-3)) {
  const p = await view(DAO, "get_proposal", { id: Number(s.proposal_id) });
  const voters = Object.keys(p.votes);
  expect(`proposal #${s.proposal_id} paid ${toNear(s.amount)} NEAR to ${s.payee}`, p.status === "Approved" && voters.length === 1 && voters[0] === TACIT, `DAO status ${p.status}, votes from ${voters.join(", ")}`);
}

const contested = spends.filter((s) => ["Contested", "Upheld"].includes(s.status));
console.log("\nPayments where someone spoke up");
for (const s of contested.slice(-3)) {
  const p = await view(DAO, "get_proposal", { id: Number(s.proposal_id) });
  expect(`proposal #${s.proposal_id} (${s.status}) was never voted on by Tacit`, !p.votes[TACIT], `objector ${s.objector}`);
}

console.log(problems ? `\n${problems} check(s) failed` : "\nEverything matches.");
process.exit(problems ? 1 : 0);
