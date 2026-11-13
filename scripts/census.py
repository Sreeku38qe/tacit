#!/usr/bin/env python3
"""Measure how Sputnik DAO proposals actually end on NEAR mainnet.

Uses only public RPC view calls and the Python standard library. No keys, no writes.

    python scripts/census.py fetch            # about 45 minutes on free RPCs; safe to re-run
    python scripts/census.py report           # writes data/census.json and web/census.json

`fetch` saves every DAO's policy and full proposal history under data/raw/. Re-running it only
retries DAOs that failed. `report` turns that into the numbers quoted in the README and on the site.

Definitions used in the report:
  died        InProgress past the DAO's proposal period, or status Expired.
  no dissent  no Reject or Remove vote was ever cast.
  only yes    at least one Approve vote and no other vote.
  voters      accounts in any Group role that may approve proposals.

Two adjustments, both listed in the output so anyone can undo them:
  MACHINE     DAOs run by bots, which say nothing about people. Left out of every count.
  NEWSROOMS   DAOs where every article is a proposal and editors reject submissions as routine.
              Counted in "all". Reported separately because they hold most rejections on the chain.
"""
import base64
import collections
import concurrent.futures as cf
import json
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "census.jsonl")
OUT = os.path.join(ROOT, "data", "census.json")
WEB_OUT = os.path.join(ROOT, "web", "census.json")
FACTORY = "sputnik-dao.near"
RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"]
WORKERS = 5
PAGE = 100
YOCTO = 10**24
MACHINE = {"bridge-validator.sputnik-dao.near": "234,000 proposals filed by bridge software"}
NEWSROOMS = {"nearweek-news-contribution.sputnik-dao.near", "news.sputnik-dao.near"}


def post(url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "user-agent": "tacit-census/1.0"},
    )
    with urllib.request.urlopen(req, timeout=40) as res:
        return json.loads(res.read().decode())


class ContractError(Exception):
    """The contract itself answered with an error. Retrying will not help."""


def query(params, tries=12):
    last = None
    for attempt in range(tries):
        url = random.choice(RPCS)
        try:
            res = post(url, {"jsonrpc": "2.0", "id": "1", "method": "query", "params": params})
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
            last = err
            time.sleep(min(10, 0.7 * (attempt + 1)))
            continue
        if "error" in res:
            text = json.dumps(res["error"])
            if "wasm execution failed" in text or "UNKNOWN_ACCOUNT" in text or "CodeDoesNotExist" in text or "MethodNotFound" in text:
                raise ContractError(text[:300])
            last = text
            time.sleep(min(10, 0.7 * (attempt + 1)))
            continue
        result = res.get("result", {})
        if isinstance(result, dict) and "error" in result:
            raise ContractError(str(result["error"])[:300])
        return result
    raise RuntimeError(str(last)[:300])


def view(account, method, args):
    result = query(
        {
            "request_type": "call_function",
            "finality": "final",
            "account_id": account,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        }
    )
    return json.loads(bytes(result["result"]).decode())


def balance(account):
    return int(query({"request_type": "view_account", "finality": "final", "account_id": account})["amount"])


