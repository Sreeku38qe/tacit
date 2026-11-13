//! Pure decision rules for Tacit.
//!
//! The contract in `../src/lib.rs` handles storage and promises. Every decision
//! about money lives here, away from the NEAR runtime, so the whole state
//! machine can be exercised with plain `cargo test`.

use serde_json::Value;

const SEC: u64 = 1_000_000_000;
const HOUR: u64 = 3_600 * SEC;
const DAY: u64 = 24 * HOUR;

/// After the window closes, an objection already on its way still gets this long to land.
pub const GRACE_NS: u64 = 30 * SEC;
/// Sputnik reports `Approved` before the transfer receipt has run. Wait this long before believing it.
pub const SETTLE_NS: u64 = 20 * SEC;
/// A window must close at least this long before the DAO proposal itself would expire.
pub const EXPIRY_MARGIN_NS: u64 = 10 * 60 * SEC;

pub const MIN_WINDOW_NS: u64 = 60 * SEC;
pub const MAX_WINDOW_NS: u64 = 30 * DAY;
pub const MIN_PERIOD_NS: u64 = HOUR;
pub const MAX_PERIOD_NS: u64 = 366 * DAY;

/// Where a spend is in its life on Tacit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// The clock is running. Nobody has objected.
    Silent,
    /// Tacit's approving vote is in flight.
    Voting,
    /// Approved on the DAO. Waiting to confirm the transfer really ran.
    Paying,
    /// Someone objected. Only the DAO's normal vote can pass it now.
    Contested,
    /// Final: the money moved.
    Paid,
    /// Final: the council rejected it.
    Upheld,
    /// Final: the DAO proposal expired or was moved away without a decision.
    Lapsed,
    /// Final: approved, but the transfer failed on the DAO and can no longer be retried.
    Failed,
}

/// How an approved spend got its approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// The window closed with no objection and Tacit cast the vote.
    Silence,
    /// The council voted it through on its own.
    Council,
    /// Someone objected and the council approved it anyway.
    Overruled,
}

/// A Sputnik proposal status. `Removed` also covers a proposal that no longer exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaoStatus {
    InProgress,
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    Failed,
}

pub fn parse_status(s: &str) -> Option<DaoStatus> {
    Some(match s {
        "InProgress" => DaoStatus::InProgress,
        "Approved" => DaoStatus::Approved,
        "Rejected" => DaoStatus::Rejected,
        "Removed" => DaoStatus::Removed,
        "Expired" => DaoStatus::Expired,
        "Moved" => DaoStatus::Moved,
        "Failed" => DaoStatus::Failed,
        _ => return None,
    })
}

/// Everything `next_step` needs to know, gathered by the contract.
#[derive(Clone, Copy, Debug)]
pub struct Facts {
    pub state: State,
    pub route: Option<Route>,
    pub dao: DaoStatus,
    /// Someone has voted Reject or Remove on the DAO proposal.
    pub dissent: bool,
    pub now: u64,
    pub deadline: u64,
    /// When the last objection was attempted, if any.
    pub last_objection_attempt: Option<u64>,
    pub voted_at: Option<u64>,
    pub dao_expires_at: u64,
    pub paused: bool,
    /// The budget is unexpired and the sponsor may still use it.
    pub sponsor_valid: bool,
}

/// What `advance` should do next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing can happen yet. The string is the error code to panic with.
    Wait(&'static str),
    /// Cast Tacit's single approving vote.
    CastVote,
    /// Silence is broken. Hand the spend to the normal vote.
    Escalate,
    /// The DAO shows Approved. Start waiting to confirm the transfer.
    BeginPaying(Route),
    /// Close the spend in this final state.
    Finish(State),
}

