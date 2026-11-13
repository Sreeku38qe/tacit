// Shared helpers for the deploy, demo and test scripts.
// Keys are read from ~/.near-credentials (written by near-cli), never from this repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  teraToGas,
} from "near-api-js";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const NETWORK = process.env.NEAR_NETWORK || "testnet";

const RPCS = {
  testnet: ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"],
};

export const provider = new FailoverRpcProvider(RPCS[NETWORK].map((url) => new JsonRpcProvider({ url })));

const CRED_DIR = path.join(os.homedir(), ".near-credentials", NETWORK);

export const NEAR = (amount) => {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole + frac.padEnd(24, "0").slice(0, 24)).toString();
};
export const toNear = (yocto, digits = 4) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(digits);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasKey(accountId) {
  return fs.existsSync(path.join(CRED_DIR, `${accountId}.json`));
}

export function loadAccount(accountId) {
  const file = path.join(CRED_DIR, `${accountId}.json`);
  const { private_key: privateKey } = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey));
}

export function saveKey(accountId, keyPair) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  const file = path.join(CRED_DIR, `${accountId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }),
    { mode: 0o600 },
  );
}

/** A plain RPC read, because the failover provider logs every "no such account" answer as an error. */
export async function exists(accountId) {
  for (const url of RPCS[NETWORK]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tacit",
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: accountId },
        }),
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.result) return true;
      const cause = body.error?.cause?.name;
      if (cause === "UNKNOWN_ACCOUNT") return false;
    } catch {
      // Try the next endpoint.
    }
  }
  throw new Error(`could not tell whether ${accountId} exists`);
}

export const balanceOf = async (accountId) =>
  (await provider.viewAccount({ accountId, blockQuery: { finality: "final" } })).amount.toString();

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
}

function collectFailure(status) {
  if (status && typeof status === "object" && status.Failure) {
    return JSON.stringify(status.Failure);
  }
  return null;
}

/** The error text of a failed outcome, with the contract's own message pulled out when there is one. */
function readableError(raw) {
  const match = raw.match(/Smart contract panicked: ([^"\\]+)/);
  return match ? match[1] : raw;
}

/** Send a transaction, wait for all receipts, and report what really happened. */
export async function send(account, receiverId, txActions) {
  const res = await account.signAndSendTransaction({
    receiverId,
    actions: txActions,
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const hash = res.transaction.hash;
  const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
  const logs = outcomes.flatMap((o) => o.outcome.logs);
  const failures = outcomes.map((o) => collectFailure(o.outcome.status)).filter(Boolean).map(readableError);
  const success = res.status?.SuccessValue;
  let value;
  if (typeof success === "string" && success.length) {
    try {
      value = JSON.parse(Buffer.from(success, "base64").toString());
    } catch {
      value = undefined;
    }
  }
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
  return { hash, ok: failures.length === 0, failures, logs, events, value };
}

export function call(account, contractId, method, args = {}, { gas = 300, deposit = "0" } = {}) {
  return send(account, contractId, [actions.functionCall(method, args, teraToGas(gas), BigInt(deposit))]);
}

/** Create `<name>.<parent>` funded with `near` NEAR, and keep its key in ~/.near-credentials. */
export async function ensureSubaccount(parent, accountId, near) {
  if (await exists(accountId)) return false;
  const keyPair = KeyPair.fromRandom("ed25519");
  const res = await send(parent, accountId, [
    actions.createAccount(),
    actions.transfer(BigInt(NEAR(near))),
    actions.addFullAccessKey(keyPair.getPublicKey()),
  ]);
  if (!res.ok) throw new Error(`could not create ${accountId}: ${res.failures.join("; ")}`);
  saveKey(accountId, keyPair);
  return true;
}

/** A transaction reserves gas up front at about 10x the gas price, so signers need a float. */
export async function keepFloat(funder, accountId, near) {
  const have = BigInt(await balanceOf(accountId));
  const want = BigInt(NEAR(near));
  if (have >= want) return;
  const res = await send(funder, accountId, [actions.transfer(want - have)]);
  if (!res.ok) throw new Error(`could not fund ${accountId}: ${res.failures.join("; ")}`);
}

export { actions, teraToGas };

export const explorer = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

/** The Trezu payment-request description format: "* Title: ... <br>* Notes: ..." */
export const trezuDescription = (title, notes) => `* Title: ${title} <br>* Notes: ${notes}`;

/** File a normal Sputnik transfer proposal. Returns its proposal id. */
export async function fileTransfer(account, dao, { receiver, amount, title, notes = "", token = "" }) {
  const policy = await view(dao, "get_policy");
  const res = await call(
    account,
    dao,
    "add_proposal",
    {
      proposal: {
        description: trezuDescription(title, notes),
        kind: { Transfer: { token_id: token, receiver_id: receiver, amount, msg: null } },
      },
    },
    { gas: 50, deposit: policy.proposal_bond },
  );
  if (!res.ok) throw new Error(`add_proposal failed: ${res.failures.join("; ")}`);
  return { proposalId: res.value, hash: res.hash };
}
