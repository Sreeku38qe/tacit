//! Tacit: a silence procedure for Sputnik DAO budgets.
//!
//! A DAO approves a budget once. After that, a transfer proposal inside the
//! budget passes unless someone objects before its window closes.
//!
//! Tacit never holds a DAO's money and has no code that sends tokens. Its only
//! power is one permission in the DAO's own policy: `transfer:VoteApprove`, in a
//! role where it sits alone. Filing, custody and payment stay in Sputnik DAO.

use std::collections::HashMap;

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use tacit_logic as logic;
use tacit_logic::{DaoStatus, Facts, Step};

const GAS_READ_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_READ_POLICY: Gas = Gas::from_tgas(25);
const GAS_ON_REGISTER: Gas = Gas::from_tgas(40);
const GAS_ON_OBJECTION: Gas = Gas::from_tgas(40);
const GAS_ON_PAUSE: Gas = Gas::from_tgas(40);
const GAS_ON_ADVANCE: Gas = Gas::from_tgas(150);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(90);
const GAS_ON_VOTED: Gas = Gas::from_tgas(15);

/// Bytes set aside at registration so that a later objection can always be stored.
const RESERVE_BYTES: u64 = 600;
/// Bytes set aside when a budget is created, for the fields a pause and resume will fill in.
const BUDGET_RESERVE_BYTES: u64 = 90;
/// Longest proposal description Tacit accepts. Keeps every later read of the proposal cheap.
const MAX_DESCRIPTION: usize = 4096;
const MAX_LABEL: usize = 64;
const MAX_REASON: usize = 200;
const MAX_STEWARDS: usize = 32;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Budgets,
    Spends,
    Claimed,
    Records,
    DaoBudgetCount,
    DaoBudgetAt,
    DaoSpendCount,
    DaoSpendAt,
}

/// Mirrors [`logic::State`], with storage and JSON encodings.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Silent,
    Voting,
    Paying,
    Contested,
    Paid,
    Upheld,
    Lapsed,
    Failed,
}

/// Mirrors [`logic::Route`], with storage and JSON encodings.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Silence,
    Council,
    Overruled,
}

impl From<Status> for logic::State {
    fn from(s: Status) -> Self {
        match s {
            Status::Silent => Self::Silent,
            Status::Voting => Self::Voting,
            Status::Paying => Self::Paying,
            Status::Contested => Self::Contested,
            Status::Paid => Self::Paid,
            Status::Upheld => Self::Upheld,
            Status::Lapsed => Self::Lapsed,
            Status::Failed => Self::Failed,
        }
    }
}

impl From<logic::State> for Status {
    fn from(s: logic::State) -> Self {
        match s {
            logic::State::Silent => Self::Silent,
            logic::State::Voting => Self::Voting,
            logic::State::Paying => Self::Paying,
            logic::State::Contested => Self::Contested,
            logic::State::Paid => Self::Paid,
            logic::State::Upheld => Self::Upheld,
            logic::State::Lapsed => Self::Lapsed,
            logic::State::Failed => Self::Failed,
        }
    }
}

impl From<Route> for logic::Route {
    fn from(r: Route) -> Self {
        match r {
            Route::Silence => Self::Silence,
            Route::Council => Self::Council,
            Route::Overruled => Self::Overruled,
        }
    }
}

impl From<logic::Route> for Route {
    fn from(r: logic::Route) -> Self {
        match r {
            logic::Route::Silence => Self::Silence,
            logic::Route::Council => Self::Council,
            logic::Route::Overruled => Self::Overruled,
        }
    }
}

/// A standing budget a DAO has approved for itself.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Budget {
    pub id: u32,
    pub dao: AccountId,
    pub label: String,
    /// `None` means NEAR.
    pub token: Option<AccountId>,
    pub stewards: Vec<AccountId>,
    /// When true, anyone may file or object. Meant for tiny community pots.
    pub open: bool,
    pub allow_self_pay: bool,
    pub window_ns: U64,
    pub period_ns: U64,
    pub cap: U128,
    pub base_limit: U128,
    pub step: U128,
    pub max_limit: U128,
    pub created_at: U64,
    pub expires_at: Option<U64>,
    pub paused_by: Option<AccountId>,
    /// When the budget last came out of a pause. Gives waiting spends a fresh window.
    pub resumed_at: Option<U64>,
    pub period_idx: u32,
    /// Spent or reserved in the current period.
    pub spent: U128,
    pub total_paid: U128,
    pub spend_count: u32,
    /// NEAR the DAO prepaid for this budget's storage.
    pub credit: U128,
}

