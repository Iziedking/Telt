// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// The intel fee escrow and the entitlement object it mints.
///
/// This is the win condition of Telt made on-chain: an agent pays for a dossier on an
/// opponent, and the payment itself becomes a provable, anchored action. `buy_intel`
/// routes the fee to the platform treasury and mints an `IntelReceipt` to the buyer as
/// proof of purchase.
///
/// The target is passed as the real `&Agent`, not a caller-supplied id, so the
/// purchase is bound on chain to a genuine, registered (consented) agent and to its
/// true owner and Avow mandate. That binding closes the consent gap: a buyer cannot
/// name an arbitrary mandate to pull a dossier the target never consented to. The
/// coordinator watches `IntelPurchased`, compiles the dossier from the target's real
/// Avow records (it is an auditor on the target via the off-chain `add_auditor` grant),
/// re-seals it to the buyer, and anchors that delivery through Avow. Because Avow's
/// Seal policy already grants per-user decryption, reselling needs no new Seal Move
/// code, so none lives here.
module telt::intel;

use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use telt::registry::{Self, Agent, Treasury};

// --- Error codes ---
const ETargetNotRegistered: u64 = 1;

/// Proof of purchase, returned to the buyer. Carries the target's true owner and
/// mandate, read from the agent on chain.
public struct IntelReceipt has key, store {
    id: UID,
    buyer: address,
    table_id: ID,
    target_agent: ID,
    target_owner: address,
    target_mandate: ID,
    amount: u64,
    epoch: u64,
}

public struct IntelPurchased has copy, drop {
    receipt: ID,
    buyer: address,
    table_id: ID,
    target_agent: ID,
    target_owner: address,
    target_mandate: ID,
    amount: u64,
    epoch: u64,
}

/// Pay the intel fee to the treasury and mint a receipt to the buyer. Permissionless,
/// but the target must be a registered (consented) agent, and its owner and mandate are
/// read from chain rather than trusted from the caller. The fee amount is whatever the
/// buyer sends; the off-chain facilitator quotes the price and verifies the amount
/// before delivering the dossier.
public fun buy_intel(
    table_id: ID,
    target: &Agent,
    fee: Coin<SUI>,
    treasury: &Treasury,
    ctx: &mut TxContext,
) {
    assert!(registry::is_registered(target), ETargetNotRegistered);

    let amount = coin::value(&fee);
    transfer::public_transfer(fee, registry::treasury_addr(treasury));

    let target_agent = object::id(target);
    let target_owner = registry::owner(target);
    let target_mandate = registry::mandate_id(target);

    let receipt = IntelReceipt {
        id: object::new(ctx),
        buyer: ctx.sender(),
        table_id,
        target_agent,
        target_owner,
        target_mandate,
        amount,
        epoch: ctx.epoch(),
    };
    event::emit(IntelPurchased {
        receipt: object::id(&receipt),
        buyer: ctx.sender(),
        table_id,
        target_agent,
        target_owner,
        target_mandate,
        amount,
        epoch: ctx.epoch(),
    });
    transfer::public_transfer(receipt, ctx.sender());
}

// --- Read-only accessors ---
public fun buyer(r: &IntelReceipt): address { r.buyer }
public fun target_agent(r: &IntelReceipt): ID { r.target_agent }
public fun target_mandate(r: &IntelReceipt): ID { r.target_mandate }
public fun amount(r: &IntelReceipt): u64 { r.amount }
