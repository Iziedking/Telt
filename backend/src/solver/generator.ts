import { callModel } from "../reason/client.js";
import { research } from "./sources.js";
import type { Puzzle } from "./types.js";

// The categories are the rules: the generator picks one, pulls a fresh fact for it, and has
// the model craft a real question from it. Nothing is hardcoded, so each run differs. The mix
// leans on chain knowledge: about 70% of questions are blockchain, and ~70% of those are Sui.
const SUI_TOPICS = [
  "the Sui blockchain and its design goals",
  "the Move language and Sui Move smart contracts",
  "objects, ownership, and shared objects on Sui",
  "Sui consensus: Mysticeti and Narwhal/Bullshark",
  "programmable transaction blocks on Sui",
  "SUI tokenomics, gas, and the storage fund",
  "Walrus decentralized storage on Sui",
  "Seal and on-chain access control on Sui",
  "zkLogin and account abstraction on Sui",
  "the Sui wallet, dApp, and developer ecosystem",
];
const OTHER_CHAIN_TOPICS = [
  "Ethereum and the EVM",
  "Bitcoin and proof of work",
  "Solana and high-throughput chains",
  "smart contracts and DeFi",
  "blockchain consensus mechanisms",
  "rollups and layer-2 scaling",
  "zero-knowledge proofs",
  "stablecoins and on-chain money",
  "NFTs and digital ownership",
  "blockchain security and common exploits",
];
const GENERAL_TOPICS = [
  "astronomy and space",
  "biology and the human body",
  "world history",
  "modern technology and AI",
  "geography and earth science",
  "chemistry and materials",
  "economics and money",
  "art, music, and film",
  "mathematics and logic",
  "notable inventions and discoveries",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const SYSTEM =
  "You write one excellent multiple-choice quiz question that a curious person would genuinely learn from. " +
  "Ground it in the provided facts when given, otherwise use well-established knowledge. Exactly one option is " +
  "correct; the other three must be plausible and specific, not obvious throwaways. Add a one-sentence " +
  "explanation that teaches why the answer is right. Avoid clichés and trivia everyone already knows. Reply " +
  'with ONLY a JSON object: {"question":"...","options":["..","..","..",".."],"answer":<0-3>,"explanation":"..."}';

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

// Pull the quiz JSON out of the model's reply, tolerating stray prose or fences around it.
function parsePuzzle(text: string): { question?: string; options?: unknown[]; answer?: number; explanation?: string } {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("no JSON object in model output");
  }
}

// Weighted pick: ~70% blockchain (and ~70% of those Sui), the rest general knowledge.
function pickTopic(): string {
  if (Math.random() < 0.7) {
    return Math.random() < 0.7 ? pick(SUI_TOPICS) : pick(OTHER_CHAIN_TOPICS);
  }
  return pick(GENERAL_TOPICS);
}

// Generate one puzzle for a category. Throws if the model output is not a valid quiz.
export async function generatePuzzle(index: number, topicOverride?: string): Promise<Puzzle> {
  const topic = topicOverride ?? pickTopic();
  const r = await research(topic).catch(() => null);
  const facts = r?.text ? `Facts from the web to build on:\n${r.text}` : "Use your own well-established knowledge.";
  const res = await callModel({
    systemPrompt: SYSTEM,
    userPrompt: `Category: ${topic}.\n${facts}\nWrite one fresh, non-obvious question.`,
    maxTokens: 520,
    temperature: 0.85,
    // Uses the primary (Conduit when configured) and falls back to OpenRouter automatically.
  });
  const parsed = parsePuzzle(res.text);
  const options = Array.isArray(parsed.options) ? parsed.options.slice(0, 4).map((o) => String(o)) : [];
  const answer = Number(parsed.answer);
  if (!parsed.question || options.length !== 4 || !(answer >= 0 && answer < 4)) {
    throw new Error("malformed puzzle");
  }
  return {
    id: `p${index + 1}`,
    topic,
    question: String(parsed.question),
    options,
    answer,
    explanation: String(parsed.explanation ?? ""),
    sources: r?.sources ?? [],
    grounded: Boolean(r?.text),
  };
}