/// The whole state machine. Pure, so tests can walk every branch.
pub fn next_step(f: &Facts) -> Step {
    match f.state {
        State::Silent => match f.dao {
            DaoStatus::Approved => Step::BeginPaying(Route::Council),
            DaoStatus::Rejected | DaoStatus::Removed => Step::Finish(State::Upheld),
            DaoStatus::Expired | DaoStatus::Moved => Step::Finish(State::Lapsed),
            DaoStatus::Failed => failed_payment(f),
            DaoStatus::InProgress => {
                if f.dissent {
                    return Step::Escalate;
                }
                if f.now >= f.dao_expires_at {
                    return Step::Finish(State::Lapsed);
                }
                // A pause stops the clock: resuming gives everyone a fresh window.
                if f.paused {
                    return Step::Wait("ERR_PAUSED");
                }
                if f.now < f.deadline {
                    return Step::Wait("ERR_STILL_SILENT");
                }
                let attempt_settled = f
                    .last_objection_attempt
                    .map_or(true, |t| f.now >= t.saturating_add(GRACE_NS));
                if !attempt_settled {
                    return Step::Wait("ERR_OBJECTION_IN_FLIGHT");
                }
                if !f.sponsor_valid {
                    return Step::Escalate;
                }
                Step::CastVote
            }
        },
        State::Paying => {
            let settled = f
                .voted_at
                .map_or(true, |t| f.now >= t.saturating_add(SETTLE_NS));
            if !settled {
                return Step::Wait("ERR_STILL_SETTLING");
            }
            match f.dao {
                // Removing a proposal after it passed does not undo the payment, so the
                // reservation stays spent.
                DaoStatus::Approved | DaoStatus::Removed => Step::Finish(State::Paid),
                DaoStatus::Failed => failed_payment(f),
                DaoStatus::Rejected => Step::Finish(State::Upheld),
                DaoStatus::Expired | DaoStatus::Moved => Step::Finish(State::Lapsed),
                // Tacit's vote did not decide it, so the role was misconfigured.
                // Falling back to the normal vote is always safe.
                DaoStatus::InProgress => Step::Escalate,
            }
        }
        State::Contested => match f.dao {
            DaoStatus::Approved => Step::BeginPaying(Route::Overruled),
            DaoStatus::Rejected | DaoStatus::Removed => Step::Finish(State::Upheld),
            DaoStatus::Expired | DaoStatus::Moved => Step::Finish(State::Lapsed),
            DaoStatus::Failed => failed_payment(f),
            DaoStatus::InProgress => {
                if f.now >= f.dao_expires_at {
                    Step::Finish(State::Lapsed)
                } else {
                    Step::Wait("ERR_STILL_CONTESTED")
                }
            }
        },
        State::Voting | State::Paid | State::Upheld | State::Lapsed | State::Failed => {
            Step::Wait("ERR_NOTHING_TO_DO")
        }
    }
}

/// Sputnik lets anyone with `Finalize` retry a failed payment until the proposal expires,
/// so the money stays reserved until then.
fn failed_payment(f: &Facts) -> Step {
    if f.now >= f.dao_expires_at {
        Step::Finish(State::Failed)
    } else {
        Step::Wait("ERR_PAYMENT_CAN_STILL_BE_RETRIED")
    }
}

/// The moment a spend's window really closes. Resuming a paused budget gives every spend a fresh
/// full window, so people are not robbed of time they spent waiting on the pause.
pub fn effective_deadline(deadline: u64, resumed_at: Option<u64>, window_ns: u64) -> u64 {
    resumed_at.map_or(deadline, |t| deadline.max(t.saturating_add(window_ns)))
}

/// How much one person may pay out in one spend: it grows with each clean spend, up to a ceiling.
pub fn earned_limit(base: u128, step: u128, max: u128, clean: u32) -> u128 {
    base.saturating_add(step.saturating_mul(u128::from(clean)))
        .min(max)
}

/// A payment under a quarter of the sponsor's current limit adds nothing to their record,
/// so a limit cannot be pumped with small payments.
pub fn earns_credit(amount: u128, current_limit: u128) -> bool {
    amount.saturating_mul(4) >= current_limit
}

