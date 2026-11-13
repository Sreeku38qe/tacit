// Writes TESTNET.md from the latest deployment and end-to-end run, so the links can't drift.
//
//   node scripts/evidence.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", name), "utf8"));
const d = read("testnet.json");
const e = read("testnet-e2e.json");
const acct = (id) => `[\`${id}\`](https://testnet.nearblocks.io/address/${id})`;
const tx = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
const link = (label, url) => (url ? `[${label}](${url})` : label);

const LABELS = [
  ["file_proposal", "Meera files an ordinary Sputnik transfer proposal"],
  ["register_spend", "Tacit checks it against the budget and starts the clock"],
  ["ERR_STILL_SILENT", "Advancing early is refused: `ERR_STILL_SILENT`"],
  ["ERR_NOT_A_MEMBER", "A non-member objection is refused: `ERR_NOT_A_MEMBER`"],
  ["ERR_ALREADY_REGISTERED", "Registering a proposal twice is refused: `ERR_ALREADY_REGISTERED`"],
  ["ERR_ONLY_THE_SPONSOR", "Withdrawing someone else's spend is refused: `ERR_ONLY_THE_SPONSOR`"],
  ["ERR_OVER_PERSONAL_LIMIT", "A payment over the earned limit is refused: `ERR_OVER_PERSONAL_LIMIT`"],
  ["ERR_SELF_PAY", "A steward paying herself is refused: `ERR_SELF_PAY`"],
  ["ERR_NOT_A_STEWARD", "Using a budget without being a steward is refused: `ERR_NOT_A_STEWARD`"],
  ["ERR_NOT_A_TRANSFER", "A non-transfer proposal is refused: `ERR_NOT_A_TRANSFER`"],
  ["ERR_ONLY_THE_DAO", "Changing a budget from outside the DAO is refused: `ERR_ONLY_THE_DAO`"],
  ["object", "Lena objects, and the silence breaks"],
  ["ERR_STILL_CONTESTED", "A contested payment cannot be advanced: `ERR_STILL_CONTESTED`"],
  ["council_reject", "The council rejects it the normal way"],
  ["close_upheld", "The spend closes as Upheld and records update"],
  ["open_pot_register", "A stranger files in the open pot"],
  ["ERR_WINDOW_CLOSED", "An objection after the window is refused: `ERR_WINDOW_CLOSED`"],
  ["silence_vote", "**The window closed in silence. Tacit casts the only vote and Sputnik pays**"],
  ["ERR_STILL_SETTLING", "Approved is not believed until it has settled: `ERR_STILL_SETTLING`"],
  ["close_paid", "The spend closes as Paid after confirming the transfer"],
  ["pause", "One council member pulls the brake on a budget"],
  ["ERR_PAUSED", "A paused budget refuses new spends and votes: `ERR_PAUSED`"],
  ["resume_by_dao", "The DAO's own vote resumes it"],
];

const lines = [
  "# Testnet evidence",
  "",
  `Generated from the run at ${e.ran_at}. ${e.passed} of ${e.total} live checks passed.`,
  "",
  "| What | Account |",
  "|---|---|",
  `| Tacit contract | ${acct(d.contract)} |`,
  `| Community DAO, on the unmodified Sputnik factory | ${acct(d.dao)} |`,
  `| Sputnik factory | ${acct(d.factory)} |`,
  `| Council | ${d.people.council.map(acct).join(", ")} |`,
  `| Members | ${d.people.members.map(acct).join(", ")} |`,
  "",
  "## The install, by the DAO's own votes",
  "",
  ...Object.entries(d.txs)
    .filter(([key]) => /install_role|budget_/.test(key))
    .sort(([a], [b]) => Number(b.startsWith("install")) - Number(a.startsWith("install")))
    .map(([key, hash]) => `- ${link(key.replaceAll("_", " "), tx(hash))}`),
  "",
  "## The run, in order",
  "",
  ...LABELS.filter(([key]) => e.evidence[key]).map(([key, label]) => `- ${link(label, e.evidence[key])}`),
  "",
  "## Every check",
  "",
  "| Check | Result |",
  "|---|---|",
  ...e.checks.map((c) => `| ${c.name} | ${c.ok ? "pass" : "FAIL"} |`),
  "",
  "To repeat the read-only part, run `node scripts/verify.mjs`.",
  "",
];
fs.writeFileSync(path.join(ROOT, "TESTNET.md"), lines.join("\n"));
console.log("TESTNET.md written");
