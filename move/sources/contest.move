/// Contests and challenge duels, paid in tUSDC. An operator opens a contest and picks the
/// rules: a 1v1 duel or a multi-entry contest, gated to a level band. Real entrants pay an
/// entry into the prize pool; anyone can also fund the pool. House (platform) agents can be
/// seated for free to keep a contest busy, but they never win and are skipped at payout.
/// The coordinator names the winner and the whole pool pays out in tUSDC.
module telt::contest;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use telt::registry::{Self, Agent, CoordinatorCap};
use telt::test_usdc::TEST_USDC;

// --- Error codes ---
const ENotOpen: u64 = 1;
const EBadLevel: u64 = 2;
const EFull: u64 = 3;
const ENotRegistered: u64 = 4;
const EUnderpaid: u64 = 5;
const ENotOwner: u64 = 6;
const EWinnerNotEntrant: u64 = 7;
const EWinnerIsHouse: u64 = 8;
const EAlreadyJoined: u64 = 9;

/// Format: a 1v1 duel or an open multi-entry contest.
const FORMAT_DUEL: u8 = 0;
const FORMAT_MULTI: u8 = 1;

/// Status.
const STATUS_OPEN: u8 = 0;
const STATUS_SETTLED: u8 = 1;

public struct Entrant has store {
    agent: ID,
    owner: address,
    /// House fillers keep a contest populated but never win or take a payout.
    is_house: bool,
}

public struct Contest has key {
    id: UID,
    operator: address,
    /// Game type. 0 = poker, the only game today.
    game: u8,
    format: u8,
    level_min: u8,
    level_max: u8,
    entry_fee: u64,
    max_entries: u64,
    pool: Balance<TEST_USDC>,
    entrants: vector<Entrant>,
    status: u8,
}

// --- Events ---
public struct ContestCreated has copy, drop {
    contest: ID,
    operator: address,
    format: u8,
    entry_fee: u64,
    max_entries: u64,
}
public struct ContestJoined has copy, drop { contest: ID, agent: ID, owner: address, is_house: bool }
public struct ContestFunded has copy, drop { contest: ID, by: address, amount: u64, pool: u64 }
public struct ContestSettled has copy, drop { contest: ID, winner: ID, owner: address, prize: u64 }

/// Open a contest. The operator chooses the format: a duel forces two entries, a multi
/// contest uses `max_entries`. Gated to the level band [level_min, level_max].
public fun create(
    game: u8,
    format: u8,
    level_min: u8,
    level_max: u8,
    entry_fee: u64,
    max_entries: u64,
    ctx: &mut TxContext,
) {
    let cap = if (format == FORMAT_DUEL) 2 else max_entries;
    let contest = Contest {
        id: object::new(ctx),
        operator: ctx.sender(),
        game,
        format,
        level_min,
        level_max,
        entry_fee,
        max_entries: cap,
        pool: balance::zero(),
        entrants: vector::empty(),
        status: STATUS_OPEN,
    };
    event::emit(ContestCreated {
        contest: object::id(&contest),
        operator: ctx.sender(),
        format,
        entry_fee,
        max_entries: cap,
    });
    transfer::share_object(contest);
}

/// Anyone can top up the prize pool, no entry required.
public fun fund(contest: &mut Contest, payment: Coin<TEST_USDC>, ctx: &TxContext) {
    let amount = coin::value(&payment);
    balance::join(&mut contest.pool, coin::into_balance(payment));
    event::emit(ContestFunded {
        contest: object::id(contest),
        by: ctx.sender(),
        amount,
        pool: balance::value(&contest.pool),
    });
}

/// Enter as a real competitor: pay the entry into the pool, eligible to win. Owner-only,
/// must be registered for the arena, and within the contest's level band.
public fun join(contest: &mut Contest, agent: &Agent, mut payment: Coin<TEST_USDC>, ctx: &mut TxContext) {
    assert!(contest.status == STATUS_OPEN, ENotOpen);
    assert!(ctx.sender() == registry::owner(agent), ENotOwner);
    assert!(registry::is_registered(agent), ENotRegistered);
    let lvl = registry::level(agent);
    assert!(lvl >= contest.level_min && lvl <= contest.level_max, EBadLevel);
    assert!(vector::length(&contest.entrants) < contest.max_entries, EFull);
    let aid = object::id(agent);
    assert!(!has_entrant(contest, aid), EAlreadyJoined);
    assert!(coin::value(&payment) >= contest.entry_fee, EUnderpaid);

    let due = coin::split(&mut payment, contest.entry_fee, ctx);
    balance::join(&mut contest.pool, coin::into_balance(due));
    // Return any change to the entrant.
    transfer::public_transfer(payment, ctx.sender());

    let owner = registry::owner(agent);
    vector::push_back(&mut contest.entrants, Entrant { agent: aid, owner, is_house: false });
    event::emit(ContestJoined { contest: object::id(contest), agent: aid, owner, is_house: false });
}

/// Seat a house (filler) agent for free. CoordinatorCap-gated; never wins, skipped at
/// payout. Keeps a contest populated as the autopilot cycles events.
public fun join_as_house(_cap: &CoordinatorCap, contest: &mut Contest, agent: &Agent) {
    assert!(contest.status == STATUS_OPEN, ENotOpen);
    assert!(vector::length(&contest.entrants) < contest.max_entries, EFull);
    let aid = object::id(agent);
    assert!(!has_entrant(contest, aid), EAlreadyJoined);
    let owner = registry::owner(agent);
    vector::push_back(&mut contest.entrants, Entrant { agent: aid, owner, is_house: true });
    event::emit(ContestJoined { contest: object::id(contest), agent: aid, owner, is_house: true });
}

/// Settle: the coordinator names the winning agent and the whole pool pays out to its
/// owner. Winner-take-all for now; the winner must be a non-house entrant.
public fun settle(_cap: &CoordinatorCap, contest: &mut Contest, winner: ID, ctx: &mut TxContext) {
    assert!(contest.status == STATUS_OPEN, ENotOpen);
    let (found, owner, is_house) = find_entrant(contest, winner);
    assert!(found, EWinnerNotEntrant);
    assert!(!is_house, EWinnerIsHouse);

    let prize = balance::value(&contest.pool);
    let payout = coin::from_balance(balance::withdraw_all(&mut contest.pool), ctx);
    transfer::public_transfer(payout, owner);
    contest.status = STATUS_SETTLED;
    event::emit(ContestSettled { contest: object::id(contest), winner, owner, prize });
}

// --- helpers ---
fun has_entrant(contest: &Contest, aid: ID): bool {
    let mut i = 0;
    let n = vector::length(&contest.entrants);
    while (i < n) {
        if (vector::borrow(&contest.entrants, i).agent == aid) return true;
        i = i + 1;
    };
    false
}

fun find_entrant(contest: &Contest, aid: ID): (bool, address, bool) {
    let mut i = 0;
    let n = vector::length(&contest.entrants);
    while (i < n) {
        let e = vector::borrow(&contest.entrants, i);
        if (e.agent == aid) return (true, e.owner, e.is_house);
        i = i + 1;
    };
    (false, @0x0, false)
}

// --- views ---
public fun pool_value(c: &Contest): u64 { balance::value(&c.pool) }
public fun entry_count(c: &Contest): u64 { vector::length(&c.entrants) }
public fun contest_status(c: &Contest): u8 { c.status }
