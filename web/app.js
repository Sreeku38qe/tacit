import { CONFIG, accountOf, explorerAccount, formatNear, nearToYocto, view } from "./chain.js";
import { analyse, loadDao } from "./report.js";
import { act, connectWallet, disconnectWallet, initSession, onSession, session, setPersona } from "./session.js";

const $view = document.getElementById("view");
const NET = CONFIG.network;
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (id) => esc(String(id).replace(`.${CONFIG.contract.split(".").slice(1).join(".")}`, ""));
const num = (n) => Number(n).toLocaleString("en-US");
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "0%");

const MESSAGES = {
  ERR_STILL_SILENT: "The window is still open. Try again when the clock runs out.",
  ERR_OBJECTION_IN_FLIGHT: "An objection may be arriving. Try again in 30 seconds.",
  ERR_STILL_SETTLING: "Checking that the payment landed. Try again in a few seconds.",
  ERR_STILL_CONTESTED: "This needs a council vote now.",
  ERR_NOT_A_MEMBER: "Only members of this DAO can object.",
  ERR_WINDOW_CLOSED: "The window has closed, so it is too late to object.",
  ERR_NOT_SILENT: "This payment is no longer waiting on silence.",
  ERR_OVER_PERSONAL_LIMIT: "That is more than your limit on this budget. A record of clean payments raises it.",
  ERR_OVER_BUDGET: "That would take this budget over its cap for the period.",
  ERR_NOT_A_STEWARD: "You are not a steward of this budget.",
  ERR_SELF_PAY: "A steward cannot pay themselves from this budget.",
  ERR_PAUSED: "A council member has paused this budget.",
  ERR_ALREADY_REGISTERED: "That proposal is already on the board.",
  ERR_ONLY_THE_DAO: "Only the DAO can do that, through a normal proposal.",
  ERR_NOT_INSTALLED: "Tacit is not installed on this DAO yet.",
  ERR_READ_FAILED: "The chain did not answer in time. Nothing changed, so try again.",
  ERR_PAYMENT_CAN_STILL_BE_RETRIED: "The payment failed on the DAO, and can be retried there until the proposal expires.",
  ERR_DESCRIPTION_TOO_LONG: "That proposal's description is too long for Tacit.",
  ERR_NO_CREDIT: "This budget needs a storage top-up.",
};
const readable = (err) => {
  const text = String(err?.message || err);
  const code = Object.keys(MESSAGES).find((k) => text.includes(k));
  return code ? MESSAGES[code] : text;
};

let toastTimer;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5200);
}

/* ---- Masthead ---- */
function renderWho() {
  const el = document.getElementById("who");
  if (session.mode === "demo") {
    el.innerHTML = `
      <label for="persona" class="demo-tag">Acting as</label>
      <select id="persona">${session.people
        .map((p) => `<option value="${esc(p.id)}" ${p.id === session.accountId ? "selected" : ""}>${esc(p.name)} (${esc(p.role)})</option>`)
        .join("")}</select>`;
    el.querySelector("#persona").addEventListener("change", (e) => setPersona(e.target.value));
  } else if (session.accountId) {
    el.innerHTML = `<span class="mono">${esc(session.accountId)}</span><button class="btn" id="signout">Disconnect</button>`;
    el.querySelector("#signout").addEventListener("click", () => disconnectWallet());
  } else if (session.mode === "wallet") {
    el.innerHTML = `<button class="btn" id="signin">Connect wallet</button>`;
    el.querySelector("#signin").addEventListener("click", () =>
      connectWallet().catch((err) => toast(`Could not open wallets: ${readable(err)}`)),
    );
  } else {
    el.innerHTML = "";
  }
  document.getElementById("foot-net").textContent =
    session.mode === "demo" ? `Demo mode on ${NET}. Keys stay on this computer.` : `Live board runs on NEAR ${NET}. Silence reports read mainnet.`;
}

