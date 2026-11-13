// Who is acting. Two modes:
//   demo    served by `node scripts/serve.mjs --demo`: named testnet people whose keys stay on this computer.
//   wallet  any NEAR wallet through near-connect, which is how the real thing is used.
import { CONFIG, view } from "./chain.js";

export const session = { mode: "none", accountId: null, people: [], connector: null };
const listeners = new Set();
export const onSession = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

function remember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable. Nothing depends on it.
  }
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function initSession() {
  try {
    const res = await fetch("/demo/people");
    if (res.ok) {
      session.mode = "demo";
      session.people = await res.json();
      const fromLink = new URLSearchParams(location.search).get("as");
      const saved = fromLink || recall("tacit-persona");
      const wanted = (saved || "").toLowerCase();
      const person = session.people.find((p) => p.id === saved || p.name.toLowerCase() === wanted) || session.people[0];
      session.accountId = person.id;
      changed();
      return;
    }
  } catch {
    // No demo server, so this is a normal visit.
  }
  session.mode = "wallet";
  changed();
  if (recall("tacit-wallet")) connectWallet(true).catch(() => {});
}

export function setPersona(accountId) {
  session.accountId = accountId;
  remember("tacit-persona", accountId);
  changed();
}

async function loadConnector() {
  if (session.connector) return session.connector;
  const { NearConnector } = await import("./vendor/near-connect.js");
  session.connector = new NearConnector({ network: CONFIG.network });
  session.connector.on("wallet:signIn", (event) => {
    session.accountId = event.accounts[0]?.accountId ?? null;
    remember("tacit-wallet", "1");
    changed();
  });
  session.connector.on("wallet:signOut", () => {
    session.accountId = null;
    remember("tacit-wallet", null);
    changed();
  });
  return session.connector;
}

export async function connectWallet(silent = false) {
  const connector = await loadConnector();
  if (silent) {
    const wallet = await connector.wallet();
    const accounts = await wallet.getAccounts();
    session.accountId = accounts[0]?.accountId ?? null;
    changed();
    return;
  }
  await connector.connect();
}

export async function disconnectWallet() {
  if (session.connector) await session.connector.disconnect();
  session.accountId = null;
  remember("tacit-wallet", null);
  changed();
}

function fnCall(methodName, args, tgas, deposit = "0") {
  return { type: "FunctionCall", params: { methodName, args, gas: `${tgas}000000000000`, deposit } };
}

function successValue(outcome) {
  const raw = outcome?.status?.SuccessValue;
  if (typeof raw !== "string" || !raw) return undefined;
  return JSON.parse(atob(raw));
}

async function walletCall(receiverId, action) {
  const wallet = await session.connector.wallet();
  return wallet.signAndSendTransaction({ receiverId, actions: [action], network: CONFIG.network });
}

function failureOf(outcome) {
  const all = [outcome?.transaction_outcome, ...(outcome?.receipts_outcome || [])];
  for (const o of all) {
    const failure = o?.outcome?.status?.Failure;
    if (failure) {
      const text = JSON.stringify(failure);
      const match = text.match(/Smart contract panicked: ([^"\\]+)/);
      return match ? match[1] : text;
    }
  }
  return null;
}

const description = (title, notes) => `* Title: ${title.replace(/<br>/gi, " ")} <br>* Notes: ${notes.replace(/<br>/gi, " ")}`;

const walletActions = {
  async file({ budgetId, payee, amount, title, notes }) {
    const policy = await view(CONFIG.network, CONFIG.dao, "get_policy");
    const filed = await walletCall(
      CONFIG.dao,
      fnCall(
        "add_proposal",
        {
          proposal: {
            description: description(title, notes),
            kind: { Transfer: { token_id: "", receiver_id: payee, amount, msg: null } },
          },
        },
        50,
        policy.proposal_bond,
      ),
    );
    const proposalId = successValue(filed);
    return walletCall(CONFIG.contract, fnCall("register_spend", { budget_id: budgetId, proposal_id: String(proposalId) }, 120));
  },
  object: ({ spendId, reason }) => walletCall(CONFIG.contract, fnCall("object", { spend_id: spendId, reason }, 120)),
  advance: ({ spendId }) => walletCall(CONFIG.contract, fnCall("advance", { spend_id: spendId }, 200)),
  pause: ({ budgetId }) => walletCall(CONFIG.contract, fnCall("pause_budget", { budget_id: budgetId }, 100)),
  vote: ({ proposalId, action, kind }) =>
    walletCall(CONFIG.dao, fnCall("act_proposal", { id: Number(proposalId), action, proposal: kind }, 150)),
};

/** Run an action. Throws an Error whose message is the contract's error code, when there is one. */
export async function act(name, params) {
  if (session.mode === "demo") {
    const res = await fetch("/demo/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: session.accountId, name, params }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "The action failed.");
    return body;
  }
  if (!session.accountId) throw new Error("Connect a wallet first.");
  const outcome = await walletActions[name](params);
  const failure = failureOf(outcome);
  if (failure) throw new Error(failure);
  return outcome;
}