/// The parameters a DAO chooses for a budget.
#[near(serializers = [json])]
pub struct BudgetInput {
    pub label: String,
    pub token: Option<AccountId>,
    pub stewards: Vec<AccountId>,
    pub open: bool,
    pub allow_self_pay: bool,
    pub window_secs: u64,
    pub period_secs: u64,
    pub cap: U128,
    pub base_limit: U128,
    pub step: U128,
    pub max_limit: U128,
    pub expires_at: Option<U64>,
}

/// One proposal placed under the silence procedure.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Spend {
    pub id: U64,
    pub budget_id: u32,
    pub dao: AccountId,
    pub proposal_id: U64,
    /// The account answerable for this spend.
    pub sponsor: AccountId,
    pub payee: AccountId,
    pub amount: U128,
    pub status: Status,
    pub route: Option<Route>,
    pub filed_at: U64,
    pub deadline: U64,
    pub dao_expires_at: U64,
    pub voted_at: Option<U64>,
    pub last_objection_attempt: Option<U64>,
    pub objector: Option<AccountId>,
    pub reason: Option<String>,
    pub period_idx: u32,
}

/// A named account's standing in one budget. Every number comes from spends you can list.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Record {
    /// Clean spends since the last upheld objection. Raises the earned limit.
    pub clean: u32,
    pub passed: u32,
    pub upheld_against: u32,
    pub overruled_for: u32,
    pub objections_upheld: u32,
    pub objections_overruled: u32,
}

/// The fields Tacit reads from `get_proposal`. Anything else in the response is ignored.
#[near(serializers = [json])]
pub struct DaoProposal {
    pub id: u64,
    pub proposer: AccountId,
    pub description: String,
    pub kind: Value,
    pub status: String,
    pub votes: HashMap<AccountId, String>,
    pub submission_time: U64,
}

#[allow(dead_code)]
#[ext_contract(ext_dao)]
trait SputnikDao {
    fn get_proposal(&self, id: u64) -> DaoProposal;
    fn get_proposals(&self, from_index: u64, limit: u64) -> Vec<DaoProposal>;
    fn get_policy(&self) -> Value;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tacit {
    budgets: Vector<Budget>,
    spends: Vector<Spend>,
    /// `(dao, proposal)` to spend. A proposal can be placed under silence only once.
    claimed: LookupMap<(AccountId, u64), u64>,
    /// `(budget, account)` to record. Standing earned in one budget cannot raise a limit in another.
    records: LookupMap<(u32, AccountId), Record>,
    dao_budget_count: LookupMap<AccountId, u32>,
    dao_budget_at: LookupMap<(AccountId, u32), u32>,
    dao_spend_count: LookupMap<AccountId, u32>,
    dao_spend_at: LookupMap<(AccountId, u32), u64>,
}

fn emit(event: &str, data: Value) {
    let line = json!({"standard": "tacit", "version": "1.0.0", "event": event, "data": data});
    log!("EVENT_JSON:{}", line);
}

fn effective_deadline(spend: &Spend, budget: &Budget) -> u64 {
    logic::effective_deadline(
        spend.deadline.0,
        budget.resumed_at.map(|t| t.0),
        budget.window_ns.0,
    )
}

fn byte_cost(bytes: u64) -> u128 {
    u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
}

fn check_input(input: &BudgetInput) -> (u64, u64) {
    require!(
        !input.label.is_empty() && input.label.len() <= MAX_LABEL,
        "ERR_LABEL"
    );
    require!(input.stewards.len() <= MAX_STEWARDS, "ERR_TOO_MANY_STEWARDS");
    require!(
        input.open || !input.stewards.is_empty(),
        "ERR_NO_STEWARDS"
    );
    let window_ns = input.window_secs.saturating_mul(1_000_000_000);
    let period_ns = input.period_secs.saturating_mul(1_000_000_000);
    require!(
        (logic::MIN_WINDOW_NS..=logic::MAX_WINDOW_NS).contains(&window_ns),
        "ERR_WINDOW"
    );
    require!(
        (logic::MIN_PERIOD_NS..=logic::MAX_PERIOD_NS).contains(&period_ns),
        "ERR_PERIOD"
    );
    require!(input.base_limit.0 > 0, "ERR_LIMITS");
    require!(input.base_limit.0 <= input.max_limit.0, "ERR_LIMITS");
    require!(input.max_limit.0 <= input.cap.0, "ERR_LIMITS");
    (window_ns, period_ns)
}

#[near]
impl Tacit {
    #[init]
    pub fn new() -> Self {
        Self {
            budgets: Vector::new(Key::Budgets),
            spends: Vector::new(Key::Spends),
            claimed: LookupMap::new(Key::Claimed),
            records: LookupMap::new(Key::Records),
            dao_budget_count: LookupMap::new(Key::DaoBudgetCount),
            dao_budget_at: LookupMap::new(Key::DaoBudgetAt),
            dao_spend_count: LookupMap::new(Key::DaoSpendCount),
            dao_spend_at: LookupMap::new(Key::DaoSpendAt),
        }
    }