/* ---- Home ---- */
async function home() {
  $view.innerHTML = `
  <section class="hero">
    <p class="eyebrow">A silence procedure for Sputnik DAO budgets</p>
    <h1>Silence used to mean <span class="flip"><span class="was">no</span><span class="now" aria-label="yes">yes</span></span>.</h1>
    <p class="lede">Your council approves a budget once. After that, a payment inside it goes through unless someone objects in time. If anyone does, it goes back to a normal council vote.</p>
    <div class="cta"><a class="btn btn-solid" href="#board">Watch a payment go through</a><a class="btn" href="#report">Check your DAO</a></div>
  </section>
  <div id="census"></div>
  <section class="steps">
    <h2>How a payment goes through</h2>
    <ol>
      <li><h3>The council approves a budget once</h3><p>One normal Sputnik proposal sets the steward, the monthly cap, the limit per payment and how long people have to object.</p></li>
      <li><h3>The payment is posted as a notice</h3><p>The steward files an ordinary transfer proposal, so it still shows up in Trezu. Tacit checks it against the budget and starts the clock.</p></li>
      <li><h3>Silence holds, or someone speaks</h3><p>No objection by the deadline: Tacit casts one yes vote and the DAO pays. Any objection: Tacit will never vote on it, and the council decides.</p></li>
    </ol>
  </section>
  <section class="bounds">
    <p><strong>Silence can only spend what the council approved.</strong> <span>Caps and limits are enforced on chain from the DAO's own proposal data.</span></p>
    <p><strong>An objection can only force the vote you would have had anyway.</strong> <span>The worst a troublemaker can do is make the council decide.</span></p>
    <p><strong>Tacit cannot move money.</strong> <span>The contract has no code that sends tokens. Funds stay in the DAO until Sputnik pays them.</span></p>
    <p><strong>One proposal removes it.</strong> <span>Delete the role and Tacit has no power over the DAO. Nothing needs migrating.</span></p>
  </section>`;
  renderCensus();
}

