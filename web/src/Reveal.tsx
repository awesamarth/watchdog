export function Reveal() {
  return <main className="reveal-page">
    <div className="reveal-backdrop" aria-hidden="true" />
    <div className="reveal-scanlines" aria-hidden="true" />
    <div className="reveal-rail rail-top" aria-hidden="true"><i /><i /><i /></div>
    <div className="reveal-rail rail-bottom" aria-hidden="true"><i /><i /><i /></div>

    <section className="reveal-frame" aria-labelledby="reveal-title">
      <div className="reveal-lockup">
        <div className="reveal-mark">
          <span className="corner corner-tl" aria-hidden="true" />
          <span className="corner corner-tr" aria-hidden="true" />
          <span className="corner corner-bl" aria-hidden="true" />
          <span className="corner corner-br" aria-hidden="true" />
          <img src="/assets/watchdog-logo-256.png" alt="Watchdog German shepherd mascot" />
        </div>

        <div className="reveal-copy">
          <p className="reveal-eyebrow">YOUR AGENTS ARE RUNNING.</p>
          <h1 id="reveal-title">WATCHDOG</h1>
          <p className="reveal-tagline">SEE WHAT THEY’RE REALLY DOING.</p>
        </div>
      </div>

      <div className="reveal-scope" aria-label="Watchdog monitors subagents, loops, and execution graphs">
        <span>SUBAGENTS</span><i aria-hidden="true" />
        <span>LOOPS</span><i aria-hidden="true" />
        <span>EXECUTION GRAPHS</span>
      </div>

      <footer className="reveal-footer">
        <span>OBSERVE</span>
        <b aria-hidden="true">◆</b>
        <span>INTERVENE</span>
        <b aria-hidden="true">◆</b>
        <span>STAY IN CONTROL</span>
        <em>COMING SOON</em>
      </footer>
    </section>
  </main>;
}
