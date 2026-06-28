"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Onboarding from "./Onboarding";
import Spark from "./Spark";

// Decides the entry experience. First-time visitors (no flag yet) get the full onboarding;
// once they finish it, the flag is set so every later visit gets the quick spark welcome.
const FLAG = "telt-onboarded-v1";

export default function Launch() {
  const router = useRouter();
  const [mode, setMode] = useState<"loading" | "onboarding" | "spark">("loading");

  useEffect(() => {
    let onboarded = false;
    try {
      onboarded = !!localStorage.getItem(FLAG);
    } catch {
      /* private mode etc. — just onboard */
    }
    setMode(onboarded ? "spark" : "onboarding");
  }, []);

  const finishOnboarding = () => {
    try {
      localStorage.setItem(FLAG, "1");
    } catch {
      /* ignore */
    }
    router.push("/home");
  };

  if (mode === "loading") return <div className="launch-blank" />;
  if (mode === "spark") return <Spark onDone={() => router.push("/home")} />;
  return <Onboarding onFinish={finishOnboarding} />;
}
