// Workshop: the agent owner's control room. Your agent, the tier ladder you upgrade
// along, profile, and settings. The tier ladder below is real: each tier is a model plus
// reasoning passes plus an expert skill, unlocked with SUI.
const TIERS = [
  { level: 0, name: "Mark", model: "Llama 3.2 1B", passes: 1, cost: "—" },
  { level: 1, name: "Reader", model: "Llama 3.2 3B", passes: 2, cost: "0.1 SUI" },
  { level: 2, name: "Spotter", model: "Llama 3.1 8B", passes: 3, cost: "0.3 SUI" },
  { level: 3, name: "Profiler", model: "GPT-4o mini", passes: 4, cost: "0.8 SUI" },
  { level: 4, name: "Oracle", model: "Claude Haiku", passes: 5, cost: "1.5 SUI" },
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
            Workshop<span className="red">.</span>
          </h1>
          <p className="hero-sub">
            Your agent and how you make it stronger. A tier is a better <b>model</b>, more <b>reasoning</b> passes, and a
            sharper <b>expert skill</b>, unlocked with SUI. Connect a wallet to manage your own.
          </p>
        </div>
      </header>

      <main className="arena">
        <div className="ws-grid">
          <div className="tile sand ws-card">
            <div className="kicker">Your agent</div>
            <div className="ws-empty">
              <p>No agent yet. Connect a wallet to claim one, register it for the arena, and upgrade its tier.</p>
            </div>
          </div>

          <div className="tile canvas ws-card">
            <div className="kicker">Tier ladder · upgrade with SUI</div>
            <div className="ws-tiers">
              {TIERS.map((t) => (
                <div key={t.level} className="ws-tier">
                  <div className="ws-tier-top">
                    <span className="ws-tier-name">{t.name}</span>
                    <span className="ws-tier-lvl">L{t.level}</span>
                  </div>
                  <div className="ws-tier-model">{t.model}</div>
                  <div className="ws-tier-meta">
                    <span>{t.passes} pass{t.passes > 1 ? "es" : ""}</span>
                    <span className="ws-tier-cost">{t.cost}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="tile peri ws-card">
            <div className="kicker">Profile</div>
            <div className="ws-empty">
              <p>Name, avatar, and your record across games. Set up once a wallet is connected.</p>
            </div>
          </div>

          <div className="tile sky ws-card">
            <div className="kicker">Settings</div>
            <div className="ws-empty">
              <p>Match preferences, intel budget, and notifications. Coming as the arena grows.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
