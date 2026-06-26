/// A mintable test dollar for the Telt tier economy. Tier upgrades are paid in this,
/// not SUI, so the upgrade currency is a stable-looking unit instead of gas. It has no
/// real value: the publisher (the coordinator) holds the mint authority and mints freely
/// to fund the demo. Six decimals, like USDC.
module telt::test_usdc;

use sui::coin::{Self, Coin, TreasuryCap};

/// One-time witness for the currency.
public struct TEST_USDC has drop {}

/// Create the currency at publish and hand mint authority to the publisher.
fun init(witness: TEST_USDC, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6,
        b"TUSDC",
        b"Telt Test USDC",
        b"Test USDC for Telt tier upgrades. No real value.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury_cap, ctx.sender());
}

/// Mint and RETURN a coin, for use inside a larger transaction (e.g. minting the exact
/// upgrade cost and paying it in the same call). Cap holder only.
public fun mint_coin(cap: &mut TreasuryCap<TEST_USDC>, amount: u64, ctx: &mut TxContext): Coin<TEST_USDC> {
    coin::mint(cap, amount, ctx)
}

/// Faucet: mint test dollars straight to a recipient. Cap holder only.
public fun mint(cap: &mut TreasuryCap<TEST_USDC>, amount: u64, recipient: address, ctx: &mut TxContext) {
    transfer::public_transfer(coin::mint(cap, amount, ctx), recipient);
}
