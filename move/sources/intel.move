// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// The intel fee escrow and the entitlement object it mints.
///
/// This is the win condition of Telt made on-chain: an agent pays for a dossier on an
/// opponent, and the payment itself becomes a provable, anchored action. `buy_intel`
/// routes the fee to the platform treasury and mints an `IntelReceipt` to the buyer as
/// proof of purchase. The coordinator watches `IntelPurchased`, compiles the dossier
/// from the target's real Avow records, re-seals it to the buyer, and anchors that
/// delivery through Avow. Because Avow's Seal policy already grants per-user decryption,
/// reselling needs no new Seal Move code, so none lives here.
module telt::intel;

use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use telt::registry::{Self, Treasury};

/// Proof of purchase, returned to the buyer.
public struct IntelReceipt has key, store {
    id: UID,
    buyer: address,
    table_id: ID,
    target_agent: ID,
    amount: u64,
    epoch: u64,
}

public struct IntelPurchased has copy, drop {
    receipt: ID,
    buyer: address,
    table_id: ID,
    target_agent: ID,
    amount: u64,
    epoch: u64,
}

/// Pay the intel fee to the treasury and mint a receipt to the buyer. Permissionless:
/// anyone may buy intel on any agent at any table. The fee is whatever the buyer sends;
/// the off-chain facilitator quotes the price and verifies the amount before delivering.
public fun buy_intel(
    table_id: ID,
    target_agent: ID,
    fee: Coin<SUI>,
    treasury: &Treasury,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&fee);
    transfer::public_transfer(fee, registry::treasury_addr(treasury));

    let receipt = IntelReceipt {
        id: object::new(ctx),
        buyer: ctx.sender(),
        table_id,
        target_agent,
        amount,
        epoch: ctx.epoch(),
    };
    event::emit(IntelPurchased {
        receipt: object::id(&receipt),
        buyer: ctx.sender(),
        table_id,
        target_agent,
        amount,
        epoch: ctx.epoch(),
    });
    transfer::public_transfer(receipt, ctx.sender());
}

// --- Read-only accessors ---
public fun buyer(r: &IntelReceipt): address { r.buyer }
public fun target_agent(r: &IntelReceipt): ID { r.target_agent }
public fun amount(r: &IntelReceipt): u64 { r.amount }
