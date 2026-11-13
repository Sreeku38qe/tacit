// The Silence Report for one DAO. Uses the same definitions as scripts/census.py.
import { view } from "./chain.js";

const MAX_PROPOSALS = 400;
const PAGE = 100;

export async function loadDao(dao) {
  const network = "mainnet";
  const [policy, last] = await Promise.all([view(network, dao, "get_policy"), view(network, dao, "get_last_proposal_id")]);
  const start = Math.max(0, last - MAX_PROPOSALS);
  const pages = [];
  for (let from = start; from < last; from += PAGE) pages.push(view(network, dao, "get_proposals", { from_index: from, limit: PAGE }));
  const proposals = (await Promise.all(pages)).flat();
  return { policy, proposals, last, sampled: proposals.length };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function kindOf(p) {
  return typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0];
}

function votersOf(policy) {
  const voters = new Set();
  for (const role of policy.roles) {
    if (role.kind && role.kind.Group && role.permissions.some((x) => x.endsWith(":VoteApprove") || x.endsWith(":*"))) {
      role.kind.Group.forEach((m) => voters.add(m));
    }
  }
  return voters;
}

export function analyse({ policy, proposals }, nowMs = Date.now()) {
  const period = Number(policy.proposal_period) / 1e6;
  const outcome = (p) =>
    p.status === "InProgress" && Number(p.submission_time) / 1e6 + period < nowMs ? "Stale" : p.status;
  const rows = proposals.map((p) => ({ p, kind: kindOf(p), end: outcome(p), votes: Object.values(p.votes) }));
  const count = (f) => rows.filter(f).length;
  const noDissent = (r) => r.votes.every((v) => v === "Approve");
  const died = (r) => r.end === "Stale" || r.end === "Expired";
  const voters = votersOf(policy);

  const transfers = rows.filter((r) => r.kind === "Transfer");
  const nearAmount = (r) => (r.p.kind.Transfer.token_id === "" ? BigInt(r.p.kind.Transfer.amount) : null);
  const isNear = (r) => r.p.kind.Transfer.token_id === "";
  const approvedNear = transfers.filter((r) => r.end === "Approved" && isNear(r));
  const silentTransfers = transfers.filter((r) => died(r) && noDissent(r));

  let suggestion = null;
  if (approvedNear.length >= 3) {
    const amounts = approvedNear.map(nearAmount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const limit = percentile(amounts, 0.8);
    const byMonth = new Map();
    for (const r of approvedNear) {
      const month = Math.floor(Number(r.p.submission_time) / 1e6 / (30 * 86400000));
      byMonth.set(month, (byMonth.get(month) || 0n) + nearAmount(r));
    }
    const months = [...byMonth.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const cap = percentile(months, 0.75);
    const wouldFit = silentTransfers.filter((r) => isNear(r) && nearAmount(r) <= limit).length;
    suggestion = { limit: limit.toString(), cap: (cap > limit ? cap : limit).toString(), wouldFit, basedOn: approvedNear.length };
  }

  const repeat = new Map();
  for (const r of transfers) {
    if (r.end !== "Approved") continue;
    const to = r.p.kind.Transfer.receiver_id;
    repeat.set(to, (repeat.get(to) || 0) + 1);
  }
  const repeatPayees = [...repeat.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const withVoters = rows.filter(() => voters.size > 0);
  const turnout = withVoters.length
    ? withVoters.reduce((sum, r) => sum + Object.keys(r.p.votes).filter((v) => voters.has(v)).length / voters.size, 0) / withVoters.length
    : 0;

  return {
    total: rows.length,
    approved: count((r) => r.end === "Approved"),
    rejected: count((r) => r.end === "Rejected" || r.end === "Removed"),
    failed: count((r) => r.end === "Failed"),
    open: count((r) => r.end === "InProgress"),
    silent: count((r) => died(r) && noDissent(r)),
    onlyYes: count((r) => died(r) && noDissent(r) && r.votes.length > 0),
    voters: voters.size,
    turnout,
    transfers: transfers.length,
    silentTransfers: silentTransfers.length,
    suggestion,
    repeatPayees,
    periodDays: Math.round(period / 86400000),
    bond: policy.proposal_bond,
  };
}
