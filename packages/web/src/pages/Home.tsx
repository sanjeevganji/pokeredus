import { Link } from 'react-router-dom';
import { usePack } from '../context/PackContext';

export default function Home() {
  const { pack, loading, error } = usePack();

  return (
    <div>
      <h1 className="neon-title">PokeRedus</h1>
      <p className="neon-subtitle">Competitive Pokémon team analysis — web edition</p>

      <div className="panel" style={{ marginTop: 24, maxWidth: 640 }}>
        <h3 style={{ color: 'var(--neon-pink)', marginTop: 0 }}>Navigation</h3>
        <ul style={{ lineHeight: 2 }}>
          <li><Link to="/teams">Team Builder</Link> — load/save JSON teams</li>
          <li><Link to="/browser">Pokémon Browser</Link> — browse sets with live matchups</li>
          <li><Link to="/graph">Matchup Graph</Link> — 2D force graph of team matchups</li>
          <li><Link to="/simulator">Simulator</Link> — damage ranges + turn recommendations</li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 16, maxWidth: 640 }}>
        {loading && <span className="muted">Loading knowledge pack…</span>}
        {error && <span style={{ color: 'var(--neon-red)' }}>Pack error: {error}</span>}
        {pack && (
          <span className="muted">
            Pack loaded — {pack.species.size} species, {pack.sets.size} sets, {pack.moves.size} moves
          </span>
        )}
      </div>
    </div>
  );
}