def compact(p):
    kind = p["kind"]
    name = kind if isinstance(kind, str) else next(iter(kind))
    row = {"id": p["id"], "s": p["status"], "k": name, "t": int(p["submission_time"]) // 10**9, "v": p["votes"], "by": p["proposer"]}
    if name == "Transfer":
        row["token"] = kind["Transfer"]["token_id"]
        row["amount"] = kind["Transfer"]["amount"]
        row["to"] = kind["Transfer"]["receiver_id"]
    return row


def read_proposals(dao, last):
    rows, index, size, skipped = [], 0, PAGE, 0
    while index < last:
        try:
            page = view(dao, "get_proposals", {"from_index": index, "limit": size})
        except (ContractError, RuntimeError):
            if size > 1:
                size = max(1, size // 4)
                continue
            skipped += 1
            index += 1
            size = PAGE
            continue
        if not page:
            index += size
            continue
        rows.extend(compact(p) for p in page)
        index = page[-1]["id"] + 1
        size = PAGE
    return rows, skipped


def read_dao(dao):
    row = {"dao": dao}
    try:
        row["near"] = str(balance(dao))
        policy = view(dao, "get_policy", {})
        # DAOs that never upgraded from the first Sputnik version keep a differently named field.
        period = policy.get("proposal_period", policy.get("proposal_time"))
        row["period"] = int(period) // 10**9
        row["bond"] = policy["proposal_bond"]
        voters = set()
        for role in policy["roles"]:
            kind = role["kind"]
            if isinstance(kind, dict) and "Group" in kind:
                perms = role["permissions"]
                if any(p.endswith(":VoteApprove") or p.endswith(":*") for p in perms):
                    voters.update(kind["Group"])
        row["voters"] = sorted(voters)
        last = view(dao, "get_last_proposal_id", {})
        row["last_id"] = last
        row["proposals"], row["skipped"] = read_proposals(dao, last)
    except (ContractError, RuntimeError, KeyError, TypeError, ValueError, json.JSONDecodeError) as err:
        row["error"] = repr(err)[:300]
    return row


def latest_rows():
    latest = {}
    if os.path.exists(RAW):
        with open(RAW, encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                latest[row["dao"]] = row
    return latest


def fetch():
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    done = {dao for dao, row in latest_rows().items() if "error" not in row}
    daos = view(FACTORY, "get_dao_list", {})
    todo = [d for d in daos if d not in done and d not in MACHINE]
    print(f"{len(daos)} DAOs on {FACTORY}, {len(todo)} to read", flush=True)
    started = time.time()
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool, open(RAW, "a", encoding="utf-8") as out:
        futures = [pool.submit(read_dao, d) for d in todo]
        for n, future in enumerate(cf.as_completed(futures), 1):
            out.write(json.dumps(future.result(), separators=(",", ":")) + "\n")
            out.flush()
            if n % 100 == 0:
                print(n, "of", len(todo), f"{time.time() - started:.0f}s", flush=True)
    print("done", flush=True)


def outcome(dao, p, now):
    if p["s"] == "InProgress" and p["t"] + dao["period"] < now:
        return "Stale"
    return p["s"]


def no_dissent(p):
    return all(v == "Approve" for v in p["v"].values())


def tally(rows):
    """rows: list of (dao, proposal, outcome)."""
    counts = collections.Counter(o for _, _, o in rows)
    died = [x for x in rows if x[2] in ("Stale", "Expired")]
    silent = [x for x in died if no_dissent(x[1])]
    only_yes = [x for x in silent if x[1]["v"]]
    approved = [x for x in rows if x[2] == "Approved"]
    return {
        "total": len(rows),
        "approved": len(approved),
        "rejected": counts.get("Rejected", 0) + counts.get("Removed", 0),
        "failed": counts.get("Failed", 0),
        "open": counts.get("InProgress", 0),
        "died": len(died),
        "died_no_dissent": len(silent),
        "died_no_votes": len(silent) - len(only_yes),
        "died_only_yes": len(only_yes),
        "approved_with_no_dissent": sum(1 for x in approved if no_dissent(x[1])),
    }


def compare_per_dao(rows, count_silent):
    """In how many DAOs did silence kill more proposals than rejection, counting each DAO once?"""
    by_dao = collections.defaultdict(lambda: [0, 0])
    for dao, p, end in rows:
        cell = by_dao[dao["dao"]]
        if end in ("Rejected", "Removed"):
            cell[1] += 1
        elif end in ("Stale", "Expired") and count_silent(p):
            cell[0] += 1
    cells = [c for c in by_dao.values() if c[0] or c[1]]
    return {
        "daos_where_a_proposal_failed": len(cells),
        "silence_killed_more": sum(1 for s, r in cells if s > r),
        "rejection_killed_more": sum(1 for s, r in cells if r > s),
        "tied": sum(1 for s, r in cells if s == r),
    }


def repeat_outcomes(rows):
    outcomes = collections.Counter()
    by_pair = collections.defaultdict(list)
    for r in sorted((x for x in rows if x[1]["k"] == "Transfer"), key=lambda x: x[1]["t"]):
        by_pair[(r[0]["dao"], r[1]["to"])].append(r)
    for seq in by_pair.values():
        approved = 0
        for r in seq:
            if approved >= 3:
                outcomes[r[2]] += 1
            if r[2] == "Approved":
                approved += 1
    return dict(outcomes)


def near_sum(rows):
    return sum(int(p["amount"]) for _, p, _ in rows if p.get("token") == "") / YOCTO


def report():
    now = time.time()
    latest = latest_rows()
    daos = [r for r in latest.values() if "error" not in r and r["dao"] not in MACHINE]
    unreadable = sorted(d for d, r in latest.items() if "error" in r)

    rows = [(d, p, outcome(d, p, now)) for d in daos for p in d["proposals"]]
    no_news = [r for r in rows if r[0]["dao"] not in NEWSROOMS]
    multi = [r for r in rows if len(r[0]["voters"]) >= 2]
    multi_no_news = [r for r in multi if r[0]["dao"] not in NEWSROOMS]
    year = now - 365 * 86400
    recent_no_news = [r for r in no_news if r[1]["t"] >= year]
    recent_multi = [r for r in multi_no_news if r[1]["t"] >= year]
    transfers_no_news = [r for r in no_news if r[1]["k"] == "Transfer"]
    last_seen = {d["dao"]: max((p["t"] for p in d["proposals"]), default=0) for d in daos}

    silent_yes_transfers = [
        r for r in transfers_no_news if r[2] in ("Stale", "Expired") and no_dissent(r[1]) and r[1]["v"]
    ]

    turnout = []
    for d, p, _ in rows:
        voters = set(d["voters"])
        if len(voters) >= 3:
            turnout.append(len(voters & set(p["v"])) / len(voters))

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "source": f"public view calls against {FACTORY} and every DAO it created",
        "left_out_as_machine_run": MACHINE,
        "reported_separately_as_newsrooms": sorted(NEWSROOMS),
        "unreadable": unreadable,
        "daos": {
            "read": len(daos),
            "with_a_proposal": sum(1 for v in last_seen.values() if v),
            "active_last_90d": sum(1 for v in last_seen.values() if v >= now - 90 * 86400),
            "active_last_365d": sum(1 for v in last_seen.values() if v >= year),
            "with_two_or_more_voters": sum(1 for d in daos if len(d["voters"]) >= 2),
            "single_voter": sum(1 for d in daos if len(d["voters"]) == 1),
        },
        "per_dao": compare_per_dao(rows, no_dissent),
        "per_dao_two_or_more_voters": compare_per_dao(multi, no_dissent),
        "per_dao_counting_only_proposals_with_a_yes": compare_per_dao(rows, lambda p: no_dissent(p) and bool(p["v"])),
        "all": tally(rows),
        "newsrooms": tally([r for r in rows if r[0]["dao"] in NEWSROOMS]),
        "without_newsrooms": tally(no_news),
        "without_newsrooms_two_or_more_voters": tally(multi_no_news),
        "without_newsrooms_transfers": tally(transfers_no_news),
        "without_newsrooms_last_365d": tally(recent_no_news),
        "without_newsrooms_last_365d_two_or_more_voters": tally(recent_multi),
        "near_requested_in_transfers_with_only_yes_votes_that_died": round(near_sum(silent_yes_transfers)),
        "repeat_payees_without_newsrooms": {
            "note": "transfers to an account this DAO had already paid three or more times",
            "outcomes": repeat_outcomes(no_news),
        },
        "average_voter_turnout_where_three_or_more_voters": round(statistics.mean(turnout), 3) if turnout else None,
        "bond_near_most_common": collections.Counter(int(d["bond"]) / YOCTO for d in daos).most_common(4),
        "proposal_period_days_most_common": collections.Counter(round(d["period"] / 86400, 1) for d in daos).most_common(3),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for path in (OUT, WEB_OUT):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "fetch":
        fetch()
    elif command == "report":
        report()
    else:
        sys.exit(__doc__)
