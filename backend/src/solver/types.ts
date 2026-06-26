// A solver puzzle: a real multiple-choice quiz a curious person would learn from. The
// correct answer and the teaching explanation are held back from the solving agents and
// used to mark their choices. `grounded` is true when live web facts shaped the question.
export interface Puzzle {
  id: string;
  topic: string;
  question: string;
  options: string[]; // exactly four
  answer: number; // 0..3, the correct option
  explanation: string;
  sources: string[]; // urls the fact came from
  grounded: boolean;
}