/// Who may put a proposal under silence. The caller becomes answerable for it.
pub fn may_sponsor(is_steward: bool, budget_is_open: bool, caller_is_proposer: bool) -> bool {
    is_steward || (budget_is_open && caller_is_proposer)
}

/// Which budget period `now` falls in. Periods are counted from the budget's creation.
pub fn period_index(start_ns: u64, period_ns: u64, now_ns: u64) -> u32 {
    let index = now_ns.saturating_sub(start_ns) / period_ns.max(1);
    u32::try_from(index).unwrap_or(u32::MAX)
}

pub fn fits_cap(spent: u128, cap: u128, amount: u128) -> bool {
    spent.checked_add(amount).is_some_and(|total| total <= cap)
}

/// The fields of a Sputnik `Transfer` proposal that Tacit cares about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub token: String,
    pub receiver: String,
    pub amount: u128,
    pub has_msg: bool,
}

/// Returns `None` for any proposal kind other than `Transfer`.
pub fn parse_transfer(kind: &Value) -> Option<Transfer> {
    let t = kind.get("Transfer")?;
    Some(Transfer {
        token: t.get("token_id")?.as_str()?.to_string(),
        receiver: t.get("receiver_id")?.as_str()?.to_string(),
        amount: t.get("amount")?.as_str()?.parse().ok()?,
        has_msg: !t.get("msg").map_or(true, Value::is_null),
    })
}

/// What Tacit needs to know from a DAO's policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyFacts {
    pub proposal_period_ns: u64,
    /// Tacit sits alone in a role that may approve transfers, so its one vote can decide.
    pub installed: bool,
    /// `account` belongs to at least one Group role.
    pub is_member: bool,
}

