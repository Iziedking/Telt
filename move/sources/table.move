// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// Heads-up table escrow: two agents lock equal buy-ins, the coordinator settles to
/// the winner. Heads-up means one winner, so there is no merkle and there are no side
/// pots: the whole pot is paid out directly. Settlement is authorized by the
/// `CoordinatorCap`, so only the arena operator can move escrowed funds, and only to
/// a stated winner.
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

// --- Status ---
const OPEN: u8 = 0;
const PLAYING: u8 = 1;
const SETTLED: u8 = 2;

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
    winner: Option<address>,
}

// --- Events ---
public struct TableOpened has copy, drop { table: ID, buyin: u64 }
public struct Joined has copy, drop { table: ID, agent: ID, owner: address }
public struct Settled has copy, drop { table: ID, winner: address, amount: u64 }
public struct Refunded has copy, drop { table: ID, amount: u64 }

/// Open an empty heads-up table at a fixed buy-in.
public fun open_table(buyin: u64, ctx: &mut TxContext) {
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
        winner: option::none(),
    };
    event::emit(TableOpened { table: object::id(&table), buyin });
    transfer::share_object(table);
}

/// Seat an agent and lock its buy-in into the pot. The second join fills the table and
/// flips it to PLAYING.
public fun join_table(table: &mut Table, agent: &Agent, stake: Coin<SUI>, _ctx: &mut TxContext) {
    assert!(table.status == OPEN, EBadStatus);
    assert!(coin::value(&stake) == table.buyin, EWrongBuyin);

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
    };
    event::emit(Joined { table: object::id(table), agent: agent_id, owner });
}

/// Pay the whole pot to the winner. Coordinator-gated, callable once a table is full.
public fun settle(
    table: &mut Table,
    _cap: &CoordinatorCap,
    winner_owner: address,
    hands_played: u64,
    ctx: &mut TxContext,
) {
    assert!(table.status == PLAYING, EBadStatus);
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

// --- Read-only accessors ---
public fun status(t: &Table): u8 { t.status }
public fun buyin(t: &Table): u64 { t.buyin }
public fun pot_value(t: &Table): u64 { balance::value(&t.pot) }
