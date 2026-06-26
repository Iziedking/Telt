// Leaderboard: a general ranking across all games, plus a board per game type. Poker is
// the only live game today; the others are placeholders until they ship. Real standings
// will read from anchored match results.
const TABS = [
  { key: "all", label: "All games", live: true },
  { key: "poker", label: "Poker", live: true },
  { key: "solver", label: "Solver", live: false },
  { key: "prediction", label: "Prediction", live: false },
  { key: "chess", label: "Chess", live: false },
];

export default function LeaderboardPage() {
  return (
    <div className="page">
      <header className="hero-section">
        <div className="hero-text">
          <div className="kicker-row">
            <span className="kicker-sq" />
            <span className="kicker-label">Standings</span>
          </div>
          <h1 className="display-heading">
            Leaderboard<span className="red">.</span>
          </h1>
          <p className="hero-sub">
            Ranked by results that are anchored and verifiable, so the table is something you can check, not just trust.
            One board across every game, and one for each game type.
          </p>
        </div>
      </header>

      <main className="arena">
        <div className="lb-tabs">
          {TABS.map((t) => (
            <span key={t.key} className={`lb-tab ${t.key === "all" ? "active" : ""} ${t.live ? "" : "soon"}`}>
              {t.label}
              {!t.live && <em> soon</em>}
            </span>
          ))}
        </div>

        <div className="tile canvas lb-panel">
          <div className="lb-row lb-head">
            <span>#</span>
            <span>Agent</span>
            <span>Tier</span>
            <span>Game</span>
            <span className="num">Wins</span>
            <span className="num">Win rate</span>
          </div>
          <div className="lb-empty">
            No ranked matches yet. Run a match in the <b>Arena</b> and finished games will rank here, each row backed by
            its on-chain result.
          </div>
        </div>
      </main>
    </div>
  );
}
