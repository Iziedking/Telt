// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// The agent registry for the Telt arena.
///
/// An `Agent` is the on-chain identity an operator plays under: its owner, its level
/// (the one skill dial, bought here), its win/loss record, a `registered` consent
/// flag, and a link to the Avow mandate that authorizes its move anchors. Agents are
/// shared so the arena coordinator can stamp results against them after a table
/// settles, while only the owner can level up or register for an arena.
///
/// The single consent rule of Telt is enforced at `register_for_arena`: entering a
/// table makes your moves and reasoning purchasable intel for that arena, symmetric
/// for every entrant. Registration sets `registered = true`, and both `table::join`
/// and `intel::buy_intel` require it, so an unregistered agent can neither be seated
/// nor have intel sold on it. The on-chain marker pairs with the off-chain read-grant:
/// the operator calls `avow::record::add_auditor(access, cap, ARENA_COORDINATOR_ADDR)`
/// once through the SDK so the coordinator can compile intel from real Avow records.
module telt::registry;

use std::string::{Self, String};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

// --- Error codes ---
const ENotOwner: u64 = 1;
const EInsufficientPayment: u64 = 2;
const EMaxLevel: u64 = 3;

/// Five levels, 0 to 4. Level 0 is the untrained floor; level 4 is the strongest.
const MAX_LEVEL: u8 = 4;

/// The platform treasury. Tier-upgrade SUI accumulates in its `balance`; the coordinator
/// claims it with the CoordinatorCap. `addr` is the publisher (the claim recipient).
/// Shared and created once at publish, with no public constructor, so exactly one
/// Treasury ever exists and it cannot be spoofed.
public struct Treasury has key {
    id: UID,
    addr: address,
    balance: Balance<SUI>,
}

/// The coordinator's authority. Gates result recording here and settlement in the
/// table module. Minted to the publisher at init.
public struct CoordinatorCap has key, store {
    id: UID,
}

/// An operator's agent. Shared, so the coordinator can record results against it.
public struct Agent has key {
    id: UID,
    owner: address,
    name: String,
    /// The reasoning-compute level, 0..=MAX_LEVEL. Higher buys more passes per move.
    level: u8,
    wins: u64,
    losses: u64,
    /// True once the owner has registered the agent for arena play. This is the
    /// on-chain consent marker that gates seating and intel sales.
    registered: bool,
    /// Links to the agent's Avow mandate, so its move anchors verify against it.
    mandate_id: ID,
    created_epoch: u64,
}

// --- Events ---
public struct AgentClaimed has copy, drop { agent: ID, owner: address, mandate_id: ID }
public struct LevelUp has copy, drop { agent: ID, owner: address, level: u8 }
public struct ArenaRegistered has copy, drop { agent: ID, owner: address, mandate_id: ID }
public struct ResultRecorded has copy, drop { agent: ID, won: bool, wins: u64, losses: u64 }

fun init(ctx: &mut TxContext) {
    transfer::share_object(Treasury { id: object::new(ctx), addr: ctx.sender(), balance: balance::zero() });
    transfer::public_transfer(CoordinatorCap { id: object::new(ctx) }, ctx.sender());
}

/// SUI (in MIST, 9 decimals) to go from `level` to `level + 1`. Mirrors the backend
/// ladder in reason/levels.ts: an easy on-ramp, then a real climb to the Oracle.
fun upgrade_cost(level: u8): u64 {
    if (level == 0) 1_000_000_000 // 1 SUI
    else if (level == 1) 2_500_000_000 // 2.5 SUI
    else if (level == 2) 6_000_000_000 // 6 SUI
    else if (level == 3) 15_000_000_000 // 15 SUI
    else 0
}

/// Mint a shared `Agent` for the caller at level 0, linked to its Avow mandate.
public fun claim_agent(name: vector<u8>, mandate_id: ID, ctx: &mut TxContext) {
    let agent = Agent {
        id: object::new(ctx),
        owner: ctx.sender(),
        name: string::utf8(name),
        level: 0,
        wins: 0,
        losses: 0,
        registered: false,
        mandate_id,
        created_epoch: ctx.epoch(),
    };
    event::emit(AgentClaimed { agent: object::id(&agent), owner: ctx.sender(), mandate_id });
    transfer::share_object(agent);
}

/// Pay to bump the agent's level by one. Takes exactly the cost to the treasury and
/// returns any change to the owner. Owner-only, capped at MAX_LEVEL.
public fun upgrade(
    agent: &mut Agent,
    mut payment: Coin<SUI>,
    treasury: &mut Treasury,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == agent.owner, ENotOwner);
    assert!(agent.level < MAX_LEVEL, EMaxLevel);
    let cost = upgrade_cost(agent.level);
    assert!(coin::value(&payment) >= cost, EInsufficientPayment);

    // The fee accumulates in the treasury balance for the coordinator to claim later.
    let due = coin::split(&mut payment, cost, ctx);
    balance::join(&mut treasury.balance, coin::into_balance(due));
    // Return the remainder to the owner. A zero-value coin is a valid object.
    transfer::public_transfer(payment, agent.owner);

    agent.level = agent.level + 1;
    event::emit(LevelUp { agent: object::id(agent), owner: agent.owner, level: agent.level });
}

/// Sweep the accumulated upgrade fees to the treasury address. CoordinatorCap-gated, so
/// only the platform can claim. Returns nothing; the SUI lands at `treasury.addr`.
public fun claim_treasury(_cap: &CoordinatorCap, treasury: &mut Treasury, ctx: &mut TxContext) {
    let swept = balance::withdraw_all(&mut treasury.balance);
    transfer::public_transfer(coin::from_balance(swept, ctx), treasury.addr);
}

/// The SUI currently held in the treasury, awaiting claim.
public fun treasury_balance(t: &Treasury): u64 { balance::value(&t.balance) }

/// Consent to arena play. Sets the on-chain `registered` flag and emits the marker.
/// Entering an arena makes this agent's moves and reasoning purchasable intel,
/// symmetric for every entrant. Owner-only; idempotent.
public fun register_for_arena(agent: &mut Agent, ctx: &TxContext) {
    assert!(ctx.sender() == agent.owner, ENotOwner);
    agent.registered = true;
    event::emit(ArenaRegistered {
        agent: object::id(agent),
        owner: agent.owner,
        mandate_id: agent.mandate_id,
    });
}

/// Stamp a hand or match result against an agent. Coordinator-gated.
public fun record_result(_cap: &CoordinatorCap, agent: &mut Agent, won: bool) {
    if (won) {
        agent.wins = agent.wins + 1;
    } else {
        agent.losses = agent.losses + 1;
    };
    event::emit(ResultRecorded {
        agent: object::id(agent),
        won,
        wins: agent.wins,
        losses: agent.losses,
    });
}

// --- Read-only accessors ---
public fun owner(a: &Agent): address { a.owner }
public fun level(a: &Agent): u8 { a.level }
public fun is_registered(a: &Agent): bool { a.registered }
public fun mandate_id(a: &Agent): ID { a.mandate_id }
public fun name(a: &Agent): String { a.name }
public fun wins(a: &Agent): u64 { a.wins }
public fun losses(a: &Agent): u64 { a.losses }
public fun treasury_addr(t: &Treasury): address { t.addr }
