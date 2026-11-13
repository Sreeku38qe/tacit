// End-to-end test against the live testnet deployment. Takes about four minutes.
//
//   node scripts/e2e.mjs
//
// Every check talks to the real Sputnik DAO and the real Tacit contract. Amounts are tiny.
import fs from "node:fs";
import path from "node:path";
import {
  NEAR,
  ROOT,
  balanceOf,
  call,
  ensureSubaccount,
  explorer,
  fileTransfer,
  keepFloat,
  loadAccount,
  sleep,
  toNear,
  view,
} from "./lib.mjs";

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const { contract: TACIT, dao: DAO } = deployment;
const HQ = TACIT.split(".").slice(1).join(".");
const id = (name) => `${name}.${HQ}`;
const [meera, lena, ines, tomas] = ["meera", "lena", "ines", "tomas"].map((n) => loadAccount(id(n)));
const WORKSHOP = deployment.budgets.find((b) => b.label === "E2E steward").id;
const OPEN_POT = deployment.budgets.find((b) => b.label === "E2E open").id;
const HALL = id("community-hall");

const hq = loadAccount(HQ);
await ensureSubaccount(hq, id("visitor"), "0.25");
for (const name of ["visitor", "meera", "lena", "ines", "tomas"]) await keepFloat(hq, id(name), "0.4");
const visitor = loadAccount(id("visitor"));

const results = [];
const evidence = {};
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const refused = (name, res, code) => {
  const matched = !res.ok && res.failures.some((f) => f.includes(code));
  check(name, matched, matched ? code : res.failures.join("; ") || "was not refused");
  evidence[code] = res.hash;
};
const register = (who, budget, proposalId) =>
  call(who, TACIT, "register_spend", { budget_id: budget, proposal_id: String(proposalId) }, { gas: 120 });
const advance = (who, spendId) => call(who, TACIT, "advance", { spend_id: spendId }, { gas: 200 });
const object = (who, spendId, reason) => call(who, TACIT, "object", { spend_id: spendId, reason }, { gas: 120 });
const spendOf = (spendId) => view(TACIT, "get_spend", { spend_id: spendId });
const recordOf = (account) => view(TACIT, "get_record", { budget_id: WORKSHOP, account });
const vote = (who, proposalId, action, kind) =>
  call(who, DAO, "act_proposal", { id: proposalId, action, proposal: kind }, { gas: 150 });
const transferKind = (receiver, amount) => ({ Transfer: { token_id: "", receiver_id: receiver, amount, msg: null } });
const waitPast = async (ns, label) => {
  const ms = Math.ceil(Number(BigInt(ns) / 1_000_000n) - Date.now()) + 4000;
  if (ms > 0) {
    console.log(`      waiting ${Math.round(ms / 1000)}s for ${label}`);
    await sleep(ms);
  }
};

const startRecord = await recordOf(id("meera"));
const startBalance = BigInt(await balanceOf(HALL));
const startLimit = BigInt(await view(TACIT, "limit_for", { budget_id: WORKSHOP, account: id("meera") }));
const AMOUNT = NEAR("0.08"); // At least a quarter of the starting limit, so it earns credit.
const DUST = NEAR("0.02"); // Under a quarter, so it pays out but earns no credit.

console.log("\n-- The silent path: file, wait, nobody objects, the money moves --");
const quiet = await fileTransfer(meera, DAO, {
  receiver: HALL,
  amount: AMOUNT,
  title: "Hall rental for Saturday's workshop",
  notes: "Filed by Meera under the Workshop costs budget.",
});
evidence.file_proposal = quiet.hash;
const quietReg = await register(meera, WORKSHOP, quiet.proposalId);
check("a steward can place her proposal under silence", quietReg.ok, quietReg.failures.join("; "));
evidence.register_spend = quietReg.hash;
const quietId = quietReg.value;
let spend = await spendOf(quietId);
check("the spend starts Silent", spend.status === "Silent", spend.status);
check("the event names the spend", quietReg.events.some((e) => e.event === "spend_filed"));

