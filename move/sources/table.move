// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// Heads-up table escrow: two agents lock equal buy-ins, the coordinator settles to
/// the winner. Heads-up means one winner, so there is no merkle and there are no side
/// pots: the whole pot is paid out directly.
///
/// Custody is constrained on chain, not just by trust:
///   - `join_table` only seats an agent the caller owns and has registered, so no one
///     can enroll someone else's agent or an unconsented one.
///   - `settle` can only pay one of the two seated owners, so a compromised or buggy
///     coordinator cannot redirect a pot to an outside address.
///   - `reclaim` lets either player recover the escrow if the coordinator never
///     settles, so funds can never be locked forever in a stalled match.
module telt::table;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use telt::registry::{Self, Agent, CoordinatorCap};

// --- Error codes ---
const EBadStatus: u64 = 1;
const ESeatTaken: u64 = 2;
const EWrongBuyin: u64 = 3;
const ENoStake: u64 = 4;
const EZeroBuyin: u64 = 5;
const ENotAgentOwner: u64 = 6;
const ENotRegistered: u64 = 7;
const EBadWinner: u64 = 8;
const ETooEarly: u64 = 9;

// --- Status ---
const OPEN: u8 = 0;
const PLAYING: u8 = 1;
const SETTLED: u8 = 2;

/// Epochs a full table may sit unsettled before either player may reclaim the escrow.
/// A safety hatch for a vanished coordinator, not a normal path: a real match settles
/// within minutes, well inside one epoch.
const RECLAIM_TIMEOUT_EPOCHS: u64 = 3;

/// A heads-up table. Shared so both operators can join and the coordinator can settle.
public struct Table has key {
    id: UID,
    seat_a: Option<ID>,
    seat_b: Option<ID>,
    owner_a: Option<address>,
    owner_b: Option<address>,
    buyin: u64,
    pot: Balance<SUI>,
    status: u8,
    hand_count: u64,
    /// Epoch the table filled and play began. Drives the reclaim timeout.
    started_epoch: u64,
    winner: Option<address>,
}

// --- Events ---
public struct TableOpened has copy, drop { table: ID, buyin: u64 }
public struct Joined has copy, drop { table: ID, agent: ID, owner: address }
public struct Settled has copy, drop { table: ID, winner: address, amount: u64 }
public struct Refunded has copy, drop { table: ID, amount: u64 }
public struct Reclaimed has copy, drop { table: ID, amount: u64 }

/// Open an empty heads-up table at a fixed, positive buy-in.
public fun open_table(buyin: u64, ctx: &mut TxContext) {
    assert!(buyin > 0, EZeroBuyin);
    let table = Table {
        id: object::new(ctx),
        seat_a: option::none(),
        seat_b: option::none(),
        owner_a: option::none(),
        owner_b: option::none(),
        buyin,
        pot: balance::zero(),
        status: OPEN,
        hand_count: 0,
        started_epoch: 0,
        winner: option::none(),
    };
    event::emit(TableOpened { table: object::id(&table), buyin });
    transfer::share_object(table);
}

/// Seat an agent and lock its buy-in into the pot. The caller must own the agent and
/// have registered it for arena play. The second join fills the table, stamps the
/// start epoch, and flips it to PLAYING.
public fun join_table(table: &mut Table, agent: &Agent, stake: Coin<SUI>, ctx: &mut TxContext) {
    assert!(table.status == OPEN, EBadStatus);
    assert!(coin::value(&stake) == table.buyin, EWrongBuyin);
    assert!(ctx.sender() == registry::owner(agent), ENotAgentOwner);
    assert!(registry::is_registered(agent), ENotRegistered);

    let agent_id = object::id(agent);
    let owner = registry::owner(agent);
    balance::join(&mut table.pot, coin::into_balance(stake));

    if (option::is_none(&table.seat_a)) {
        table.seat_a = option::some(agent_id);
        table.owner_a = option::some(owner);
    } else {
        assert!(option::is_none(&table.seat_b), ESeatTaken);
        table.seat_b = option::some(agent_id);
        table.owner_b = option::some(owner);
        table.status = PLAYING;
        table.started_epoch = ctx.epoch();
    };
    event::emit(Joined { table: object::id(table), agent: agent_id, owner });
}

/// Pay the whole pot to the winner. Coordinator-gated, and the winner must be one of
/// the two seated owners, so the escrow can never be redirected to an outside address.
public fun settle(
    table: &mut Table,
    _cap: &CoordinatorCap,
    winner_owner: address,
    hands_played: u64,
    ctx: &mut TxContext,
) {
    assert!(table.status == PLAYING, EBadStatus);
    let a = *option::borrow(&table.owner_a);
    let b = *option::borrow(&table.owner_b);
    assert!(winner_owner == a || winner_owner == b, EBadWinner);

    let amount = balance::value(&table.pot);
    let payout = coin::from_balance(balance::withdraw_all(&mut table.pot), ctx);
    transfer::public_transfer(payout, winner_owner);
    table.status = SETTLED;
    table.hand_count = hands_played;
    table.winner = option::some(winner_owner);
    event::emit(Settled { table: object::id(table), winner: winner_owner, amount });
}

/// Refund the lone stake if a table never fills. Coordinator-gated.
public fun refund(table: &mut Table, _cap: &CoordinatorCap, ctx: &mut TxContext) {
    assert!(table.status == OPEN, EBadStatus);
    assert!(option::is_some(&table.owner_a), ENoStake);
    let amount = balance::value(&table.pot);
    let refund = coin::from_balance(balance::withdraw_all(&mut table.pot), ctx);
    transfer::public_transfer(refund, *option::borrow(&table.owner_a));
    table.status = SETTLED;
    event::emit(Refunded { table: object::id(table), amount });
}

/// Recover the escrow if the coordinator never settles. Permissionless after the
/// timeout, but funds only ever go back to the two seated owners (each their buy-in),
/// so it cannot be used to grief or to redirect funds.
public fun reclaim(table: &mut Table, ctx: &mut TxContext) {
    assert!(table.status == PLAYING, EBadStatus);
    assert!(ctx.epoch() >= table.started_epoch + RECLAIM_TIMEOUT_EPOCHS, ETooEarly);
    let a = *option::borrow(&table.owner_a);
    let b = *option::borrow(&table.owner_b);
    let total = balance::value(&table.pot);

    // Return each owner their buy-in. pot == 2 * buyin in PLAYING, so the split is exact.
    let coin_a = coin::from_balance(balance::split(&mut table.pot, table.buyin), ctx);
    transfer::public_transfer(coin_a, a);
    let coin_b = coin::from_balance(balance::withdraw_all(&mut table.pot), ctx);
    transfer::public_transfer(coin_b, b);

    table.status = SETTLED;
    event::emit(Reclaimed { table: object::id(table), amount: total });
}

// --- Read-only accessors ---
public fun status(t: &Table): u8 { t.status }
public fun buyin(t: &Table): u64 { t.buyin }
public fun pot_value(t: &Table): u64 { balance::value(&t.pot) }
public fun started_epoch(t: &Table): u64 { t.started_epoch }