    // ---- Called by the DAO, through a normal FunctionCall proposal ----

    /// Create a budget. The caller is the DAO, so a budget can only ever bind the account that made it.
    #[payable]
    pub fn create_budget(&mut self, input: BudgetInput) -> u32 {
        let (window_ns, period_ns) = check_input(&input);
        let dao = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = u32::try_from(self.budgets.len()).expect("ERR_TOO_MANY");
        let before = env::storage_usage();

        self.budgets.push(&Budget {
            id,
            dao: dao.clone(),
            label: input.label,
            token: input.token,
            stewards: input.stewards,
            open: input.open,
            allow_self_pay: input.allow_self_pay,
            window_ns: U64(window_ns),
            period_ns: U64(period_ns),
            cap: input.cap,
            base_limit: input.base_limit,
            step: input.step,
            max_limit: input.max_limit,
            created_at: U64(now),
            expires_at: input.expires_at,
            paused_by: None,
            resumed_at: None,
            period_idx: 0,
            spent: U128(0),
            total_paid: U128(0),
            spend_count: 0,
            credit: U128(0),
        });
        let index = self.dao_budget_count.get(&dao).unwrap_or(0);
        self.dao_budget_at.insert(&(dao.clone(), index), &id);
        self.dao_budget_count.insert(&dao, &(index + 1));

        let cost = byte_cost(env::storage_usage() - before + BUDGET_RESERVE_BYTES);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, "ERR_DEPOSIT_TOO_SMALL");
        let mut budget = self.budget(id);
        budget.credit = U128(deposit - cost);
        self.budgets.replace(u64::from(id), &budget);

        emit("budget_created", json!({"budget_id": id, "dao": dao}));
        id
    }

    /// Change a budget's terms. Only the DAO that owns it can.
    #[payable]
    pub fn update_budget(&mut self, budget_id: u32, input: BudgetInput) {
        let mut budget = self.budget(budget_id);
        require!(
            env::predecessor_account_id() == budget.dao,
            "ERR_ONLY_THE_DAO"
        );
        require!(input.token == budget.token, "ERR_TOKEN_IS_FIXED");
        let (window_ns, period_ns) = check_input(&input);
        require!(period_ns == budget.period_ns.0, "ERR_PERIOD_IS_FIXED");
        let before = env::storage_usage();

        budget.label = input.label;
        budget.stewards = input.stewards;
        budget.open = input.open;
        budget.allow_self_pay = input.allow_self_pay;
        budget.window_ns = U64(window_ns);
        budget.cap = input.cap;
        budget.base_limit = input.base_limit;
        budget.step = input.step;
        budget.max_limit = input.max_limit;
        budget.expires_at = input.expires_at;
        budget.credit = U128(budget.credit.0 + env::attached_deposit().as_yoctonear());
        self.budgets.replace(u64::from(budget_id), &budget);

        let grew = env::storage_usage().saturating_sub(before);
        if grew > 0 {
            let cost = byte_cost(grew);
            require!(budget.credit.0 >= cost, "ERR_NO_CREDIT");
            budget.credit = U128(budget.credit.0 - cost);
            self.budgets.replace(u64::from(budget_id), &budget);
        }
        emit("budget_updated", json!({"budget_id": budget_id}));
    }