refused("advancing before the window closes is refused", await advance(visitor, quietId), "ERR_STILL_SILENT");
refused("a non-member cannot object", await object(visitor, quietId, "I just do not like it"), "ERR_NOT_A_MEMBER");
refused("the same proposal cannot be registered twice", await register(meera, WORKSHOP, quiet.proposalId), "ERR_ALREADY_REGISTERED");

console.log("\n-- Limits are enforced from the DAO's own data --");
const tooBig = await fileTransfer(meera, DAO, { receiver: HALL, amount: (startLimit + BigInt(NEAR("0.01"))).toString(), title: "Too large for the limit" });
refused("a spend over her earned limit is refused", await register(meera, WORKSHOP, tooBig.proposalId), "ERR_OVER_PERSONAL_LIMIT");
const dust = await fileTransfer(meera, DAO, { receiver: HALL, amount: DUST, title: "A tiny payment" });
const dustReg = await register(meera, WORKSHOP, dust.proposalId);
check("a tiny payment can still use the budget", dustReg.ok, dustReg.failures.join("; "));
const selfPay = await fileTransfer(meera, DAO, { receiver: id("meera"), amount: AMOUNT, title: "Paying myself" });
refused("a steward cannot pay herself", await register(meera, WORKSHOP, selfPay.proposalId), "ERR_SELF_PAY");
const stranger = await fileTransfer(visitor, DAO, { receiver: HALL, amount: AMOUNT, title: "From someone with no standing" });
refused("a stranger cannot use a steward's budget", await register(visitor, WORKSHOP, stranger.proposalId), "ERR_NOT_A_STEWARD");
const notTransfer = await call(
  ines,
  DAO,
  "add_proposal",
  { proposal: { description: "A signalling vote", kind: "Vote" } },
  { gas: 50, deposit: NEAR("0.01") },
);
refused("only transfers can go through silence", await register(meera, WORKSHOP, notTransfer.value), "ERR_NOT_A_TRANSFER");
refused(
  "only the DAO can change a budget",
  await call(
    visitor,
    TACIT,
    "update_budget",
    {
      budget_id: WORKSHOP,
      input: {
        label: "Mine now",
        token: null,
        stewards: [id("visitor")],
        open: false,
        allow_self_pay: true,
        window_secs: 60,
        period_secs: 30 * 86400,
        cap: NEAR("100"),
        base_limit: NEAR("100"),
        step: "0",
        max_limit: NEAR("100"),
        expires_at: null,
      },
    },
    { gas: 30 },
  ),
  "ERR_ONLY_THE_DAO",
);

console.log("\n-- The contested path: one objection stops the clock --");
const loud = await fileTransfer(meera, DAO, {
  receiver: id("visitor"),
  amount: AMOUNT,
  title: "Deposit to a vendor nobody knows",
});
const loudReg = await register(meera, WORKSHOP, loud.proposalId);
check("a second spend is filed", loudReg.ok, loudReg.failures.join("; "));
const loudId = loudReg.value;
const objection = await object(lena, loudId, "Nobody has met this vendor. Let's talk first.");
check("a member can object", objection.ok, objection.failures.join("; "));
evidence.object = objection.hash;
spend = await spendOf(loudId);
check("the objection breaks the silence", spend.status === "Contested" && spend.objector === id("lena"), spend.status);
refused("a contested spend cannot be advanced by waiting", await advance(visitor, loudId), "ERR_STILL_CONTESTED");
const loudKind = transferKind(id("visitor"), AMOUNT);
const r1 = await vote(ines, loud.proposalId, "VoteReject", loudKind);
const r2 = await vote(tomas, loud.proposalId, "VoteReject", loudKind);
check("the council can reject it the normal way", r1.ok && r2.ok, [...r1.failures, ...r2.failures].join("; "));
evidence.council_reject = r2.hash;
const closed = await advance(visitor, loudId);
spend = await spendOf(loudId);
check("the spend closes as Upheld", closed.ok && spend.status === "Upheld", spend.status);
evidence.close_upheld = closed.hash;
const lenaRecord = await recordOf(id("lena"));
check("the objector's upheld count rises", lenaRecord.objections_upheld >= 1, JSON.stringify(lenaRecord));
let meeraRecord = await recordOf(id("meera"));
check("the sponsor's clean streak resets", meeraRecord.clean === 0 && meeraRecord.upheld_against > startRecord.upheld_against, JSON.stringify(meeraRecord));

