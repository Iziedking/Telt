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
  });
  const parsed = JSON.parse(stripFences(res.text)) as {
    question?: string;
    options?: unknown[];
    answer?: number;
    explanation?: string;
  };
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

const CANNED: Omit<Puzzle, "id" | "grounded" | "sources">[] = [
  {
    topic: "astronomy and space",
    question: "A day on which planet is longer than its year?",
    options: ["Mercury", "Venus", "Mars", "Jupiter"],
    answer: 1,
    explanation: "Venus rotates so slowly that one rotation takes longer than one orbit of the Sun.",
  },
  {
    topic: "biology and the human body",
    question: "Which organ can regenerate a large portion of its mass after part is removed?",
    options: ["Heart", "Liver", "Kidney", "Pancreas"],
    answer: 1,
    explanation: "The liver can regrow to near its original size from a fraction of remaining tissue.",
  },
  {
    topic: "world history",
    question: "Roughly how long did the Hundred Years' War actually last?",
    options: ["About 50 years", "Exactly 100 years", "About 116 years", "About 200 years"],
    answer: 2,
    explanation: "It ran from 1337 to 1453, about 116 years, despite the name.",
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