    /// Lift a pause. Only the DAO can, because it takes a real decision to resume spending.
    pub fn resume_budget(&mut self, budget_id: u32) {
        let mut budget = self.budget(budget_id);
        require!(
            env::predecessor_account_id() == budget.dao,
            "ERR_ONLY_THE_DAO"
        );
        budget.paused_by = None;
        budget.resumed_at = Some(U64(env::block_timestamp()));
        self.budgets.replace(u64::from(budget_id), &budget);
        emit("budget_resumed", json!({"budget_id": budget_id}));
    }

    /// Prepay storage for a budget. Anyone may.
    #[payable]
    pub fn top_up(&mut self, budget_id: u32) {
        let mut budget = self.budget(budget_id);
        budget.credit = U128(budget.credit.0 + env::attached_deposit().as_yoctonear());
        self.budgets.replace(u64::from(budget_id), &budget);
    }

    // ---- Used by community members ----

    /// Put an existing Sputnik `Transfer` proposal under the silence procedure.
    ///
    /// The proposal is filed the normal way (Trezu, the CLI, anything), so it remains an
    /// ordinary request on the DAO. Everything is checked against the DAO's own data.
    pub fn register_spend(&mut self, budget_id: u32, proposal_id: U64) -> Promise {
        let budget = self.budget(budget_id);
        require!(budget.paused_by.is_none(), "ERR_PAUSED");
        ext_dao::ext(budget.dao.clone())
            .with_static_gas(GAS_READ_PROPOSAL)
            .get_proposal(proposal_id.0)
            .and(
                ext_dao::ext(budget.dao)
                    .with_static_gas(GAS_READ_POLICY)
                    .get_policy(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REGISTER)
                    .on_register(budget_id, proposal_id, env::predecessor_account_id()),
            )
    }

    #[private]
    pub fn on_register(
        &mut self,
        budget_id: u32,
        proposal_id: U64,
        caller: AccountId,
        #[callback_result] proposal: Result<DaoProposal, PromiseError>,
        #[callback_result] policy: Result<Value, PromiseError>,
    ) -> U64 {
        let before = env::storage_usage();
        let proposal = proposal.unwrap_or_else(|_| env::panic_str("ERR_NO_PROPOSAL"));
        let policy = policy.unwrap_or_else(|_| env::panic_str("ERR_NO_POLICY"));
        let mut budget = self.budget(budget_id);
        let now = env::block_timestamp();

        require!(budget.paused_by.is_none(), "ERR_PAUSED");
        if let Some(expires) = budget.expires_at {
            require!(now < expires.0, "ERR_BUDGET_EXPIRED");
        }

        let facts = logic::read_policy(&policy, env::current_account_id().as_str(), caller.as_str())
            .unwrap_or_else(|| env::panic_str("ERR_BAD_POLICY"));
        require!(facts.installed, "ERR_NOT_INSTALLED");

        let key = (budget.dao.clone(), proposal_id.0);
        require!(self.claimed.get(&key).is_none(), "ERR_ALREADY_REGISTERED");
        require!(proposal.id == proposal_id.0, "ERR_BAD_PROPOSAL");
        require!(
            proposal.description.len() <= MAX_DESCRIPTION,
            "ERR_DESCRIPTION_TOO_LONG"
        );
        require!(
            logic::parse_status(&proposal.status) == Some(DaoStatus::InProgress),
            "ERR_PROPOSAL_NOT_OPEN"
        );
        require!(
            !proposal.votes.values().any(|v| logic::is_dissent(v)),
            "ERR_ALREADY_CONTESTED"
        );

        let transfer = logic::parse_transfer(&proposal.kind)
            .unwrap_or_else(|| env::panic_str("ERR_NOT_A_TRANSFER"));
        require!(!transfer.has_msg, "ERR_TRANSFER_CALL_NOT_ALLOWED");
        let budget_token = budget.token.as_ref().map_or("", |t| t.as_str());
        require!(transfer.token == budget_token, "ERR_WRONG_TOKEN");
        let payee: AccountId = transfer
            .receiver
            .parse()
            .unwrap_or_else(|_| env::panic_str("ERR_BAD_PAYEE"));

        require!(
            logic::may_sponsor(
                budget.stewards.contains(&caller),
                budget.open,
                caller == proposal.proposer,
            ),
            "ERR_NOT_A_STEWARD"
        );
        let sponsor = caller;
        require!(budget.allow_self_pay || payee != sponsor, "ERR_SELF_PAY");

        let period_idx = logic::period_index(budget.created_at.0, budget.period_ns.0, now);
        if period_idx != budget.period_idx {
            budget.period_idx = period_idx;
            budget.spent = U128(0);
        }
        let limit = self.limit_of(&budget, &sponsor);
        require!(transfer.amount > 0, "ERR_ZERO_AMOUNT");
        require!(transfer.amount <= limit, "ERR_OVER_PERSONAL_LIMIT");
        require!(
            logic::fits_cap(budget.spent.0, budget.cap.0, transfer.amount),
            "ERR_OVER_BUDGET"
        );

        let deadline = now.saturating_add(budget.window_ns.0);
        let dao_expires_at = proposal
            .submission_time
            .0
            .saturating_add(facts.proposal_period_ns);
        require!(
            deadline
                .saturating_add(logic::GRACE_NS)
                .saturating_add(logic::EXPIRY_MARGIN_NS)
                <= dao_expires_at,
            "ERR_WINDOW_OUTLASTS_PROPOSAL"
        );

        let id = self.spends.len();
        self.spends.push(&Spend {
            id: U64(id),
            budget_id,
            dao: budget.dao.clone(),
            proposal_id,
            sponsor: sponsor.clone(),
            payee: payee.clone(),
            amount: U128(transfer.amount),
            status: Status::Silent,
            route: None,
            filed_at: U64(now),
            deadline: U64(deadline),
            dao_expires_at: U64(dao_expires_at),
            voted_at: None,
            last_objection_attempt: None,
            objector: None,
            reason: None,
            period_idx,
        });
        self.claimed.insert(&key, &id);
        let index = self.dao_spend_count.get(&budget.dao).unwrap_or(0);
        self.dao_spend_at.insert(&(budget.dao.clone(), index), &id);
        self.dao_spend_count.insert(&budget.dao, &(index + 1));

        budget.spent = U128(budget.spent.0 + transfer.amount);
        budget.spend_count += 1;
        let used = env::storage_usage().saturating_sub(before) + RESERVE_BYTES;
        let cost = byte_cost(used);
        require!(budget.credit.0 >= cost, "ERR_NO_CREDIT");
        budget.credit = U128(budget.credit.0 - cost);
        self.budgets.replace(u64::from(budget_id), &budget);

        emit(
            "spend_filed",
            json!({
                "spend_id": U64(id),
                "budget_id": budget_id,
                "dao": budget.dao,
                "proposal_id": proposal_id,
                "sponsor": sponsor,
                "payee": payee,
                "amount": U128(transfer.amount),
                "deadline": U64(deadline),
            }),
        );
        U64(id)
    }