console.log("\n-- A reject vote on the DAO counts as breaking silence --");
const vetoed = await fileTransfer(meera, DAO, { receiver: HALL, amount: AMOUNT, title: "Rejected directly on the DAO" });
const vetoedReg = await register(meera, WORKSHOP, vetoed.proposalId);
const r3 = await vote(ines, vetoed.proposalId, "VoteReject", transferKind(HALL, AMOUNT));
const esc = await advance(visitor, vetoedReg.value);
spend = await spendOf(vetoedReg.value);
check("one council reject escalates it without touching Tacit", r3.ok && esc.ok && spend.status === "Contested", spend.status);
check("the rejecting voter is recorded", spend.objector === id("ines"), String(spend.objector));

console.log("\n-- The open pot: any named account can file and any can object --");
const pot = await fileTransfer(visitor, DAO, { receiver: id("visitor"), amount: NEAR("0.001"), title: "Open pot: snacks" });
const potReg = await register(visitor, OPEN_POT, pot.proposalId);
check("a stranger can file in an open budget", potReg.ok, potReg.failures.join("; "));
evidence.open_pot_register = potReg.hash;
const potId = potReg.value;
const notMine = await fileTransfer(lena, DAO, { receiver: id("lena"), amount: NEAR("0.001"), title: "Lena's own request" });
refused("nobody can start the clock on someone else's request", await register(visitor, OPEN_POT, notMine.proposalId), "ERR_NOT_A_STEWARD");
const potObjected = await fileTransfer(visitor, DAO, { receiver: id("visitor"), amount: NEAR("0.001"), title: "Open pot: contested" });
const potObjectedReg = await register(visitor, OPEN_POT, potObjected.proposalId);
const openObj = await object(visitor, potObjectedReg.value, "Anyone may speak up in an open budget");
check("in an open budget anyone can object", openObj.ok && (await spendOf(potObjectedReg.value)).status === "Contested", openObj.failures.join("; "));

console.log("\n-- Silence holds --");
spend = await spendOf(quietId);
await waitPast(spend.deadline, "the window to close");
refused("an objection after the window closes is refused", await object(lena, quietId, "Too late"), "ERR_WINDOW_CLOSED");
const firstVote = await advance(visitor, quietId);
check("once silence holds, anyone can trigger the vote", firstVote.ok, firstVote.failures.join("; "));
evidence.silence_vote = firstVote.hash;
spend = await spendOf(quietId);
check("Tacit has voted and is confirming payment", spend.status === "Paying" && spend.route === "Silence", spend.status);
const proposal = await view(DAO, "get_proposal", { id: quiet.proposalId });
check("the DAO recorded Tacit's vote alone and approved", proposal.status === "Approved" && proposal.votes[TACIT] === "Approve" && Object.keys(proposal.votes).length === 1, proposal.status);
refused("Approved is not believed until it has settled", await advance(visitor, quietId), "ERR_STILL_SETTLING");
await waitPast(BigInt(spend.voted_at) + 20_000_000_000n, "the transfer to settle");
const settle = await advance(visitor, quietId);
spend = await spendOf(quietId);
check("the spend closes as Paid", settle.ok && spend.status === "Paid", spend.status);
evidence.close_paid = settle.hash;
const paid = BigInt(await balanceOf(HALL)) - startBalance;
check("the money really moved from the DAO to the payee", paid === BigInt(AMOUNT), `${toNear(paid.toString())} NEAR`);

await waitPast((await spendOf(dustReg.value)).deadline, "the tiny payment's window");
await advance(visitor, dustReg.value);
await sleep(21_000);
const dustClosed = await advance(visitor, dustReg.value);
check("the tiny payment was paid", dustClosed.ok && (await spendOf(dustReg.value)).status === "Paid", dustClosed.failures.join("; "));
meeraRecord = await recordOf(id("meera"));
check("a clean spend adds to the sponsor's record", meeraRecord.clean === 1 && meeraRecord.passed === startRecord.passed + 2, JSON.stringify(meeraRecord));
check("the tiny payment earned no credit", meeraRecord.clean === 1, `clean ${meeraRecord.clean} after 2 payments`);
const limit = await view(TACIT, "limit_for", { budget_id: WORKSHOP, account: id("meera") });
check("the earned limit rises by one step", limit === NEAR("0.4"), `${toNear(limit)} NEAR`);

