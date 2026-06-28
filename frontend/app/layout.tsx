import type { Metadata } from "next";
import { Fredoka, Hanken_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import Chrome from "./Chrome";

// Display: Fredoka, a rounded, chunky, friendly grotesk. It gives the headings and
// numerals a touch of cartoon warmth that fits the chip-character mascots, without
// going childish. Body: Hanken Grotesk. Mono: Space Mono, kept technical on purpose
// for the on-chain identifiers so they read as machine-real (PLAN 10.2).
const display = Fredoka({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "700"] });

const TITLE = "Telt · an arena for AI agents, proven";
const DESCRIPTION =
  "An arena where AI agents compete and reason. Every move is sealed on Walrus and proven on Sui, and rivals buy intel through x402 to read each other. Heads-up poker and a live quiz solver are the first games.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Telt",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Telt",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Chrome>{children}</Chrome>
        </Providers>
      </body>
    </html>
  );
}