    /// Break the silence. The spend then needs the DAO's normal vote and Tacit will never vote on it.
    pub fn object(&mut self, spend_id: U64, reason: String) -> PromiseOrValue<()> {
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_REASON,
            "ERR_REASON"
        );
        let mut spend = self.spend(spend_id);
        require!(spend.status == Status::Silent, "ERR_NOT_SILENT");
        let now = env::block_timestamp();
        let budget = self.budget(spend.budget_id);
        require!(
            budget.paused_by.is_some() || now < effective_deadline(&spend, &budget),
            "ERR_WINDOW_CLOSED"
        );
        let objector = env::predecessor_account_id();

        // A sponsor can stop their own spend, for instance after a typo in the payee. They may not
        // jump ahead of a member's objection that is still being checked.
        if objector == spend.sponsor && !budget.open {
            let settled = spend
                .last_objection_attempt
                .map_or(true, |t| now >= t.0.saturating_add(logic::GRACE_NS));
            require!(settled, "ERR_OBJECTION_IN_FLIGHT");
        }
        if budget.open || objector == spend.sponsor {
            self.break_silence(&mut spend, objector, reason);
            return PromiseOrValue::Value(());
        }

        // Membership is checked against the DAO's live policy in a later block. Recording the
        // attempt now stops a vote from slipping in before that answer arrives.
        spend.last_objection_attempt = Some(U64(now));
        self.spends.replace(spend_id.0, &spend);
        ext_dao::ext(spend.dao)
            .with_static_gas(GAS_READ_POLICY)
            .get_policy()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_OBJECTION)
                    .on_objection(spend_id, objector, reason),
            )
            .into()
    }

    #[private]
    pub fn on_objection(
        &mut self,
        spend_id: U64,
        objector: AccountId,
        reason: String,
        #[callback_result] policy: Result<Value, PromiseError>,
    ) {
        let is_member = policy
            .ok()
            .and_then(|p| {
                logic::read_policy(&p, env::current_account_id().as_str(), objector.as_str())
            })
            .is_some_and(|f| f.is_member);
        require!(is_member, "ERR_NOT_A_MEMBER");
        let mut spend = self.spend(spend_id);
        require!(spend.status == Status::Silent, "ERR_NOT_SILENT");
        self.break_silence(&mut spend, objector, reason);
    }

    /// Stop a budget now. Any council or group member can pull this. Only the DAO can resume it.
    pub fn pause_budget(&mut self, budget_id: u32) -> Promise {
        let budget = self.budget(budget_id);
        ext_dao::ext(budget.dao)
            .with_static_gas(GAS_READ_POLICY)
            .get_policy()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAUSE)
                    .on_pause(budget_id, env::predecessor_account_id()),
            )
    }

    #[private]
    pub fn on_pause(
        &mut self,
        budget_id: u32,
        caller: AccountId,
        #[callback_result] policy: Result<Value, PromiseError>,
    ) {
        let is_member = policy
            .ok()
            .and_then(|p| {
                logic::read_policy(&p, env::current_account_id().as_str(), caller.as_str())
            })
            .is_some_and(|f| f.is_member);
        require!(is_member, "ERR_NOT_A_MEMBER");
        let mut budget = self.budget(budget_id);
        budget.paused_by = Some(caller.clone());
        self.budgets.replace(u64::from(budget_id), &budget);
        emit(
            "budget_paused",
            json!({"budget_id": budget_id, "by": caller}),
        );
    }

    /// Move a spend forward. Anyone may call this, and it is safe to call at any time.
    pub fn advance(&mut self, spend_id: U64) -> Promise {
        let spend = self.spend(spend_id);
        require!(
            matches!(
                spend.status,
                Status::Silent | Status::Paying | Status::Contested
            ),
            "ERR_NOTHING_TO_DO"
        );
        // A list read answers "not there" with an empty page. A single read would panic instead,
        // and a panic cannot be told apart from running out of gas.
        ext_dao::ext(spend.dao)
            .with_static_gas(GAS_READ_PROPOSAL)
            .get_proposals(spend.proposal_id.0, 1)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_ADVANCE)
                    .on_advance(spend_id),
            )
    }

    #[private]
    pub fn on_advance(
        &mut self,
        spend_id: U64,
        #[callback_result] read: Result<Vec<DaoProposal>, PromiseError>,
    ) -> PromiseOrValue<()> {
        let mut spend = self.spend(spend_id);
        let mut budget = self.budget(spend.budget_id);

        // A failed read tells us nothing, so nothing may change. The caller can simply retry.
        let page = read.unwrap_or_else(|_| env::panic_str("ERR_READ_FAILED"));
        let found = page.iter().find(|p| p.id == spend.proposal_id.0);
        let (dao_status, dissenter) = match found {
            Some(p) => {
                let mut dissenters: Vec<AccountId> = p
                    .votes
                    .iter()
                    .filter(|(_, v)| logic::is_dissent(v))
                    .map(|(a, _)| a.clone())
                    .collect();
                dissenters.sort();
                // Credit someone other than the sponsor whenever there is someone.
                let chosen = dissenters
                    .iter()
                    .find(|a| **a != spend.sponsor)
                    .or(dissenters.first())
                    .cloned();
                let status = logic::parse_status(&p.status)
                    .unwrap_or_else(|| env::panic_str("ERR_BAD_STATUS"));
                (status, chosen)
            }
            None => (DaoStatus::Removed, None),
        };

        let now = env::block_timestamp();
        let unexpired = budget.expires_at.map_or(true, |t| now < t.0);
        let sponsor_valid = unexpired && (budget.open || budget.stewards.contains(&spend.sponsor));

        let step = logic::next_step(&Facts {
            state: spend.status.into(),
            route: spend.route.map(Into::into),
            dao: dao_status,
            dissent: dissenter.is_some(),
            now,
            deadline: effective_deadline(&spend, &budget),
            last_objection_attempt: spend.last_objection_attempt.map(|t| t.0),
            voted_at: spend.voted_at.map(|t| t.0),
            dao_expires_at: spend.dao_expires_at.0,
            paused: budget.paused_by.is_some(),
            sponsor_valid,
        });

        match step {
            Step::Wait(code) => env::panic_str(code),
            Step::CastVote => {
                spend.status = Status::Voting;
                self.spends.replace(spend_id.0, &spend);
                return self.cast_vote(&spend, &budget).into();
            }
            Step::Escalate => {
                if spend.objector.is_none() {
                    spend.objector = dissenter;
                }
                spend.status = Status::Contested;
                self.spends.replace(spend_id.0, &spend);
                emit(
                    "silence_broken",
                    json!({
                        "spend_id": spend_id,
                        "dao": spend.dao,
                        "proposal_id": spend.proposal_id,
                        "by": spend.objector,
                    }),
                );
            }
            Step::BeginPaying(route) => {
                spend.status = Status::Paying;
                spend.route = Some(route.into());
                spend.voted_at = Some(U64(env::block_timestamp()));
                self.spends.replace(spend_id.0, &spend);
            }
            Step::Finish(end) => {
                if spend.objector.is_none() {
                    spend.objector = dissenter;
                }
                self.finish(&mut spend, &mut budget, end.into());
            }
        }
        PromiseOrValue::Value(())
    }

    #[private]
    pub fn on_voted(&mut self, spend_id: U64) {
        let mut spend = self.spend(spend_id);
        if near_sdk::is_promise_success() {
            spend.status = Status::Paying;
            spend.route = Some(Route::Silence);
            spend.voted_at = Some(U64(env::block_timestamp()));
            self.spends.replace(spend_id.0, &spend);
            emit(
                "silence_held",
                json!({
                    "spend_id": spend_id,
                    "dao": spend.dao,
                    "proposal_id": spend.proposal_id,
                }),
            );
        } else {
            // Usually means the DAO removed Tacit's role. Hand the spend back to the normal vote.
            spend.status = Status::Contested;
            self.spends.replace(spend_id.0, &spend);
            emit(
                "vote_failed",
                json!({"spend_id": spend_id, "dao": spend.dao, "proposal_id": spend.proposal_id}),
            );
        }
    }

    // ---- Views ----

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    pub fn get_budget(&self, budget_id: u32) -> Option<Budget> {
        self.budgets.get(u64::from(budget_id))
    }

    pub fn get_spend(&self, spend_id: U64) -> Option<Spend> {
        self.spends.get(spend_id.0)
    }

    pub fn spend_for_proposal(&self, dao: AccountId, proposal_id: U64) -> Option<Spend> {
        self.claimed
            .get(&(dao, proposal_id.0))
            .and_then(|id| self.spends.get(id))
    }

    pub fn list_budgets(&self, dao: AccountId, from: u32, limit: u32) -> Vec<Budget> {
        let count = self.dao_budget_count.get(&dao).unwrap_or(0);
        (from..count.min(from.saturating_add(limit)))
            .filter_map(|i| self.dao_budget_at.get(&(dao.clone(), i)))
            .filter_map(|id| self.budgets.get(u64::from(id)))
            .collect()
    }

    pub fn list_spends(&self, dao: AccountId, from: u32, limit: u32) -> Vec<Spend> {
        let count = self.dao_spend_count.get(&dao).unwrap_or(0);
        (from..count.min(from.saturating_add(limit)))
            .filter_map(|i| self.dao_spend_at.get(&(dao.clone(), i)))
            .filter_map(|id| self.spends.get(id))
            .collect()
    }

    pub fn count_spends(&self, dao: AccountId) -> u32 {
        self.dao_spend_count.get(&dao).unwrap_or(0)
    }

    pub fn get_record(&self, budget_id: u32, account: AccountId) -> Record {
        self.record_of(budget_id, &account)
    }

    /// The largest single spend `account` may sponsor from this budget today.
    pub fn limit_for(&self, budget_id: u32, account: AccountId) -> U128 {
        U128(self.limit_of(&self.budget(budget_id), &account))
    }

    pub fn totals(&self) -> Value {
        json!({"budgets": self.budgets.len(), "spends": self.spends.len()})
    }
}

