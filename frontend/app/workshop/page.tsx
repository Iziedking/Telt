import FaucetCard from "../FaucetCard";
import AgentCard from "../AgentCard";
import ProfileCard from "../ProfileCard";
import WinningsCard from "../WinningsCard";

// Workshop: the agent owner's control room. Your agent, the tier ladder you upgrade
// along, profile, and settings. Each tier is a stronger model plus more reasoning passes
// plus a sharper expert skill, unlocked with SUI. The model behind each tier is kept
// hidden on purpose, so an opponent cannot game it.
const TIERS = [
  { level: 0, name: "Mark", trait: "Untrained", passes: 1, cost: "free" },
  { level: 1, name: "Reader", trait: "Preflop discipline", passes: 2, cost: "1 SUI" },
  { level: 2, name: "Spotter", trait: "Pot odds, c-betting", passes: 3, cost: "2.5 SUI" },
  { level: 3, name: "Profiler", trait: "Ranges, balance", passes: 4, cost: "6 SUI" },
  { level: 4, name: "Oracle", trait: "GTO-aware, exploitative", passes: 5, cost: "15 SUI" },
];

export default function WorkshopPage() {
  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Your space</span>
          </div>
          <h1 className="display-heading">
            Workshop
          </h1>
          <p className="hero-sub">
            Your agent and how you make it stronger. A tier is a better <b>model</b>, more <b>reasoning</b> passes, and a
            sharper <b>expert skill</b>, unlocked with SUI. Connect a wallet to manage your own.
          </p>
        </div>
      </header>

      <main className="arena">
        <div className="ws-grid">
          <FaucetCard />

          <AgentCard />

          <div className="tile canvas ws-card">
            <div className="kicker">Tier ladder · upgrade with SUI</div>
            <div className="ws-tiers">
              {TIERS.map((t) => (
                <div key={t.level} className="ws-tier">
                  <div className="ws-tier-top">
                    <span className="ws-tier-name">{t.name}</span>
                    <span className="ws-tier-lvl">L{t.level}</span>
                  </div>
                  <div className="ws-tier-model">{t.trait}</div>
                  <div className="ws-tier-meta">
                    <span>{t.passes} pass{t.passes > 1 ? "es" : ""}</span>
                    <span className="ws-tier-cost">{t.cost}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <ProfileCard />

          <WinningsCard />

          <div className="tile sky ws-card">
            <div className="kicker">Intel budget · dossiers per match</div>
            <div className="ws-intel">
              {[
                ["Mark", 3],
                ["Reader", 3],
                ["Spotter", 2],
                ["Profiler", 1],
                ["Oracle", 0],
              ].map(([tier, n]) => (
                <div key={tier as string} className="ws-intel-row">
                  <span>{tier}</span>
                  <span className="ws-intel-n">{n === 0 ? "none" : `${n}`}</span>
                </div>
              ))}
            </div>
            <p className="ws-intel-note">
              A trailing agent buys a sealed dossier on its rival through x402. Lower tiers get more reads; the Oracle
              needs none.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
