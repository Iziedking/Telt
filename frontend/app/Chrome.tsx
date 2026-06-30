"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { TopNav, SiteFooter } from "./shell";
import Tour from "./Tour";
import TutorialButton from "./TutorialButton";
import SoundToggle from "./SoundToggle";
import ThemeToggle from "./ThemeToggle";
import { startMusic, primeMusicOnGesture } from "./sound";

// The landing page at "/" is pure marketing and shows no app chrome. Every other route is
// the app and gets the product nav, footer, navigation tour, and the game audio.
export default function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  // The landing, brand-export, launch, and the admin health check show no app chrome.
  const isApp = !(path === "/" || path === "/brand" || path === "/launch" || path === "/admin");

  // Start the background music when the app loads, and prime it on the first interaction since
  // browsers block autoplay until a user gesture.
  useEffect(() => {
    if (!isApp) return;
    startMusic();
    primeMusicOnGesture();
  }, [isApp]);

  if (!isApp) return <>{children}</>;
  return (
    <>
      <TopNav />
      {children}
      <SiteFooter />
      <Tour />
      <ThemeToggle />
      <SoundToggle />
      <TutorialButton />
    </>
  );
}