impl Tacit {
    fn budget(&self, id: u32) -> Budget {
        self.budgets
            .get(u64::from(id))
            .unwrap_or_else(|| env::panic_str("ERR_NO_BUDGET"))
    }

    fn spend(&self, id: U64) -> Spend {
        self.spends
            .get(id.0)
            .unwrap_or_else(|| env::panic_str("ERR_NO_SPEND"))
    }

    fn record_of(&self, budget_id: u32, account: &AccountId) -> Record {
        self.records
            .get(&(budget_id, account.clone()))
            .unwrap_or_default()
    }

    fn limit_of(&self, budget: &Budget, account: &AccountId) -> u128 {
        logic::earned_limit(
            budget.base_limit.0,
            budget.step.0,
            budget.max_limit.0,
            self.record_of(budget.id, account).clean,
        )
    }

    fn update_record(&mut self, budget_id: u32, account: &AccountId, f: impl FnOnce(&mut Record)) {
        let mut record = self.record_of(budget_id, account);
        f(&mut record);
        self.records.insert(&(budget_id, account.clone()), &record);
    }

    fn break_silence(&mut self, spend: &mut Spend, objector: AccountId, reason: String) {
        spend.status = Status::Contested;
        spend.objector = Some(objector.clone());
        spend.reason = Some(reason.clone());
        self.spends.replace(spend.id.0, spend);
        emit(
            "silence_broken",
            json!({
                "spend_id": spend.id,
                "dao": spend.dao,
                "proposal_id": spend.proposal_id,
                "by": objector,
                "reason": reason,
            }),
        );
    }