pub fn read_policy(policy: &Value, tacit: &str, account: &str) -> Option<PolicyFacts> {
    let proposal_period_ns = policy.get("proposal_period")?.as_str()?.parse().ok()?;
    let mut installed = false;
    let mut is_member = false;
    for role in policy.get("roles")?.as_array()? {
        let Some(group) = role
            .get("kind")
            .and_then(|k| k.get("Group"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let has = |who: &str| group.iter().any(|m| m.as_str() == Some(who));
        if has(account) {
            is_member = true;
        }
        if has(tacit) && group.len() == 1 && role_can_approve_transfer(role) {
            installed = true;
        }
    }
    Some(PolicyFacts {
        proposal_period_ns,
        installed,
        is_member,
    })
}

fn role_can_approve_transfer(role: &Value) -> bool {
    const GRANTS: [&str; 4] = ["transfer:VoteApprove", "transfer:*", "*:VoteApprove", "*:*"];
    role.get("permissions")
        .and_then(Value::as_array)
        .is_some_and(|perms| {
            perms
                .iter()
                .filter_map(Value::as_str)
                .any(|p| GRANTS.contains(&p))
        })
}

/// A vote that breaks silence.
pub fn is_dissent(vote: &str) -> bool {
    vote == "Reject" || vote == "Remove"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: u64 = 1_000 * DAY;
    const DEADLINE: u64 = T0 + 2 * DAY;
    const EXPIRES: u64 = T0 + 7 * DAY;

    fn silent() -> Facts {
        Facts {
            state: State::Silent,
            route: None,
            dao: DaoStatus::InProgress,
            dissent: false,
            now: T0,
            deadline: DEADLINE,
            last_objection_attempt: None,
            voted_at: None,
            dao_expires_at: EXPIRES,
            paused: false,
            sponsor_valid: true,
        }
    }

    #[test]
    fn silence_holds_until_the_deadline() {
        let mut f = silent();
        f.now = DEADLINE - 1;
        assert_eq!(next_step(&f), Step::Wait("ERR_STILL_SILENT"));
    }

    #[test]
    fn silence_passes_at_the_deadline() {
        let mut f = silent();
        f.now = DEADLINE;
        assert_eq!(next_step(&f), Step::CastVote);
    }

    #[test]
    fn a_late_objection_attempt_holds_the_vote_for_the_grace_period() {
        let mut f = silent();
        f.now = DEADLINE;
        f.last_objection_attempt = Some(DEADLINE - SEC);
        assert_eq!(next_step(&f), Step::Wait("ERR_OBJECTION_IN_FLIGHT"));
        f.now = DEADLINE - SEC + GRACE_NS;
        assert_eq!(next_step(&f), Step::CastVote);
    }

    #[test]
    fn a_reject_vote_on_the_dao_breaks_silence_even_before_the_deadline() {
        let mut f = silent();
        f.dissent = true;
        assert_eq!(next_step(&f), Step::Escalate);
        f.now = DEADLINE + DAY;
        assert_eq!(next_step(&f), Step::Escalate);
    }

    #[test]
    fn a_paused_budget_never_casts_a_vote() {
        let mut f = silent();
        f.now = DEADLINE;
        f.paused = true;
        assert_eq!(next_step(&f), Step::Wait("ERR_PAUSED"));
    }

    #[test]
    fn a_pause_during_the_window_also_blocks_the_vote_after_it() {
        let mut f = silent();
        f.paused = true;
        assert_eq!(next_step(&f), Step::Wait("ERR_PAUSED"));
    }

    #[test]
    fn resuming_gives_a_fresh_window() {
        assert_eq!(effective_deadline(100, None, 50), 100);
        assert_eq!(effective_deadline(100, Some(40), 50), 100);
        assert_eq!(effective_deadline(100, Some(90), 50), 140);
    }

    #[test]
    fn a_sponsor_removed_from_the_budget_does_not_get_the_vote() {
        let mut f = silent();
        f.now = DEADLINE;
        f.sponsor_valid = false;
        assert_eq!(next_step(&f), Step::Escalate);
    }

    #[test]
    fn a_dao_proposal_past_its_period_lapses_instead_of_voting() {
        let mut f = silent();
        f.now = EXPIRES;
        assert_eq!(next_step(&f), Step::Finish(State::Lapsed));
    }

    #[test]
    fn the_council_can_decide_during_the_window() {
        let mut f = silent();
        f.dao = DaoStatus::Approved;
        assert_eq!(next_step(&f), Step::BeginPaying(Route::Council));
        f.dao = DaoStatus::Rejected;
        assert_eq!(next_step(&f), Step::Finish(State::Upheld));
        f.dao = DaoStatus::Removed;
        assert_eq!(next_step(&f), Step::Finish(State::Upheld));
    }

    #[test]
    fn approved_is_not_believed_until_settled() {
        let mut f = silent();
        f.state = State::Paying;
        f.route = Some(Route::Silence);
        f.dao = DaoStatus::Approved;
        f.voted_at = Some(T0);
        f.now = T0 + SETTLE_NS - 1;
        assert_eq!(next_step(&f), Step::Wait("ERR_STILL_SETTLING"));
        f.now = T0 + SETTLE_NS;
        assert_eq!(next_step(&f), Step::Finish(State::Paid));
    }

    #[test]
    fn a_transfer_that_failed_after_approval_is_not_paid() {
        let mut f = silent();
        f.state = State::Paying;
        f.dao = DaoStatus::Failed;
        f.voted_at = Some(T0);
        f.now = T0 + SETTLE_NS;
        assert_eq!(next_step(&f), Step::Wait("ERR_PAYMENT_CAN_STILL_BE_RETRIED"));
    }

    #[test]
    fn a_failed_payment_closes_only_once_it_can_no_longer_be_retried() {
        for state in [State::Silent, State::Paying, State::Contested] {
            let mut f = silent();
            f.state = state;
            f.dao = DaoStatus::Failed;
            f.voted_at = Some(T0);
            f.now = EXPIRES - 1;
            assert_eq!(next_step(&f), Step::Wait("ERR_PAYMENT_CAN_STILL_BE_RETRIED"), "{state:?}");
            f.now = EXPIRES;
            assert_eq!(next_step(&f), Step::Finish(State::Failed), "{state:?}");
        }
    }

    #[test]
    fn removing_a_paid_proposal_does_not_refund_the_budget() {
        let mut f = silent();
        f.state = State::Paying;
        f.dao = DaoStatus::Removed;
        f.voted_at = Some(T0);
        f.now = T0 + SETTLE_NS;
        assert_eq!(next_step(&f), Step::Finish(State::Paid));
    }

    #[test]
    fn an_undecisive_vote_falls_back_to_the_normal_vote() {
        let mut f = silent();
        f.state = State::Paying;
        f.dao = DaoStatus::InProgress;
        f.voted_at = Some(T0);
        f.now = T0 + SETTLE_NS;
        assert_eq!(next_step(&f), Step::Escalate);
    }

    #[test]
    fn a_contested_spend_waits_for_the_council() {
        let mut f = silent();
        f.state = State::Contested;
        f.now = DEADLINE + DAY;
        assert_eq!(next_step(&f), Step::Wait("ERR_STILL_CONTESTED"));
        f.now = EXPIRES;
        assert_eq!(next_step(&f), Step::Finish(State::Lapsed));
    }

    #[test]
    fn contested_outcomes() {
        let mut f = silent();
        f.state = State::Contested;
        f.dao = DaoStatus::Approved;
        assert_eq!(next_step(&f), Step::BeginPaying(Route::Overruled));
        f.dao = DaoStatus::Rejected;
        assert_eq!(next_step(&f), Step::Finish(State::Upheld));
        f.dao = DaoStatus::Expired;
        assert_eq!(next_step(&f), Step::Finish(State::Lapsed));
    }

    #[test]
    fn tacit_never_votes_outside_the_silent_state() {
        for state in [
            State::Voting,
            State::Paying,
            State::Contested,
            State::Paid,
            State::Upheld,
            State::Lapsed,
            State::Failed,
        ] {
            for dao in [
                DaoStatus::InProgress,
                DaoStatus::Approved,
                DaoStatus::Rejected,
                DaoStatus::Removed,
                DaoStatus::Expired,
                DaoStatus::Moved,
                DaoStatus::Failed,
            ] {
                let mut f = silent();
                f.state = state;
                f.dao = dao;
                f.now = DEADLINE + DAY;
                f.voted_at = Some(T0);
                assert_ne!(next_step(&f), Step::CastVote, "{state:?} {dao:?}");
            }
        }
    }

    #[test]
    fn final_states_stay_final() {
        for state in [
            State::Paid,
            State::Upheld,
            State::Lapsed,
            State::Failed,
        ] {
            let mut f = silent();
            f.state = state;
            f.dao = DaoStatus::Approved;
            assert_eq!(next_step(&f), Step::Wait("ERR_NOTHING_TO_DO"));
        }
    }

    #[test]
    fn limit_grows_with_clean_spends_and_stops_at_the_ceiling() {
        assert_eq!(earned_limit(10, 5, 30, 0), 10);
        assert_eq!(earned_limit(10, 5, 30, 2), 20);
        assert_eq!(earned_limit(10, 5, 30, 4), 30);
        assert_eq!(earned_limit(10, 5, 30, 400), 30);
    }

    #[test]
    fn limit_arithmetic_cannot_overflow() {
        assert_eq!(earned_limit(u128::MAX, u128::MAX, 77, u32::MAX), 77);
    }

    #[test]
    fn small_payments_do_not_earn_credit() {
        assert!(!earns_credit(24, 100));
        assert!(earns_credit(25, 100));
        assert!(earns_credit(u128::MAX, 100));
    }

    #[test]
    fn only_stewards_can_sponsor_a_stewarded_budget() {
        assert!(may_sponsor(true, false, false));
        assert!(may_sponsor(true, false, true));
        assert!(!may_sponsor(false, false, true));
        assert!(!may_sponsor(false, false, false));
    }

    #[test]
    fn nobody_can_start_the_clock_on_someone_elses_open_proposal() {
        assert!(may_sponsor(false, true, true));
        assert!(!may_sponsor(false, true, false));
    }

    #[test]
    fn periods_count_from_budget_creation() {
        assert_eq!(period_index(T0, DAY, T0), 0);
        assert_eq!(period_index(T0, DAY, T0 + DAY - 1), 0);
        assert_eq!(period_index(T0, DAY, T0 + DAY), 1);
        assert_eq!(period_index(T0, DAY, T0 - 5), 0);
    }

    #[test]
    fn cap_check() {
        assert!(fits_cap(10, 15, 5));
        assert!(!fits_cap(10, 15, 6));
        assert!(!fits_cap(u128::MAX, u128::MAX, 1));
    }

    #[test]
    fn parses_a_near_transfer() {
        let kind = json!({"Transfer":{"token_id":"","receiver_id":"hall.testnet","amount":"1000","msg":null}});
        let t = parse_transfer(&kind).unwrap();
        assert_eq!(t.token, "");
        assert_eq!(t.receiver, "hall.testnet");
        assert_eq!(t.amount, 1000);
        assert!(!t.has_msg);
    }

    #[test]
    fn notices_a_transfer_call_message() {
        let kind = json!({"Transfer":{"token_id":"usd.testnet","receiver_id":"x.testnet","amount":"1","msg":"swap"}});
        assert!(parse_transfer(&kind).unwrap().has_msg);
    }

    #[test]
    fn other_proposal_kinds_are_not_transfers() {
        let call = json!({"FunctionCall":{"receiver_id":"x.testnet","actions":[]}});
        assert_eq!(parse_transfer(&call), None);
        assert_eq!(parse_transfer(&json!("Vote")), None);
    }

    fn policy(tacit_group: Value, perms: Value) -> Value {
        json!({
            "proposal_period": "604800000000000",
            "roles": [
                {"name":"all","kind":"Everyone","permissions":["*:AddProposal"],"vote_policy":{}},
                {"name":"council","kind":{"Group":["ana.testnet","ben.testnet"]},"permissions":["*:*"],"vote_policy":{}},
                {"name":"tacit","kind":{"Group":tacit_group},"permissions":perms,"vote_policy":{}}
            ]
        })
    }

    #[test]
    fn recognises_a_correct_install_and_members() {
        let p = policy(json!(["t.testnet"]), json!(["transfer:VoteApprove"]));
        let f = read_policy(&p, "t.testnet", "ana.testnet").unwrap();
        assert!(f.installed);
        assert!(f.is_member);
        assert_eq!(f.proposal_period_ns, 604_800_000_000_000);
    }

    #[test]
    fn strangers_are_not_members() {
        let p = policy(json!(["t.testnet"]), json!(["transfer:VoteApprove"]));
        assert!(!read_policy(&p, "t.testnet", "eve.testnet").unwrap().is_member);
    }

    #[test]
    fn a_shared_role_is_not_an_install() {
        let p = policy(json!(["t.testnet", "ana.testnet"]), json!(["transfer:VoteApprove"]));
        assert!(!read_policy(&p, "t.testnet", "ana.testnet").unwrap().installed);
    }

    #[test]
    fn a_role_without_approve_is_not_an_install() {
        let p = policy(json!(["t.testnet"]), json!(["transfer:AddProposal"]));
        assert!(!read_policy(&p, "t.testnet", "ana.testnet").unwrap().installed);
    }

    #[test]
    fn dissent_means_reject_or_remove() {
        assert!(is_dissent("Reject"));
        assert!(is_dissent("Remove"));
        assert!(!is_dissent("Approve"));
    }
}
