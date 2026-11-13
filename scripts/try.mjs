// Watch silence pay you. Needs any funded testnet account of your own. Takes about two minutes.
//
//   near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
//   node scripts/try.mjs <name>.testnet
//
// Files a real Sputnik transfer proposal paying you 0.001 NEAR from the demo DAO's open pot,
// tries to cheat the clock, waits for the window to close, and collects the money.
// Every step reads the chain first, so it copes with slow RPCs or someone else closing the window.
import fs from "node:fs";
import path from "node:path";
import { NEAR, ROOT, balanceOf, call, explorer, fileTransfer, loadAccount, sleep, toNear, view } from "./lib.mjs";

const me = process.argv[2];
if (!me) {
  console.error("usage: node scripts/try.mjs <your-account.testnet>");
  process.exit(2);
}

const { contract: TACIT, dao: DAO, budgets } = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const POT = budgets.find((b) => b.label === "Open pot").id;
const account = loadAccount(me);
const AMOUNT = NEAR("0.001");
const step = (text) => console.log(`\n${text}`);
const link = (hash) => `    ${explorer(hash)}`;

const budget = await view(TACIT, "get_budget", { budget_id: POT });
if (BigInt(budget.spent) + BigInt(AMOUNT) > BigInt(budget.cap)) {
  console.error("The open pot has hit its daily cap. Try again tomorrow.");
  process.exit(1);
}

step(`1. Filing an ordinary Sputnik proposal on ${DAO}: pay ${me} 0.001 NEAR.`);
const filed = await fileTransfer(account, DAO, { receiver: me, amount: AMOUNT, title: "Open pot test", notes: "Filed by scripts/try.mjs" });
console.log(`   Proposal #${filed.proposalId}`);
console.log(link(filed.hash));

step("2. Asking Tacit to put it under silence.");
const registered = await call(account, TACIT, "register_spend", { budget_id: POT, proposal_id: String(filed.proposalId) }, { gas: 120 });
if (!registered.ok) throw new Error(registered.failures.join("; "));
const spendId = registered.value;
const spendNow = () => view(TACIT, "get_spend", { spend_id: spendId });
let spend = await spendNow();
console.log(`   Spend ${spendId} is ${spend.status}. Nobody has voted.`);
console.log(link(registered.hash));

const msUntil = (ns) => Number(BigInt(ns) / 1_000_000n) - Date.now();

step("3. Trying to take the money before the window closes.");
if (spend.status === "Silent" && msUntil(spend.deadline) > 15_000) {
  const early = await call(account, TACIT, "advance", { spend_id: spendId }, { gas: 200 });
  console.log(`   ${early.ok ? "The window closed before this arrived, so it went through." : `Refused: ${early.failures[0]}`}`);
  console.log(link(early.hash));
} else {
  console.log("   Skipped: the window closed before this step could run. RPC is slow right now.");
}

spend = await spendNow();
if (spend.status === "Silent" && msUntil(spend.deadline) > -4000) {
  const wait = msUntil(spend.deadline) + 4000;
  step(`4. Doing nothing for ${Math.round(wait / 1000)} seconds. That is the whole point.`);
  await sleep(Math.max(0, wait));
} else {
  step("4. The window has already closed. Nobody objected.");
}

step("5. The window closed with no objection. Anyone can call advance, so you do.");
spend = await spendNow();
if (spend.status === "Silent") {
  const voted = await call(account, TACIT, "advance", { spend_id: spendId }, { gas: 200 });
  if (!voted.ok) throw new Error(voted.failures.join("; "));
  console.log(link(voted.hash));
} else {
  console.log(`   Someone already did. The spend is ${spend.status}.`);
}
const proposal = await view(DAO, "get_proposal", { id: filed.proposalId });
console.log(`   The DAO shows ${proposal.status}. Votes: ${JSON.stringify(proposal.votes)}`);

step("6. Waiting for Tacit to confirm the transfer really ran.");
for (let attempt = 0; attempt < 12; attempt += 1) {
  spend = await spendNow();
  if (spend.status !== "Voting" && spend.status !== "Paying") break;
  const settle = spend.voted_at ? msUntil(spend.voted_at) + 21_000 : 3000;
  if (settle > 0) await sleep(settle);
  const closed = await call(account, TACIT, "advance", { spend_id: spendId }, { gas: 200 });
  if (closed.ok) console.log(link(closed.hash));
}
spend = await spendNow();
console.log(`   Spend ${spendId} is ${spend.status}, by ${spend.route}.`);

step("Result");
console.log(`   The DAO paid you ${toNear(AMOUNT, 3)} NEAR. Your balance is now ${toNear(await balanceOf(me))} NEAR.`);
if (spend.status === "Paid" && Object.keys(proposal.votes).length === 1 && proposal.votes[TACIT]) {
  console.log("   No council member voted. Tacit's own vote was the only one.");
}
process.exit(spend.status === "Paid" ? 0 : 1);
