# Tacit

A silence procedure for Sputnik DAO budgets on NEAR.

A DAO's council approves a budget once. After that, a transfer inside the budget goes through unless someone objects before a deadline. An objection sends it back to the DAO's normal vote.

- **Built at:** NEAR HACKATHON, November 2026
- **Track:** Social Money (`social`)
- **Built on:** Sputnik DAO v2, Trezu's proposal format, NEAR named accounts
- **Network:** NEAR testnet. The Silence Report reads mainnet.
- **Contract:** `v1.tacit-hq.testnet` · **Demo DAO:** `sunday-makers.sputnikv2.testnet`
- **Demo video:** [`demo/tacit-demo.mp4`](demo/tacit-demo.mp4), 1:43, recorded from the real site on live testnet. The narration is an AI voice.

## The problem

Every payment from a Sputnik DAO needs a majority of its council to vote on it within the voting period. When too few people show up, the proposal dies, even if nobody objected.

`scripts/census.py` reads every proposal in every DAO on `sputnik-dao.near` using public RPC. Result on 2026-11-09, from 87,050 proposals in 2,102 DAOs:

| Measure | Result |
|---|---|
| DAOs where a proposal has ever failed | 961 |
| ... where more died in silence than were voted down | **751** |
| ... where more were voted down than died in silence | 160 |
| ... tied | 50 |
| Same comparison, DAOs with two or more voters | 568 vs 107, of 710 |
| Same comparison, counting only silent deaths that had at least one yes vote | 435 vs 244, of 711 |
| Proposals with at least one yes, no vote against, that still died | 3,443 |
| Transfers that passed with no vote against them (outside newsrooms) | 24,254 of 24,343 (99.6%) |
| Payments to someone a DAO had already paid three times (outside newsrooms) | 88% paid, 2.3% rejected, 8.8% ignored until expired |

"Died in silence" means a proposal expired or sat open past its voting period with no Reject or Remove vote.

Three things to know about those numbers:

- `bridge-validator.sputnik-dao.near` is left out of every count. Its 234,000 proposals are filed by bridge software and say nothing about people.
- Two newsroom DAOs (`nearweek-news-contribution`, `news`) hold 10,357 of the 12,938 rejections on the chain, because each article is a proposal and editors reject submissions as routine. Counting each DAO once, as the table does, keeps them from swamping the result. Across all proposals, silence ended 10,236 and rejection 12,938. Without those two DAOs it is 8,877 and 2,581.
- The gap has narrowed recently. In the last 12 months, outside newsrooms, 939 proposals died in silence and 776 were voted down.

## How it works

1. **Install.** The council passes two ordinary proposals: one adds a role containing only the Tacit contract and holding only `transfer:VoteApprove`, the other creates a budget.
2. **Post.** A steward files an ordinary `Transfer` proposal on the DAO, then calls `register_spend`. Tacit reads the proposal and the DAO's policy, checks the budget, and starts the clock.
3. **Wait.** Any member of a Group role can call `object`. A `VoteReject` or `VoteRemove` on the DAO counts too. Any council member can pause the whole budget.
4. **Close.** Anyone can call `advance`:
   - No objection and the window closed: Tacit casts `VoteApprove`, its role passes the proposal alone, and Sputnik pays.
   - Objected: Tacit will never vote on it. The DAO's normal vote decides.

Two bounds define the design:

- Silence can only spend what the council approved. Caps and limits are enforced on chain from the DAO's own proposal data.
- An objection can only force the vote the DAO would have had anyway.

**Earned limits.** A budget sets a starting limit per payment, a step and a ceiling. Each payment that passes in silence raises the steward's limit by one step. An upheld objection resets it. Payments under a quarter of the steward's current limit earn nothing, and neither do payments the council voted through. Records are per budget and per named account, and each point comes from a spend you can list with `list_spends`.

**What the contract cannot do.** It holds no funds and contains no code that sends tokens. It cannot file proposals, change policy, or vote on anything it has not checked. Removing the role with one proposal takes away all its power.