const potSpend = await spendOf(potId);
await waitPast(potSpend.deadline, "the open pot window");
await advance(visitor, potId);
await sleep(21_000);
const potSettle = await advance(visitor, potId);
check("the open pot paid the stranger", potSettle.ok && (await spendOf(potId)).status === "Paid", potSettle.failures.join("; "));

console.log("\n-- The brake: one council member can stop a budget, only the DAO can restart it --");
const stopped = await fileTransfer(meera, DAO, { receiver: HALL, amount: AMOUNT, title: "Caught by the brake" });
const stoppedReg = await register(meera, WORKSHOP, stopped.proposalId);
check("a payment is waiting when the brake is pulled", stoppedReg.ok, stoppedReg.failures.join("; "));
const second = await fileTransfer(meera, DAO, { receiver: HALL, amount: AMOUNT, title: "Also waiting when the brake is pulled" });
const secondReg = await register(meera, WORKSHOP, second.proposalId);
const pause = await call(tomas, TACIT, "pause_budget", { budget_id: WORKSHOP }, { gas: 100 });
check("a council member can pause a budget", pause.ok, pause.failures.join("; "));
evidence.pause = pause.hash;
const blockedNew = await fileTransfer(meera, DAO, { receiver: HALL, amount: AMOUNT, title: "Filed while paused" });
refused("a paused budget refuses new spends", await register(meera, WORKSHOP, blockedNew.proposalId), "ERR_PAUSED");
spend = await spendOf(stoppedReg.value);
await waitPast(spend.deadline, "a due spend under a paused budget");
refused("a paused budget will not cast a vote", await advance(visitor, stoppedReg.value), "ERR_PAUSED");
refused("a stranger cannot resume it", await call(visitor, TACIT, "resume_budget", { budget_id: WORKSHOP }, { gas: 30 }), "ERR_ONLY_THE_DAO");
const lateObjection = await object(lena, stoppedReg.value, "Past the deadline, but the clock is stopped");
check("a pause keeps the window open for objections", lateObjection.ok && (await spendOf(stoppedReg.value)).status === "Contested", lateObjection.failures.join("; "));

const resumeKind = {
  FunctionCall: {
    receiver_id: TACIT,
    actions: [
      {
        method_name: "resume_budget",
        args: Buffer.from(JSON.stringify({ budget_id: WORKSHOP })).toString("base64"),
        deposit: "0",
        gas: "30000000000000",
      },
    ],
  },
};
const resumeProposal = await call(
  ines,
  DAO,
  "add_proposal",
  { proposal: { description: "* Title: Resume the Workshop costs budget <br>* Notes: Checked after the pause.", kind: resumeKind } },
  { gas: 50, deposit: NEAR("0.01") },
);
await vote(ines, resumeProposal.value, "VoteApprove", resumeKind);
const resumed = await vote(tomas, resumeProposal.value, "VoteApprove", resumeKind);
const budget = await view(TACIT, "get_budget", { budget_id: WORKSHOP });
check("the DAO's own vote resumes the budget", resumed.ok && budget.paused_by === null, String(budget.paused_by));
evidence.resume_by_dao = resumed.hash;
refused("resuming gives waiting payments a fresh window", await advance(visitor, secondReg.value), "ERR_STILL_SILENT");
const objectAfterResume = await object(lena, secondReg.value, "Glad the clock restarted");
check("people can still object after a resume", objectAfterResume.ok && (await spendOf(secondReg.value)).status === "Contested", objectAfterResume.failures.join("; "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
const output = {
  ran_at: new Date().toISOString(),
  contract: TACIT,
  dao: DAO,
  passed: results.length - failed.length,
  total: results.length,
  checks: results,
  evidence: Object.fromEntries(Object.entries(evidence).map(([k, hash]) => [k, explorer(hash)])),
};
fs.writeFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), JSON.stringify(output, null, 2) + "\n");
process.exit(failed.length ? 1 : 0);
