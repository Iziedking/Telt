"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useCurrentAccount, useSignPersonalMessage } from "@mysten/dapp-kit";
import WalletConnect from "./WalletConnect";
import Onboarding from "./Onboarding";
import Spark from "./Spark";
import { API_BASE } from "./feed";

// The entry gate. A visitor connects a wallet and signs to prove it is theirs (Sui's
// equivalent of sign-in: a personal-message signature). Whether they are returning is then
// decided by what they own on chain: a wallet that has already claimed an agent is a
// returning user and gets the quick welcome; a wallet with no agent yet is taken through
// the onboarding. No wallet, no entry — so the welcome can never show to a stranger.
type Phase = "connect" | "sign" | "checking" | "onboarding" | "spark";

function Emblem() {
  return (
    <svg viewBox="0 0 104 104" width="84" height="84" className="gate-emblem" aria-hidden>
      <circle cx="52" cy="52" r="46" fill="none" stroke="var(--ink)" strokeWidth="6" />
      <path d="M50 28 V58 Q50 70 62 70" fill="none" stroke="var(--ink)" strokeWidth="9" strokeLinecap="round" />
      <line x1="38" y1="40" x2="62" y2="40" stroke="var(--ink)" strokeWidth="9" strokeLinecap="round" />
      <circle cx="71" cy="70" r="5" fill="var(--signal)" />
    </svg>
  );
}

export default function Launch() {
  const router = useRouter();
  const account = useCurrentAccount();
  const { mutate: signPersonalMessage } = useSignPersonalMessage();
  const [phase, setPhase] = useState<Phase>("connect");
  const [signing, setSigning] = useState(false);

  // After signing, the on-chain agents decide first-time vs returning. The rule is simple:
  // a wallet with a claimed agent is returning (it owns a profile) and gets the welcome;
  // a wallet with no agent is a new user and goes through the onboarding, every time, until
  // it claims one.
  const decide = useCallback((address: string) => {
    setPhase("checking");
    fetch(`${API_BASE}/agents?owner=${address}`)
      .then((r) => r.json())
      .then((d) => {
        const hasAgent = (d.agents ?? []).length > 0;
        setPhase(hasAgent ? "spark" : "onboarding");
      })
      .catch(() => setPhase("onboarding"));
  }, []);

  // When a wallet connects, go to the sign step (or straight through if already signed).
  useEffect(() => {
    if (!account) {
      setPhase("connect");
      return;
    }
    let signed = false;
    try {
      signed = !!localStorage.getItem(`telt-auth-${account.address}`);
    } catch {
      /* ignore */
    }
    if (signed) decide(account.address);
    else setPhase("sign");
  }, [account, decide]);

  const doSign = useCallback(() => {
    if (!account) return;
    setSigning(true);
    const message = new TextEncoder().encode(
      `Sign in to Telt\n\nProve this wallet is yours to step into the arena.\n\nWallet: ${account.address}`,
    );
    signPersonalMessage(
      { message },
      {
        onSuccess: () => {
          try {
            localStorage.setItem(`telt-auth-${account.address}`, "1");
          } catch {
            /* ignore */
          }
          setSigning(false);
          decide(account.address);
        },
        onError: () => setSigning(false),
      },
    );
  }, [account, signPersonalMessage, decide]);

  const finishOnboarding = useCallback(() => {
    router.push("/home");
  }, [router]);

  if (phase === "onboarding") return <Onboarding onFinish={finishOnboarding} />;
  if (phase === "spark") return <Spark onDone={() => router.push("/home")} />;

  return (
    <div className="gate">
      <div className="gate-card">
        <Emblem />
        <div className="gate-word">
          tel<span className="gate-word-t">t</span>
        </div>

        {phase === "connect" && (
          <>
            <p className="gate-text">Connect your wallet to step into the arena.</p>
            <WalletConnect triggerClassName="gate-cta" triggerLabel="Connect wallet" />
          </>
        )}
        {phase === "sign" && (
          <>
            <p className="gate-text">One signature to prove this wallet is yours. It is free and does not move funds.</p>
            <button className="gate-cta" onClick={doSign} disabled={signing}>
              {signing ? "Check your wallet…" : "Sign in"}
            </button>
          </>
        )}
        {phase === "checking" && <p className="gate-text">Reading your agents…</p>}
      </div>
    </div>
  );
}