## Try it: do X, see Y

Needs Node 20 or later. Run `npm ci` once.

**1. Check the install on chain. No account needed.**

```bash
node scripts/verify.mjs
```

See: Tacit alone in a role holding exactly `transfer:VoteApprove`; the budgets; recent payments whose only vote on the DAO is Tacit's; objected payments Tacit never voted on.

**2. Open the site.**

```bash
node scripts/serve.mjs
```

Open <http://127.0.0.1:4173>.

- `#board`: see the live notice board for the demo DAO, read directly from testnet.
- `#report/open-web-academy.sputnik-dao.near`: see a Silence Report for a real mainnet DAO, read in your browser.
- `#install`: see the exact two proposals to install Tacit on a DAO.

The site is static files in `web/` with no backend, so any static host works. On GitHub, turn on Pages (Settings, Pages, Source: GitHub Actions) and run the "Publish the site" workflow.

**3. Watch silence pay you. Needs a testnet account (about two minutes).**

```bash
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
node scripts/try.mjs <name>.testnet
```

See: a real Sputnik proposal is filed, an early attempt is refused with `ERR_STILL_SILENT`, the script waits 60 seconds, Tacit casts the only vote, and 0.001 NEAR arrives from the DAO. `<name>.testnet` must have its key in `~/.near-credentials/testnet` (the command above puts it there). The script skips the early attempt if a slow RPC has already used up the 60-second window.

**4. Run the contract rules.**

```bash
cd contract && cargo test -p tacit-logic
```

See: every branch of the state machine, the limit arithmetic and the policy parsing pass. The rules are in a separate crate with no NEAR runtime, so this needs nothing but Rust 1.95 or later.

**5. Re-measure the problem. About 45 minutes on free RPC.**

```bash
python scripts/census.py fetch && python scripts/census.py report
```

See: `data/census.json` with the numbers in the table above, moved by whatever has happened on chain since.

## What ran and what did not

| Piece | State | Evidence |
|---|---|---|
| Contract on testnet, silence path paying out through Sputnik | Ran | [TESTNET.md](TESTNET.md), `deployments/testnet-e2e.json` |
| Objections, council reject, pause and resume, every refusal | Ran | Same. All 46 live checks in `scripts/e2e.mjs` pass on the deployed code |
| Paying a stranger by silence | Ran | `scripts/try.mjs` |
| State machine and rules | Ran | `cargo test -p tacit-logic` |
| Silence Report on mainnet DAOs | Ran | Site, `#report/<dao>` |
| Census | Ran | `data/census.json` |
| Site in demo mode, with named demo members | Ran locally | Demo video |
| Wallet sign-in through near-connect | Wallet picker opens. Signing with a real wallet has not been tested. | `web/session.js` |
| near.social announcements | Dry run only. Posting needs a mainnet account. | `node scripts/crier.mjs` |
| Trezu | Not run. Hosted Trezu is mainnet-only. Proposals use the description format Trezu's parser reads, and `Transfer` proposals are what Trezu labels Payment Request (read in `NEAR-DevHub/trezu` at commit `62cf0e4`: `nt-fe/lib/utils.ts`, `nt-fe/features/proposals/utils/proposal-utils.ts`). | Source reading only |
| NEP-141 token budgets | Implemented. Not exercised on chain. | `contract/src/lib.rs` |
| Mainnet deployment | Not done. | |

The testnet contract account still has its deploy key, so the code can be patched during the hackathon. `scripts/verify.mjs` reports this. A mainnet deployment should delete that key so nobody can change the code.

Demo windows are 1 to 2 minutes so a viewer can watch one close. The contract allows 60 seconds to 30 days. A real budget would use about 48 hours.

Budgets named `E2E ...` exist only for the automated tests. The public board hides them.

## Contract

Called by a DAO, through a `FunctionCall` proposal: `create_budget`, `update_budget`, `resume_budget`.

Called by people: `register_spend`, `object`, `pause_budget`, `advance`, `top_up`.