async function renderCensus() {
  const box = document.getElementById("census");
  let c;
  try {
    c = await (await fetch("census.json")).json();
  } catch {
    box.innerHTML = "";
    return;
  }
  if (!box.isConnected) return;
  const d = c.per_dao;
  const a = c.all;
  const rows = [
    { name: "More died in silence than were voted down", n: d.silence_killed_more, hot: true },
    { name: "More were voted down than died in silence", n: d.rejection_killed_more },
    { name: "The two were equal", n: d.tied },
  ];
  const top = Math.max(...rows.map((r) => r.n));
  const whole = d.daos_where_a_proposal_failed;
  const t = c.without_newsrooms_transfers;
  const repeat = c.repeat_payees_without_newsrooms.outcomes;
  const repeatTotal = Object.values(repeat).reduce((s, n) => s + n, 0);
  const ignored = (repeat.Expired || 0) + (repeat.Stale || 0);
  box.innerHTML = `
  <section class="ledger">
    <div class="ledger-copy">
      <h2>Most DAOs lose more proposals to silence than to a no</h2>
      <p>We read every proposal in ${num(c.daos.read)} Sputnik DAOs on mainnet. In ${num(d.silence_killed_more)} of them, more proposals ran out of time with no one against them than were ever voted down. The reverse was true in ${num(d.rejection_killed_more)}.</p>
      <p><a href="#report">Run the same report on your own DAO</a></p>
    </div>
    <ul class="bars" aria-label="Which ended more proposals in each of ${num(whole)} DAOs">
      ${rows
        .map(
          (r) => `<li class="bar-row ${r.hot ? "hot" : ""}" title="${esc(r.name)}: ${num(r.n)} DAOs, ${pct(r.n, whole)} of the ${num(whole)} where a proposal has failed">
            <span class="name">${esc(r.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(100 * r.n) / top}%"></span></span>
            <span class="val">${num(r.n)} DAOs<small>${pct(r.n, whole)}</small></span>
          </li>`,
        )
        .join("")}
    </ul>
    <p class="ledger-note">${num(a.total)} proposals read on ${esc(c.generated_at.slice(0, 10))}, counting each of the ${num(whole)} DAOs where a proposal has failed once. "Died in silence" means it expired or sat open past its voting period with no vote against it. One DAO run by bridge software is left out. The figures below also leave out two newsroom DAOs where editors reject submissions as routine. Reproduce all of it with scripts/census.py.</p>
  </section>
  <section class="facts">
    <div class="fact"><b>${num(a.died_only_yes)}</b><p>proposals got at least one yes, not one no, and still died because nobody else came back.</p></div>
    <div class="fact"><b>${pct(t.approved_with_no_dissent, t.approved)}</b><p>of the ${num(t.approved)} transfers that passed had no vote against them at all.</p></div>
    <div class="fact"><b>${pct(ignored, repeatTotal)}</b><p>of payments to someone a DAO had already paid three times were simply ignored until they expired. Only ${pct(repeat.Rejected || 0, repeatTotal)} were rejected.</p></div>
  </section>`;
}

/* ---- Board ---- */
const STATUS = {
  Silent: { chip: "Clock running", cls: "silent" },
  Voting: { chip: "Voting", cls: "silent" },
  Paying: { chip: "Confirming payment", cls: "silent" },
  Paid: { chip: "Paid", cls: "paid" },
  Contested: { chip: "Needs a council vote", cls: "contested" },
  Upheld: { chip: "Rejected", cls: "upheld" },
  Lapsed: { chip: "Expired", cls: "other" },
  Failed: { chip: "Payment failed", cls: "other" },
};

const board = { timer: null, ticker: null, proposals: new Map(), budgets: [], spends: [], policy: null, objecting: null, drafts: new Map(), seen: new Map(), busy: new Set(), records: [], tick: 0 };

const field = (description, key) => {
  const match = String(description || "").match(new RegExp(`\\* ${key}:\\s*(.*?)\\s*(?:<br>|$)`, "i"));
  return match ? match[1] : "";
};
const whenClosed = (ns) =>
  new Date(Number(BigInt(ns) / 1000000n)).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The moment a window really closes: resuming a paused budget gives waiting payments a fresh one. */
function deadlineOf(s, budget) {
  const original = BigInt(s.deadline);
  if (!budget?.resumed_at) return original;
  const fresh = BigInt(budget.resumed_at) + BigInt(budget.window_ns);
  return fresh > original ? fresh : original;
}

function councilOf(policy) {
  const role = policy?.roles.find((r) => r.name === "council");
  return role?.kind?.Group || [];
}
function isMember(account) {
  return (board.policy?.roles || []).some((r) => r.kind?.Group?.includes(account));
}

function noticeHtml(s, isNew) {
  const p = board.proposals.get(s.proposal_id);
  const b = board.budgets.find((x) => x.id === s.budget_id);
  const info = STATUS[s.status];
  const title = field(p?.description, "Title") || (p?.description ?? `Proposal ${s.proposal_id}`);
  const council = councilOf(board.policy);
  const councilVotes = p ? Object.keys(p.votes).filter((a) => council.includes(a)).length : 0;
  const me = session.accountId;
  const nowNs = BigInt(Date.now()) * 1000000n;
  const deadline = deadlineOf(s, b);
  const open = s.status === "Silent" && nowNs < deadline;
  const paused = !!b?.paused_by;
  const canObject = s.status === "Silent" && (open || paused) && me && (b?.open || isMember(me) || me === s.sponsor);

  let body = "";
  if (s.status === "Silent") {
    const total = Number(deadline - BigInt(s.filed_at)) / 1e6;
    body = `<div class="clock" data-deadline="${esc(deadline)}" data-total="${total}">
        <span class="clock-left">--:--</span><span class="clock-say">left to object</span>
        <div class="fuse"><i></i></div>
      </div>`;
  }
  if (s.reason || s.objector) {
    body += `<p class="reason">${s.reason ? `“${esc(s.reason)}”` : "Voted against it on the DAO."}<span>${short(s.objector || "")}</span></p>`;
  }

  let actions = "";
  const id = esc(s.id);
  if (canObject && board.objecting === s.id) {
    actions = `<form data-object="${id}">
      <input id="reason-${id}" name="reason" maxlength="200" placeholder="Say why, in a sentence" value="${esc(board.drafts.get(s.id) || "")}" required />
      <button class="btn btn-object" type="submit">Break the silence</button>
      <button class="btn" type="button" data-cancel>Cancel</button>
    </form>`;
  } else {
    if (canObject) actions += `<button class="btn btn-object" data-start-object="${id}">Object</button>`;
    if (s.status === "Silent" && !open && !paused) {
      actions += `<button class="btn btn-solid" data-advance="${id}">Close the window</button><span class="quiet">Anyone can do this. It casts the vote.</span>`;
    }
    if (s.status === "Silent" && paused) actions += `<span class="quiet">This budget is paused, so the clock has stopped.</span>`;
    if (s.status === "Paying") actions += `<span class="quiet">Tacit has voted. Checking that the money landed.</span>`;
    if (s.status === "Contested" && me && council.includes(me) && p && !p.votes[me] && p.status === "InProgress") {
      actions += `<button class="btn" data-vote="Approve" data-spend="${id}">Approve anyway</button><button class="btn btn-object" data-vote="Reject" data-spend="${id}">Reject</button>`;
    }
    if (s.status === "Contested") {
      actions += `<span class="quiet">${councilVotes} of ${council.length} council votes in. Tacit will not vote on this.</span>`;
    }
    if (open && !actions) actions = `<span class="quiet">Only members can object here.</span>`;
  }

  let rubber = "";
  if (s.status === "Paid" && s.route === "Silence") {
    rubber = `<div class="rubber"><b>No objection</b><small>Paid by silence</small></div>`;
  } else if (s.status === "Paid") {
    rubber = `<div class="rubber green"><b>Paid</b><small>${s.route === "Overruled" ? "Council overruled the objection" : "Council voted it through"}</small></div>`;
  } else if (s.status === "Contested") {
    rubber = `<div class="rubber red"><b>Objected</b><small>Silence broken</small></div>`;
  } else if (s.status === "Upheld") {
    rubber = `<div class="rubber red"><b>Rejected</b><small>The objection held</small></div>`;
  }

  const sig = JSON.stringify([s.status, s.route, s.objector, councilVotes, canObject, board.objecting === s.id, open, paused, !!(me && council.includes(me) && p && !p.votes[me])]);
  return {
    sig,
    html: `<article class="notice ${isNew ? "just" : ""}" data-id="${id}" data-sig="${esc(sig)}">
      <div class="notice-head"><span class="notice-no">Notice ${id} · ${esc(whenClosed(s.filed_at))}</span><span class="chip chip-${info.cls}">${info.chip}</span></div>
      <h3>${esc(title)}</h3>
      <p class="pay"><strong>${formatNear(s.amount)} NEAR</strong> to ${short(s.payee)}</p>
      <dl class="meta">
        <div><dt>Budget</dt><dd>${esc(b?.label ?? s.budget_id)}</dd></div>
        <div><dt>Answerable</dt><dd>${short(s.sponsor)}</dd></div>
        <div><dt>DAO proposal</dt><dd>#${esc(s.proposal_id)}</dd></div>
        <div><dt>Council votes</dt><dd>${councilVotes} of ${council.length}</dd></div>
      </dl>
      ${body}
      ${actions ? `<div class="notice-actions">${actions}</div>` : ""}
      ${rubber}
    </article>`,
  };
}

function renderNotices() {
  const box = document.getElementById("notices");
  if (!box) return;
  if (!board.spends.length) {
    box.innerHTML = `<p class="quiet">No notices yet. Post a payment from a budget to start one.</p>`;
    return;
  }
  const active = document.activeElement;
  const keepFocus = active && active.id && active.id.startsWith("reason-");
  const wanted = [];
  for (const s of board.spends) {
    const prev = board.seen.get(s.id);
    const justStamped = prev !== undefined && prev !== s.status && ["Paid", "Contested", "Upheld"].includes(s.status);
    board.seen.set(s.id, s.status);
    let el = box.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
    const { sig, html } = noticeHtml(s, justStamped);
    if (!el || el.dataset.sig !== sig) {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const fresh = holder.firstElementChild;
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    wanted.push(el);
  }
  [...box.children].forEach((child) => {
    if (!wanted.includes(child)) child.remove();
  });
  wanted.forEach((el, i) => {
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  if (keepFocus) document.getElementById(active.id)?.focus();
  tickClocks();
}

function tickClocks() {
  const now = Date.now();
  document.querySelectorAll(".clock[data-deadline]").forEach((clock) => {
    const left = Number(BigInt(clock.dataset.deadline) / 1000000n) - now;
    const total = Number(clock.dataset.total);
    const secs = Math.max(0, Math.ceil(left / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    clock.querySelector(".clock-left").textContent = h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(s).padStart(2, "0")}`;
    clock.querySelector(".clock-say").textContent = secs ? "left to object" : "No one objected";
    clock.querySelector(".fuse i").style.width = `${Math.max(0, Math.min(100, (100 * left) / total))}%`;
    if (left <= 0 && !clock.dataset.done) {
      clock.dataset.done = "1";
      renderNotices();
    }
  });
}

function renderSide() {
  const box = document.getElementById("budgets");
  if (!box) return;
  box.innerHTML = board.budgets
    .map((b) => {
      const used = Number((BigInt(b.spent) * 1000n) / BigInt(b.cap)) / 10;
      const windowSecs = Number(b.window_ns) / 1e9;
      const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
      const window = windowSecs >= 3600 ? plural(Math.round(windowSecs / 3600), "hour") : plural(Math.round(windowSecs / 60), "minute");
      const periodDays = Math.round(Number(b.period_ns) / 8.64e13);
      const limits = b.base_limit === b.max_limit
        ? `Limit per payment ${formatNear(b.base_limit)}.`
        : `Limit per payment starts at ${formatNear(b.base_limit)}, grows to ${formatNear(b.max_limit)}.`;
      return `<div class="budget">
        <div class="budget-name"><span>${esc(b.label)}</span>${b.paused_by ? `<span class="chip chip-contested">Paused</span>` : b.open ? `<span class="chip chip-other">Open to anyone</span>` : ""}</div>
        <span class="meter" role="img" aria-label="${used}% of the cap used"><i style="width:${Math.min(100, used)}%"></i></span>
        <div class="budget-lines">
          <span class="mono">${formatNear(b.spent)} of ${formatNear(b.cap)} NEAR this ${periodDays === 30 ? "month" : periodDays === 1 ? "day" : `${periodDays} days`}</span>
          <span>${window} to object. ${limits}</span>
          ${b.stewards.length ? `<span>Steward: ${b.stewards.map(short).join(", ")}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const form = document.getElementById("file-box");
  const me = session.accountId;
  const usable = board.budgets.filter((b) => b.open || (me && b.stewards.includes(me)));
  if (form && form.dataset.owner !== `${me}:${usable.length}`) {
    form.dataset.owner = `${me}:${usable.length}`;
    form.innerHTML = usable.length && me
      ? `<form class="file-form" id="file-form">
          <label class="wide">Budget<select id="f-budget">${usable.map((b) => `<option value="${b.id}">${esc(b.label)}</option>`).join("")}</select></label>
          <label class="wide">What is it for?<input id="f-title" required maxlength="80" placeholder="Hall rental for Saturday's workshop" /></label>
          <label>Pay to<input id="f-payee" required placeholder="name.testnet" /></label>
          <label>Amount in NEAR<input id="f-amount" required inputmode="decimal" placeholder="0.25" /></label>
          <div class="wide"><button class="btn btn-solid" id="f-submit" type="submit">Post the notice</button></div>
        </form>`
      : `<p class="quiet">${me ? "You are not a steward of a budget here." : "Connect a wallet to post from the open pot."}</p>`;
  }

  const table = document.getElementById("records");
  if (table) {
    table.innerHTML = board.records.length
      ? `<table><thead><tr><th>Account</th><th class="n">Clean</th><th class="n">Limit now</th><th class="n">Rejected</th><th class="n">Objections held</th></tr></thead><tbody>
        ${board.records
          .map(
            (r) => `<tr><td>${short(r.account)}</td><td class="n">${r.clean}</td><td class="n">${r.limit ? formatNear(r.limit) : "-"}</td><td class="n">${r.upheld_against}</td><td class="n">${r.objections_upheld}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="quiet">Records appear after the first payment closes.</p>`;
  }
}

async function refreshBoard() {
  const { contract, dao } = CONFIG;
  const [count, budgets, available, policy] = await Promise.all([
    view(NET, contract, "count_spends", { dao }),
    view(NET, contract, "list_budgets", { dao, from: 0, limit: 10 }),
    view(NET, dao, "get_available_amount"),
    board.policy && board.tick % 8 ? board.policy : view(NET, dao, "get_policy"),
  ]);
  // Budgets named "E2E ..." exist only for the automated test run, so they stay off the public board.
  const shown = budgets.filter((b) => !b.label.startsWith("E2E"));
  const from = Math.max(0, count - 40);
  const recent = (await view(NET, contract, "list_spends", { dao, from, limit: 40 })).reverse();
  // ?since=N hides earlier notices, so a demo recording can start from a clear board.
  const since = Number(new URLSearchParams(location.search).get("since") || 0);
  const spends = recent.filter((s) => shown.some((b) => b.id === s.budget_id) && Number(s.id) >= since).slice(0, 12);
  board.budgets = shown;
  board.policy = policy;
  await Promise.all(
    spends.map(async (s) => {
      const cached = board.proposals.get(s.proposal_id);
      const settled = ["Paid", "Upheld", "Lapsed", "Failed", "Withdrawn"].includes(s.status);
      if (cached && settled) return;
      try {
        board.proposals.set(s.proposal_id, await view(NET, dao, "get_proposal", { id: Number(s.proposal_id) }));
      } catch {
        // A removed proposal has no details left to show.
      }
    }),
  );
  board.spends = spends;
  const treasury = document.getElementById("treasury");
  if (treasury) treasury.textContent = formatNear(available, 2);

  if (board.tick % 4 === 0) {
    const people = [...new Set([...spends.flatMap((s) => [s.sponsor, s.objector].filter(Boolean))])].slice(0, 8);
    const steward = shown.find((b) => !b.open);
    board.records = steward
      ? await Promise.all(
          people.map(async (account) => {
            const [record, limit] = await Promise.all([
              view(NET, contract, "get_record", { budget_id: steward.id, account }),
              steward.stewards.includes(account) ? view(NET, contract, "limit_for", { budget_id: steward.id, account }) : null,
            ]);
            return { account, limit, ...record };
          }),
        )
      : [];
  }
  board.tick += 1;
  renderSide();
  renderNotices();
}

async function boardView() {
  $view.innerHTML = `
  <section class="board-top">
    <div>
      <p class="eyebrow">Live on NEAR ${NET} · ${esc(CONFIG.dao)}</p>
      <h2>Sunday Makers notice board</h2>
      <p class="sub">A weekend makerspace on an unmodified Sputnik DAO. Demo windows are minutes long so you can watch one close. A real budget would give people 48 hours.</p>
    </div>
    <div class="treasury"><p class="eyebrow">In the treasury</p><b><span id="treasury">--</span> NEAR</b></div>
  </section>
  <section class="strip" id="budgets" aria-label="Standing budgets"></section>
  <section class="board">
    <div class="notices" id="notices"><p class="loading">Reading the chain</p></div>
    <aside class="side">
      <div class="panel"><h3>Post a payment</h3><div id="file-box"></div></div>
      <div class="panel"><h3>Track records</h3><div class="table-wrap" id="records"></div></div>
    </aside>
  </section>`;
  board.spends = [];
  board.seen = new Map();
  const load = () => refreshBoard().catch((err) => console.warn(err));
  await load();
  clearInterval(board.timer);
  clearInterval(board.ticker);
  board.timer = setInterval(load, 3000);
  board.ticker = setInterval(tickClocks, 250);
}

async function runAction(button, name, params, doneText) {
  if (button) button.disabled = true;
  try {
    await act(name, params);
    toast(doneText);
    await refreshBoard();
  } catch (err) {
    toast(readable(err));
  } finally {
    if (button) button.disabled = false;
  }
}

$view.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.startObject) {
    board.objecting = target.dataset.startObject;
    renderNotices();
    document.getElementById(`reason-${board.objecting}`)?.focus();
  }
  if (target.hasAttribute("data-cancel")) {
    board.objecting = null;
    renderNotices();
  }
  if (target.dataset.advance) runAction(target, "advance", { spendId: target.dataset.advance }, "Done.");
  if (target.dataset.vote) {
    const spend = board.spends.find((s) => s.id === target.dataset.spend);
    const proposal = board.proposals.get(spend.proposal_id);
    runAction(
      target,
      "vote",
      { proposalId: spend.proposal_id, action: target.dataset.vote === "Approve" ? "VoteApprove" : "VoteReject", kind: proposal.kind },
      "Vote recorded on the DAO.",
    );
  }
});

$view.addEventListener("input", (event) => {
  if (event.target.id?.startsWith("reason-")) board.drafts.set(event.target.id.slice(7), event.target.value);
});

$view.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.dataset.object) {
    const spendId = form.dataset.object;
    const reason = form.querySelector("input").value.trim();
    if (!reason) return;
    board.objecting = null;
    runAction(form.querySelector("button[type=submit]"), "object", { spendId, reason }, "Silence broken. The council decides now.");
  }
  if (form.id === "file-form") {
    const amount = nearToYocto(document.getElementById("f-amount").value);
    const params = {
      budgetId: Number(document.getElementById("f-budget").value),
      payee: document.getElementById("f-payee").value.trim(),
      amount,
      title: document.getElementById("f-title").value.trim(),
      notes: "Posted through Tacit. Passes unless someone objects in time.",
    };
    const button = document.getElementById("f-submit");
    runAction(button, "file", params, "Posted. The clock is running.").then(() => form.reset());
  }
  if (form.id === "lookup") {
    location.hash = `report/${form.querySelector("input").value.trim()}`;
  }
});

/* ---- Report ---- */
async function reportView(dao) {
  const examples = ["ref-finance.sputnik-dao.near", "meteor.sputnik-dao.near", "open-web-academy.sputnik-dao.near"];
  $view.innerHTML = `<div class="page">
    <div class="page-head">
      <p class="eyebrow">Silence report · reads mainnet directly</p>
      <h2>How do your DAO's proposals end?</h2>
      <p>Paste any Sputnik DAO. This reads its last 400 proposals from the chain, right now, in your browser.</p>
    </div>
    <form class="lookup" id="lookup"><input id="dao-input" aria-label="DAO account" value="${esc(dao)}" placeholder="your-dao.sputnik-dao.near" required /><button class="btn btn-solid" type="submit">Read it</button></form>
    <p class="examples"><span>Or try:</span>${examples.map((e) => `<a href="#report/${e}">${e}</a>`).join("")}</p>
    <div id="report-out">${dao ? `<p class="loading">Reading ${esc(dao)}</p>` : `<p class="quiet">Pick a DAO above to see its report.</p>`}</div>
  </div>`;
  if (!dao) return;
  const out = document.getElementById("report-out");
  try {
    const data = await loadDao(dao);
    if (!out.isConnected) return;
    const r = analyse(data);
    const s = r.suggestion;
    out.innerHTML = `
      <div class="tiles">
        <div class="tile hot"><b>${num(r.silent)}</b><span>died with nobody voting no</span></div>
        <div class="tile"><b>${num(r.rejected)}</b><span>were voted down</span></div>
        <div class="tile"><b>${num(r.onlyYes)}</b><span>had at least one yes and still died</span></div>
        <div class="tile"><b>${Math.round(r.turnout * 100)}%</b><span>average share of ${r.voters} voters who vote on a proposal</span></div>
      </div>
      <div class="two" style="margin-top:22px">
        <div class="draft">
          <h3>A budget that fits this DAO</h3>
          ${
            s
              ? `<dl>
                  <dt>Limit per payment</dt><dd>${formatNear(s.limit)} NEAR</dd>
                  <dt>Cap per month</dt><dd>${formatNear(s.cap)} NEAR</dd>
                  <dt>Time to object</dt><dd>48 hours</dd>
                  <dt>Payments that died in silence and would have fit</dt><dd>${num(s.wouldFit)}</dd>
                </dl>
                <p class="quiet">Worked out from ${num(s.basedOn)} NEAR transfers this DAO approved: the limit covers 80% of them and the cap covers a busy month.</p>
                <a class="btn btn-solid" href="#install/${esc(dao)}">Draft the proposals</a>`
              : `<p class="quiet">Not enough approved NEAR transfers to suggest a budget.</p>`
          }
        </div>
        <div>
          <h3>People this DAO keeps paying</h3>
          <p class="quiet">Three or more approved payments. Each one needed its own vote.</p>
          ${
            r.repeatPayees.length
              ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th class="n">Approved payments</th></tr></thead><tbody>${r.repeatPayees
                  .map(([a, n]) => `<tr><td>${esc(a)}</td><td class="n">${n}</td></tr>`)
                  .join("")}</tbody></table></div>`
              : `<p class="quiet">Nobody yet.</p>`
          }
        </div>
      </div>
      <p class="quiet" style="margin-top:18px">${num(r.total)} proposals read of ${num(data.last)}. ${num(r.approved)} passed, ${num(r.failed)} failed after approval, ${num(r.open)} are still open. Voting period ${r.periodDays} days. <a href="${explorerAccount("mainnet", dao)}">See the account</a></p>`;
  } catch (err) {
    if (out.isConnected) out.innerHTML = `<p class="error">Could not read that DAO. ${esc(readable(err))} Check the account name ends in .sputnik-dao.near.</p>`;
  }
}

/* ---- Install ---- */
function installView(dao) {
  const v = { dao: dao || CONFIG.dao, label: "Workshop costs", steward: "", hours: 48, days: 30, cap: "100", base: "5", step: "1", max: "20" };
  $view.innerHTML = `<div class="page">
    <div class="page-head">
      <p class="eyebrow">Install on an existing DAO</p>
      <h2>Two ordinary proposals. Nothing moves.</h2>
      <p>Your council votes on these the normal way, in Trezu or anywhere else. Funds stay where they are.</p>
    </div>
    <form class="install-form" id="install-form">
      <label class="wide">Your DAO<input id="i-dao" value="${esc(v.dao)}" /></label>
      <label class="wide">Budget name<input id="i-label" value="${esc(v.label)}" /></label>
      <label class="wide">Steward account<input id="i-steward" value="${esc(v.steward)}" placeholder="name.near" /></label>
      <label>Hours to object<input id="i-hours" value="${v.hours}" inputmode="numeric" /></label>
      <label>Period in days<input id="i-days" value="${v.days}" inputmode="numeric" /></label>
      <label>Cap per period (NEAR)<input id="i-cap" value="${v.cap}" inputmode="decimal" /></label>
      <label>First limit per payment<input id="i-base" value="${v.base}" inputmode="decimal" /></label>
      <label>Added per clean payment<input id="i-step" value="${v.step}" inputmode="decimal" /></label>
      <label>Highest limit<input id="i-max" value="${v.max}" inputmode="decimal" /></label>
    </form>
    <div id="install-out"></div>
  </div>`;
  const render = () => {
    const get = (id) => document.getElementById(id).value.trim();
    let input;
    try {
      input = {
        label: get("i-label"),
        token: null,
        stewards: get("i-steward") ? [get("i-steward")] : [],
        open: false,
        allow_self_pay: false,
        window_secs: Math.round(Number(get("i-hours")) * 3600),
        period_secs: Math.round(Number(get("i-days")) * 86400),
        cap: nearToYocto(get("i-cap")),
        base_limit: nearToYocto(get("i-base")),
        step: nearToYocto(get("i-step")),
        max_limit: nearToYocto(get("i-max")),
        expires_at: null,
      };
    } catch {
      return;
    }
    const roleProposal = {
      proposal: {
        description: "* Title: Install Tacit <br>* Notes: Adds one role holding one permission, so the Tacit contract can cast a yes vote on transfers it has checked.",
        kind: {
          ChangePolicyAddOrUpdateRole: {
            role: {
              name: "tacit",
              kind: { Group: [CONFIG.contract] },
              permissions: ["transfer:VoteApprove"],
              vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
            },
          },
        },
      },
    };
    const budgetProposal = {
      proposal: {
        description: `* Title: Approve the ${input.label} budget <br>* Notes: One vote now, instead of one vote per payment.`,
        kind: {
          FunctionCall: {
            receiver_id: CONFIG.contract,
            actions: [
              {
                method_name: "create_budget",
                args: btoa(JSON.stringify({ input })),
                deposit: nearToYocto("0.25"),
                gas: "50000000000000",
              },
            ],
          },
        },
      },
    };
    const removeProposal = { proposal: { description: "* Title: Remove Tacit", kind: { ChangePolicyRemoveRole: { role: "tacit" } } } };
    const daoId = get("i-dao");
    const cli = (args) =>
      `near contract call-function as-transaction ${daoId} add_proposal json-args '${JSON.stringify(args)}' prepaid-gas '100 Tgas' attached-deposit '<your DAO's bond> NEAR' sign-as <you> network-config ${daoId.endsWith(".near") ? "mainnet" : "testnet"} sign-with-keychain send`;
    const block = (heading, text, args, key) => `<section class="proposal-step">
      <header><h3>${heading}</h3><button class="btn" type="button" data-copy="${key}">Copy command</button></header>
      <p>${text}</p>
      <pre id="${key}">${esc(cli(args))}</pre>
    </section>`;
    const mainnetWarning = daoId.endsWith(".near")
      ? `<p class="error" style="margin-bottom:16px">Tacit runs on testnet today, so these commands will not work on a mainnet DAO until the contract is deployed there.</p>`
      : "";
    document.getElementById("install-out").innerHTML =
      mainnetWarning +
      block("1. Give Tacit one permission", "Adds a role that holds only transfer:VoteApprove, with Tacit as its only member.", roleProposal, "copy-role") +
      `<div style="height:18px"></div>` +
      block("2. Approve the budget", "Creates the budget on Tacit. This attaches 0.25 NEAR from the treasury, which prepays storage for about 20 payments.", budgetProposal, "copy-budget") +
      `<div style="height:18px"></div>` +
      block("To undo it", "One proposal takes all of Tacit's power away, at any time.", removeProposal, "copy-remove");
  };
  document.getElementById("install-form").addEventListener("input", render);
  render();
}

$view.addEventListener("click", async (event) => {
  const key = event.target.closest("[data-copy]")?.dataset.copy;
  if (!key) return;
  const pre = document.getElementById(key);
  try {
    await navigator.clipboard.writeText(pre.textContent);
    toast("Copied. Replace the two placeholders before you run it.");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast("Press Ctrl+C to copy the selected command.");
  }
});

/* ---- Routing ---- */
function route() {
  clearInterval(board.timer);
  clearInterval(board.ticker);
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  if (name === "board") boardView();
  else if (name === "report") reportView(decodeURIComponent(arg || ""));
  else if (name === "install") installView(decodeURIComponent(arg || ""));
  else home();
}

onSession(() => {
  renderWho();
  if (location.hash.startsWith("#board") && document.getElementById("notices")) {
    renderSide();
    renderNotices();
  }
});
window.addEventListener("hashchange", route);
initSession().then(route);
void accountOf;
