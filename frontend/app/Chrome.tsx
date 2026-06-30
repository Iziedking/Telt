"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { TopNav, SiteFooter } from "./shell";
import Tour from "./Tour";
import TutorialButton from "./TutorialButton";
import SoundToggle from "./SoundToggle";
import ThemeToggle from "./ThemeToggle";
import { startMusic, stopMusic } from "./sound";

// The landing page at "/" is pure marketing and shows no app chrome. Every other route is
// the app and gets the product nav, footer, navigation tour, and the game audio.
export default function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  // The landing, brand-export, launch, and the admin health check show no app chrome.
  const isApp = !(path === "/" || path === "/brand" || path === "/launch" || path === "/admin");

  // Music lifecycle, tied to the app:
  //  - On an app page: start it, and unlock autoplay on the first interaction (browsers block
  //    autoplay until a gesture), so it also comes back after a refresh.
  //  - On the landing (or other no-chrome routes): stop it, so it never leaks there.
  //  - Only the visible tab plays: pause when the tab is hidden and resume when it returns, so
  //    opening a second tab does not leave two tracks fighting.
  useEffect(() => {
    if (!isApp) {
      stopMusic();
      return;
    }
    startMusic();
    const onGesture = () => {
      startMusic();
      removeGesture();
    };
    const removeGesture = () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("touchstart", onGesture);
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    window.addEventListener("touchstart", onGesture);
    const onVisibility = () => {
      if (document.hidden) stopMusic();
      else startMusic();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      removeGesture();
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