Views: `get_budget`, `list_budgets`, `get_spend`, `list_spends`, `count_spends`, `spend_for_proposal`, `get_record`, `limit_for`, `totals`, `version`.

Every state change logs a NEP-297 event with `"standard": "tacit"`.

Storage is prepaid per budget. A payment costs about 0.011 NEAR of it. No payment path needs an attached deposit, so a refused call simply fails.

## Security review

The contract had two rounds of review by a separate AI agent that was given the code and a threat model, and no account of the design. It was told to try to break it. This was not a human or professional audit.

It found no way to make Tacit cast a vote it should not, and none to lose funds. It did find budget-accounting bugs, now fixed:

| Finding | Fix |
|---|---|
| A caller could starve the proposal read of gas, and Tacit took a failed read to mean "removed", releasing money that had really moved | A failed read changes nothing. Removal needs positive proof from a list read. Descriptions over 4 KB are refused at registration |
| `Failed` was treated as final although Sputnik can retry a failed payment, so a retry could spend outside the cap | The reservation is held until the proposal can no longer be retried |
| A pause did not stop the objection clock | A pause stops it, and resuming gives waiting payments a fresh window |
| A sponsor removed from a budget could still get a vote | Tacit escalates that payment to the normal vote |
| `withdraw` could release money already paid | Removed. A sponsor can object to their own payment instead |
| A limit could be pumped with small payments or with council-passed ones | Only payments passed in silence and worth at least a quarter of the current limit earn credit |

Known limits, accepted for now:

- Anyone can use up an open budget's cap and prepaid storage. Open budgets are meant for tiny community pots.
- A contested payment holds its share of the cap until the council decides, the proposal expires, or the period rolls over. That applies when a steward objects to their own payment too.
- The 30-second objection grace and 20-second settle delay are time-based. A sustained stall on the network could outlast them.
- If a DAO later changes its proposal period, a spend already registered keeps the old expiry.
- If a proposal that was approved but whose transfer failed is deleted with `RemoveProposal` (not a default permission), Tacit records it as paid. The budget errs on the safe side, keeping the money counted as spent.

## Repository

| Path | What |
|---|---|
| `contract/src/lib.rs` | The contract: storage and promises |
| `contract/logic/src/lib.rs` | Every decision about money, as pure functions, with tests |
| `web/` | The static site. Reads RPC directly. No backend |
| `scripts/serve.mjs` | Serves the site. `--demo` adds named demo members and a keeper |
| `scripts/deploy.mjs` | Deploys the contract and installs it through real DAO votes |
| `scripts/e2e.mjs` | Live checks against testnet |
| `scripts/verify.mjs` | Read-only proof of the install |
| `scripts/try.mjs` | Pays you by silence |
| `scripts/crier.mjs` | Near.social announcements |
| `scripts/census.py` | The measurement |
| `demo/` | The demo video and how it was made: `record.mjs` drives the real site, `edit.py` cuts it to the narration |

Build the contract, from `contract/`:

```bash
cargo build --release --target wasm32-unknown-unknown -p tacit
```

`contract/.cargo/config.toml` sets `--cfg near`, which this version of near-sdk needs for contract panics to carry their messages.

## Prior art

Passing by silence is an old idea, and new on Sputnik DAO as far as we could find:

- The diplomatic silence procedure, used by NATO and the EU Council: a text is adopted unless someone breaks silence by a deadline.
- Lazy consensus at the Apache Software Foundation.
- Lido's Easy Track, optimistic motions for routine DAO operations on Ethereum.

## Libraries and AI-written code

Written with Claude Code (Anthropic) during the hackathon. Everything in this repository is new work.

Libraries: `near-sdk` (contract), `near-api-js` (scripts), `@hot-labs/near-connect` (wallet picker, bundled into `web/vendor/`), `playwright-core` and `esbuild` (tooling). Narration in the demo video is an AI voice.

## License

MIT. See [LICENSE](LICENSE).
