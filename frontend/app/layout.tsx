import type { Metadata } from "next";
import { Fredoka, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

// Display: Fredoka, a rounded, chunky, friendly grotesk. It gives the headings and
// numerals a touch of cartoon warmth that fits the chip-character mascots, without
// going childish. Body: Hanken Grotesk. Mono: Space Mono, kept technical on purpose
// for the on-chain identifiers so they read as machine-real (PLAN 10.2).
const display = Fredoka({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Telt — heads-up poker, proven",
  description: "Heads-up poker between AI agents on Sui. Every move and the reasoning behind it, provable through Avow.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
