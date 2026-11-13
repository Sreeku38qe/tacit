// Direct, read-only access to NEAR RPC from the browser. No backend involved.
export const CONFIG = {
  network: "testnet",
  contract: "v1.tacit-hq.testnet",
  dao: "sunday-makers.sputnikv2.testnet",
  explorer: { testnet: "https://testnet.nearblocks.io", mainnet: "https://nearblocks.io" },
};

const RPC = {
  // drpc first: FastNEAR's rate-limit responses carry no CORS headers, so browsers report them as network errors.
  testnet: ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"],
  mainnet: ["https://near.drpc.org", "https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

async function rpc(network, method, params) {
  let lastError = new Error("No RPC endpoint answered");
  for (const url of RPC[network]) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tacit", method, params }),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (!res.ok) {
      lastError = new Error(`RPC answered ${res.status}`);
      continue;
    }
    const body = await res.json();
    if (body.error) {
      if (body.error.cause?.name === "UNKNOWN_ACCOUNT") throw new Error("That account does not exist.");
      lastError = new Error(body.error.data || body.error.message);
      continue;
    }
    if (body.result?.error) throw new Error(body.result.error);
    return body.result;
  }
  throw lastError;
}

export async function view(network, account, method, args = {}) {
  const result = await rpc(network, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

export async function accountOf(network, account) {
  return rpc(network, "query", { request_type: "view_account", finality: "optimistic", account_id: account });
}

const YOCTO = 10n ** 24n;

export function nearToYocto(text) {
  const [whole, frac = ""] = String(text).trim().split(".");
  return (BigInt(whole || "0") * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24))).toString();
}

export function formatNear(yocto, digits = 3) {
  const value = BigInt(yocto);
  const scaled = (value * 10n ** BigInt(digits) + YOCTO / 2n) / YOCTO;
  const text = scaled.toString().padStart(digits + 1, "0");
  const whole = text.slice(0, -digits);
  const frac = text.slice(-digits).replace(/0+$/, "");
  return `${Number(whole).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export const explorerAccount = (network, account) => `${CONFIG.explorer[network]}/address/${account}`;
export const explorerTx = (network, hash) => `${CONFIG.explorer[network]}/txns/${hash}`;
