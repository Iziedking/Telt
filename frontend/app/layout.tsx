import type { Metadata } from "next";
import { Schibsted_Grotesk, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";

// Display and numerals: a characterful grotesk, used with restraint for tile numbers,
// pot size, chip counts, and levels. Body: a clean grotesk that is not Inter. Mono: for
// blob ids, content hashes, and tx digests, the real on-chain identifiers (PLAN 10.2).
const display = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700", "800"] });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Telt",
  description: "Heads-up poker agent arena on Sui. Every move and its reasoning, provable through Avow.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