// Generate `count` puzzles. A malformed or model-less attempt falls back to a canned one,
// so a match always has a full set.
export async function generatePuzzles(count: number): Promise<Puzzle[]> {
  const out: Puzzle[] = [];
  for (let i = 0; i < count; i++) {
    try {
      out.push(await generatePuzzle(i));
    } catch {
      out.push(fallbackPuzzle(i));
    }
  }
  return out;
}

// Fallbacks for when live generation fails. Weighted like the live mix: mostly blockchain,
// most of that Sui, so even a degraded round stays on theme.
const CANNED: Omit<Puzzle, "id" | "grounded" | "sources">[] = [
  {
    topic: "the Sui blockchain and its design goals",
    question: "Which consensus protocol does Sui use to order shared-object transactions?",
    options: ["Tendermint", "Mysticeti", "HotStuff", "Raft"],
    answer: 1,
    explanation: "Sui uses Mysticeti, a low-latency DAG-based consensus, to order transactions that touch shared objects.",
  },
  {
    topic: "the Move language and Sui Move smart contracts",
    question: "What language are smart contracts on Sui written in?",
    options: ["Solidity", "Rust", "Move", "Cairo"],
    answer: 2,
    explanation: "Sui contracts are written in Move, an asset-oriented language where coins and NFTs are first-class resources.",
  },
  {
    topic: "objects, ownership, and shared objects on Sui",
    question: "On Sui, which kind of object can be mutated by many transactions and so needs consensus?",
    options: ["An owned object", "A shared object", "An immutable object", "A wrapped object"],
    answer: 1,
    explanation: "Shared objects can be touched by anyone, so they go through consensus; simple owned-object transfers can run in parallel.",
  },
  {
    topic: "SUI tokenomics, gas, and the storage fund",
    question: "What token is used to pay for gas on the Sui network?",
    options: ["SUI", "WAL", "MOVE", "USDC"],
    answer: 0,
    explanation: "SUI is the network's native token; gas and staking are denominated in it.",
  },
  {
    topic: "Walrus decentralized storage on Sui",
    question: "What does Walrus provide for the Sui ecosystem?",
    options: ["A consensus engine", "Decentralized blob storage", "A bridge to Ethereum", "A privacy mixer"],
    answer: 1,
    explanation: "Walrus is a decentralized storage network for large binary files, with availability proven on Sui.",
  },
  {
    topic: "zkLogin and account abstraction on Sui",
    question: "What does Sui's zkLogin let a user do?",
    options: [
      "Hide their balance from explorers",
      "Sign in with a Web2 login to control a Sui address",
      "Run fully private smart contracts",
      "Skip paying gas entirely",
    ],
    answer: 1,
    explanation: "zkLogin derives a Sui address from an OAuth login plus a zero-knowledge proof, so users transact without a seed phrase.",
  },
  {
    topic: "Bitcoin and proof of work",
    question: "Which mechanism secures the Bitcoin network?",
    options: ["Proof of Stake", "Proof of Work", "Proof of History", "Delegated Proof of Stake"],
    answer: 1,
    explanation: "Bitcoin uses Proof of Work: miners expend computation to add blocks, making history expensive to rewrite.",
  },
  {
    topic: "Ethereum and the EVM",
    question: "Which language is most commonly used to write Ethereum smart contracts?",
    options: ["Move", "Vyper", "Solidity", "Cairo"],
    answer: 2,
    explanation: "Solidity is the dominant language for the Ethereum Virtual Machine.",
  },
  {
    topic: "biology and the human body",
    question: "Which organ can regenerate a large portion of its mass after part is removed?",
    options: ["Heart", "Liver", "Kidney", "Pancreas"],
    answer: 1,
    explanation: "The liver can regrow to near its original size from a fraction of remaining tissue.",
  },
  {
    topic: "chemistry and materials",
    question: "Which metal is liquid at room temperature?",
    options: ["Mercury", "Gallium", "Sodium", "Lead"],
    answer: 0,
    explanation: "Mercury melts at about minus 39 C, so it is liquid in normal conditions.",
  },
];

function fallbackPuzzle(index: number): Puzzle {
  const c = CANNED[index % CANNED.length]!;
  return { ...c, id: `p${index + 1}`, grounded: false, sources: [] };
}
