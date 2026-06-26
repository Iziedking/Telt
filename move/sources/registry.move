// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// The agent registry for the Telt arena.
///
/// An `Agent` is the on-chain identity an operator plays under: its owner, its level
/// (the one skill dial, bought here), its win/loss record, and a link to the Avow
/// mandate that authorizes its move anchors. Agents are shared so the arena
/// coordinator can stamp results against them after a table settles, while only the
/// owner can level up or register for an arena.
///
/// The single consent rule of Telt is documented at `register_for_arena`: entering a
/// table makes your moves and reasoning purchasable intel for that arena. The marker
/// is emitted here; the actual read-grant is the operator calling
/// `avow::record::add_auditor(access, cap, ARENA_COORDINATOR_ADDR)` once, off chain
/// through the SDK, so the coordinator can compile intel from real Avow records.
module telt::registry;

use std::string::{Self, String};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

// --- Error codes ---
const ENotOwner: u64 = 1;
const EInsufficientPayment: u64 = 2;
const EMaxLevel: u64 = 3;

/// The demo caps at level 3. Gains flatten past this; we do not claim unbounded
/// scaling.
const MAX_LEVEL: u8 = 3;

/// Holds the address arena fees flow to (upgrades and intel). Shared and set once at
/// publish to the publisher, who is the coordinator on the testnet demo.
public struct Treasury has key {
    id: UID,
    addr: address,
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
    /// Links to the agent's Avow mandate, so its move anchors verify against it.
    mandate_id: ID,
    created_epoch: u64,
}

// --- Events ---
public struct AgentClaimed has copy, drop { agent: ID, owner: address, mandate_id: ID }
public struct LevelUp has copy, drop { agent: ID, owner: address, level: u8 }
public struct ArenaRegistered has copy, drop { agent: ID, owner: address }
public struct ResultRecorded has copy, drop { agent: ID, won: bool, wins: u64, losses: u64 }

fun init(ctx: &mut TxContext) {
    transfer::share_object(Treasury { id: object::new(ctx), addr: ctx.sender() });
    transfer::public_transfer(CoordinatorCap { id: object::new(ctx) }, ctx.sender());
}

/// SUI (in MIST, 9 decimals) to go from `level` to `level + 1`. Mirrors the backend
/// ladder in reason/levels.ts: an easy on-ramp, then a real climb.
fun upgrade_cost(level: u8): u64 {
    if (level == 0) 100_000_000 // 0.1 SUI
    else if (level == 1) 300_000_000 // 0.3 SUI
    else if (level == 2) 800_000_000 // 0.8 SUI
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
    treasury: &Treasury,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == agent.owner, ENotOwner);
    assert!(agent.level < MAX_LEVEL, EMaxLevel);
    let cost = upgrade_cost(agent.level);
    assert!(coin::value(&payment) >= cost, EInsufficientPayment);

    let due = coin::split(&mut payment, cost, ctx);
    transfer::public_transfer(due, treasury.addr);
    // Return the remainder to the owner. A zero-value coin is a valid object.
    transfer::public_transfer(payment, agent.owner);

    agent.level = agent.level + 1;
    event::emit(LevelUp { agent: object::id(agent), owner: agent.owner, level: agent.level });
}

/// Emit the consent marker. Entering an arena makes this agent's moves and reasoning
/// purchasable intel, symmetric for every entrant. Owner-only.
public fun register_for_arena(agent: &Agent, ctx: &TxContext) {
    assert!(ctx.sender() == agent.owner, ENotOwner);
    event::emit(ArenaRegistered { agent: object::id(agent), owner: agent.owner });
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
public fun mandate_id(a: &Agent): ID { a.mandate_id }
public fun name(a: &Agent): String { a.name }
public fun wins(a: &Agent): u64 { a.wins }
public fun losses(a: &Agent): u64 { a.losses }
public fun treasury_addr(t: &Treasury): address { t.addr }
