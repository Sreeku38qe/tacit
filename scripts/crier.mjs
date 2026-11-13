// The town crier: silence only means something if people were told. This turns every open
// notice into a near.social post. Dry-run by default, because a post is public and lasts.
//
//   node scripts/crier.mjs                  # print what would be posted
//   SOCIAL_ACCOUNT=you.near SOCIAL_KEY=ed25519:... node scripts/crier.mjs --post
//
// near.social lives on mainnet, so the signing account must be a mainnet account. Each post is a
// write to the `social` account, which always shows as failed (CodeDoesNotExist) even though the
// data lands. That is how near.social works; the script confirms each write through its indexer.
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, actions } from "near-api-js";
import { ROOT, toNear, view } from "./lib.mjs";

const POST = process.argv.includes("--post");
const { contract: TACIT, dao: DAO, network } = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const SITE = process.env.TACIT_SITE || "https://github.com/";

/** The exact key/value write near.social expects for a new post. */
export function socialArgs(text, nowMs = Date.now()) {
  return { [`post/${nowMs}`]: { text } };
}

async function confirm(hash) {
  for (let i = 0; i < 15; i += 1) {
    const res = await fetch(`https://api2.near.social/v1/tx/${hash}`);
    if (res.ok) {
      const body = await res.json();
      if (body.indexed) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

const count = await view(TACIT, "count_spends", { dao: DAO });
const spends = await view(TACIT, "list_spends", { dao: DAO, from: Math.max(0, count - 20), limit: 20 });
const budgets = await view(TACIT, "list_budgets", { dao: DAO, from: 0, limit: 10 });
const open = spends.filter((s) => s.status === "Silent");
const notices = await Promise.all(
  open.map(async (s) => {
    const proposal = await view(DAO, "get_proposal", { id: Number(s.proposal_id) });
    const title = (proposal.description.match(/\* Title:\s*(.*?)\s*(?:<br>|$)/i) || [])[1] || proposal.description;
    const budget = budgets.find((b) => b.id === s.budget_id);
    const fresh = budget?.resumed_at ? BigInt(budget.resumed_at) + BigInt(budget.window_ns) : 0n;
    const deadline = fresh > BigInt(s.deadline) ? fresh : BigInt(s.deadline);
    const when = new Date(Number(deadline / 1_000_000n)).toUTCString();
    const net = network === "mainnet" ? "" : ` [${network}]`;
    return {
      spend: s.id,
      text: `Notice${net}: ${DAO} will pay ${toNear(s.amount, 3)} NEAR to ${s.payee} for "${title}" unless a member objects before ${when}. Answerable: ${s.sponsor}. #tacit`,
    };
  }),
);

if (!notices.length) console.log("No notices are open right now.");
for (const notice of notices) {
  console.log(`Spend ${notice.spend}\n  ${notice.text}\n  near.social args: ${JSON.stringify(socialArgs(notice.text, 1760000000000))}`);
}

if (POST) {
  const accountId = process.env.SOCIAL_ACCOUNT;
  const key = process.env.SOCIAL_KEY;
  if (!accountId || !key) throw new Error("--post needs SOCIAL_ACCOUNT and SOCIAL_KEY");
  const provider = new JsonRpcProvider({ url: "https://free.rpc.fastnear.com" });
  const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(key));
  for (const notice of notices) {
    const res = await account.signAndSendTransaction({
      receiverId: "social",
      actions: [actions.functionCall("__fastdata_kv", socialArgs(notice.text), 1_000_000_000n, 0n)],
      throwOnFailure: false,
    });
    const indexed = await confirm(res.transaction.hash);
    console.log(`Posted spend ${notice.spend}: tx ${res.transaction.hash}, indexed: ${indexed ? "yes" : "not yet"}`);
  }
} else {
  console.log("\nDry run. Nothing was posted. Add --post with SOCIAL_ACCOUNT and SOCIAL_KEY to publish.");
}
void SITE;