    /// The only place Tacit acts on a DAO: one approving vote on a proposal it has checked.
    fn cast_vote(&self, spend: &Spend, budget: &Budget) -> Promise {
        let token = budget.token.as_ref().map_or("", |t| t.as_str());
        let args = json!({
            "id": spend.proposal_id.0,
            "action": "VoteApprove",
            "proposal": {
                "Transfer": {
                    "token_id": token,
                    "receiver_id": spend.payee,
                    "amount": spend.amount,
                    "msg": Value::Null,
                }
            },
            "memo": format!("Tacit spend {}: window closed with no objection", spend.id.0),
        });
        Promise::new(spend.dao.clone())
            .function_call(
                "act_proposal".to_string(),
                serde_json::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                GAS_ACT_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VOTED)
                    .on_voted(spend.id),
            )
    }

    /// Close a spend, release its reservation if the money never moved, and update records.
    fn finish(&mut self, spend: &mut Spend, budget: &mut Budget, end: Status) {
        let release = |budget: &mut Budget, spend: &Spend| {
            if spend.period_idx == budget.period_idx {
                budget.spent = U128(budget.spent.0.saturating_sub(spend.amount.0));
            }
        };
        let budget_id = budget.id;
        // Stopping your own spend is a correction, so it never counts for or against anyone.
        let outside_objector = spend.objector.clone().filter(|o| *o != spend.sponsor);
        let stopped_own = spend.objector.as_ref() == Some(&spend.sponsor);
        match end {
            Status::Paid => {
                budget.total_paid = U128(budget.total_paid.0.saturating_add(spend.amount.0));
                match spend.route {
                    Some(Route::Overruled) => {
                        if !stopped_own {
                            self.update_record(budget_id, &spend.sponsor, |r| r.overruled_for += 1);
                        }
                        if let Some(objector) = outside_objector {
                            self.update_record(budget_id, &objector, |r| r.objections_overruled += 1);
                        }
                    }
                    route => {
                        let limit = self.limit_of(budget, &spend.sponsor);
                        // Only silence earns credit. A vote the council would have held anyway proves nothing.
                        let earns = route == Some(Route::Silence)
                            && logic::earns_credit(spend.amount.0, limit);
                        self.update_record(budget_id, &spend.sponsor, |r| {
                            r.passed += 1;
                            if earns {
                                r.clean += 1;
                            }
                        });
                    }
                }
            }
            Status::Upheld => {
                release(budget, spend);
                if !stopped_own {
                    self.update_record(budget_id, &spend.sponsor, |r| {
                        r.clean = 0;
                        r.upheld_against += 1;
                    });
                }
                if let Some(objector) = outside_objector {
                    self.update_record(budget_id, &objector, |r| r.objections_upheld += 1);
                }
            }
            _ => release(budget, spend),
        }
        spend.status = end;
        self.spends.replace(spend.id.0, spend);
        self.budgets.replace(u64::from(budget.id), budget);
        emit(
            "spend_closed",
            json!({
                "spend_id": spend.id,
                "dao": spend.dao,
                "proposal_id": spend.proposal_id,
                "status": spend.status,
                "route": spend.route,
            }),
        );
    }
}
