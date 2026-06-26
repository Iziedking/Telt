import { Hand, freshDeck, shuffled } from "./engine.js";
import type { Card, Seat } from "./types.js";

// Scripted unit tests for the heads-up engine. No model, no randomness in the
// assertions: every deck is preset so the outcome is known. Run: npm run engine:test

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// A deck that gives seat A (button) a nut spade flush and seat B junk.
// Layout: [A c1, B c1, A c2, B c2, flop x3, turn, river]
const FLUSH_DECK: Card[] = ["As", "2h", "Ks", "3d", "Qs", "Js", "4s", "8c", "9d"];

// A deck where both players can only play the board (5-9 straight) -> split.
const SPLIT_DECK: Card[] = ["2c", "3c", "2d", "3h", "5h", "6h", "7s", "8d", "9c"];

function totalChips(h: Hand): number {
  return h.players.A.stack + h.players.B.stack + h.players.A.committedStreet + h.players.B.committedStreet + h.pot;
}

// --- Test 1: pre-flop fold, big blind wins the blinds. ---
function testFold(): void {
  console.log("preflop fold");
  const h = new Hand({ button: "A", stacks: { A: 1000, B: 1000 }, smallBlind: 10, bigBlind: 20, deck: FLUSH_DECK });
  eq("button acts first preflop", h.toAct, "A");
  h.apply({ type: "fold" });
  check("hand complete", h.isComplete());
  eq("winner is B", h.result?.winner, "B");
  eq("reason fold", h.result?.reason, "fold");
  eq("pot was 30", h.result?.pot, 30);
  eq("A stack 990", h.players.A.stack, 990);
  eq("B stack 1010", h.players.B.stack, 1010);
  eq("chips conserved", h.players.A.stack + h.players.B.stack, 2000);
}

// --- Test 2: check-down to showdown, flush wins. ---
function testCheckDown(): void {
  console.log("check-down showdown");
  const h = new Hand({ button: "A", stacks: { A: 1000, B: 1000 }, smallBlind: 10, bigBlind: 20, deck: FLUSH_DECK });
  h.apply({ type: "call" }); // A (SB) completes to 20
  eq("BB has option", h.toAct, "B");
  h.apply({ type: "check" }); // B checks -> flop
  eq("street flop", h.street, "flop");
  eq("non-button acts first postflop", h.toAct, "B");
  h.apply({ type: "check" });
  h.apply({ type: "check" }); // -> turn
  eq("street turn", h.street, "turn");
  h.apply({ type: "check" });
  h.apply({ type: "check" }); // -> river
  eq("street river", h.street, "river");
  h.apply({ type: "check" });
  h.apply({ type: "check" }); // -> showdown
  check("complete", h.isComplete());
  eq("winner A (flush)", h.result?.winner, "A");
  eq("reason showdown", h.result?.reason, "showdown");
  eq("pot 40", h.result?.pot, 40);
  eq("A stack 1020", h.players.A.stack, 1020);
  eq("B stack 980", h.players.B.stack, 980);
  check("A made a flush", (h.result?.descr?.A ?? "").toLowerCase().includes("flush"), h.result?.descr?.A);
}

// --- Test 3: all-in pre-flop, board runs out, flush wins. ---
function testAllIn(): void {
  console.log("all-in preflop run-out");
  const h = new Hand({ button: "A", stacks: { A: 200, B: 200 }, smallBlind: 10, bigBlind: 20, deck: FLUSH_DECK });
  h.apply({ type: "raise", size: 200 }); // A shoves all-in
  check("A all-in", h.players.A.allIn);
  eq("B to act", h.toAct, "B");
  h.apply({ type: "call" }); // B calls all-in
  check("complete", h.isComplete());
  eq("board fully dealt", h.board.length, 5);
  eq("winner A", h.result?.winner, "A");
  eq("pot 400", h.result?.pot, 400);
  eq("A stack 400", h.players.A.stack, 400);
  eq("B stack 0", h.players.B.stack, 0);
}

// --- Test 4: split pot (both play the board). ---
function testSplit(): void {
  console.log("split pot");
  const h = new Hand({ button: "A", stacks: { A: 1000, B: 1000 }, smallBlind: 10, bigBlind: 20, deck: SPLIT_DECK });
  h.apply({ type: "call" });
  h.apply({ type: "check" });
  for (let i = 0; i < 6; i++) h.apply({ type: "check" }); // flop, turn, river check-downs
  check("complete", h.isComplete());
  eq("split", h.result?.winner, "split");
  eq("A back to 1000", h.players.A.stack, 1000);
  eq("B back to 1000", h.players.B.stack, 1000);
}

// --- Test 5: raise / re-raise accounting and chip conservation. ---
function testRaiseReraise(): void {
  console.log("raise / re-raise");
  const h = new Hand({ button: "A", stacks: { A: 1000, B: 1000 }, smallBlind: 10, bigBlind: 20, deck: FLUSH_DECK });
  h.apply({ type: "raise", size: 60 }); // A raises to 60
  eq("currentBet 60", h.currentBet, 60);
  eq("B to act", h.toAct, "B");
  h.apply({ type: "raise", size: 180 }); // B re-raises to 180
  eq("currentBet 180", h.currentBet, 180);
  eq("A to act", h.toAct, "A");
  h.apply({ type: "call" }); // A calls -> flop
  eq("street flop", h.street, "flop");
  eq("pot 360", h.pot, 360);
  eq("A committed 180 total", h.players.A.committedHand, 180);
  eq("B committed 180 total", h.players.B.committedHand, 180);
  // Check down to a known winner (A flush).
  for (let i = 0; i < 6; i++) h.apply({ type: "check" });
  check("complete", h.isComplete());
  eq("winner A", h.result?.winner, "A");
  eq("pot 360", h.result?.pot, 360);
  eq("chips conserved", h.players.A.stack + h.players.B.stack, 2000);
}

// --- Test 6: legal actions surface is correct facing a bet. ---
function testLegal(): void {
  console.log("legal actions");
  const h = new Hand({ button: "A", stacks: { A: 1000, B: 1000 }, smallBlind: 10, bigBlind: 20, deck: FLUSH_DECK });
  const la = h.legalActions("A"); // A is SB, committed 10, facing 20
  eq("call amount 10", la.callAmount, 10);
  check("cannot check facing bet", !la.canCheck);
  check("can raise", la.canRaise);
  eq("min raise to 40", la.minRaiseTo, 40);
  eq("max raise to 1000 (all-in)", la.maxRaiseTo, 1000);
}

// --- Test 7: a freshly shuffled deck has 52 unique cards. ---
function testDeck(): void {
  console.log("deck integrity");
  const d = freshDeck();
  eq("52 cards", d.length, 52);
  eq("52 unique", new Set(d).size, 52);
  const s = shuffled(42);
  eq("shuffle keeps 52 unique", new Set(s).size, 52);
  // Deterministic for a given seed.
  eq("seed is deterministic", shuffled(42).join(","), s.join(","));
}

testFold();
testCheckDown();
testAllIn();
testSplit();
testRaiseReraise();
testLegal();
testDeck();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
