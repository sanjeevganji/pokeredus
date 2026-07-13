import { useMemo, useState } from 'react';
import { computeMatchup } from '@pokeredus/core';
import { usePack } from '../context/PackContext';
import { matchupColor, typeColor } from '../lib/pack';

export default function PokemonBrowser() {
  const { pack, kg, loading, error } = usePack();
  const [speciesId, setSpeciesId] = useState('');
  const [setId, setSetId] = useState('');
  const [oppSetId, setOppSetId] = useState('');

  const speciesList = useMemo(
    () => (pack ? [...pack.species.values()].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [pack],
  );

  const setsForSpecies = useMemo(
    () => (pack && speciesId ? pack.setsForSpecies(speciesId) : []),
    [pack, speciesId],
  );

  const allSets = useMemo(
    () => (pack ? [...pack.sets.values()].sort((a, b) => a.id.localeCompare(b.id)) : []),
    [pack],
  );

  const matchup = useMemo(() => {
    if (!kg || !setId || !oppSetId) return null;
    const a = kg.getSet(setId);
    const b = kg.getSet(oppSetId);
    if (!a || !b) return null;
    return computeMatchup(a, b, kg);
  }, [kg, setId, oppSetId]);

  if (loading) return <p className="muted">Loading pack…</p>;
  if (error) return <p style={{ color: 'var(--neon-red)' }}>{error}</p>;

  const sp = speciesId ? pack?.getSpecies(speciesId) : undefined;
  const selSet = setId ? pack?.getSet(setId) : undefined;

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Pokémon Browser</h1>
      <p className="muted">Browse species/sets with live matchup via @pokeredus/core</p>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <label>
            Species
            <select
              value={speciesId}
              onChange={(e) => { setSpeciesId(e.target.value); setSetId(''); }}
              style={{ width: '100%', marginTop: 4 }}
            >
              <option value="">— select —</option>
              {speciesList.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>

          {sp && (
            <div className="card" style={{ marginTop: 12 }}>
              <div>
                {sp.types.map((t) => (
                  <span key={t} style={{ color: typeColor(t), marginRight: 8 }}>{t}</span>
                ))}
              </div>
              <div className="dim" style={{ fontSize: '0.85rem', marginTop: 6 }}>
                BST {Object.values(sp.base_stats).reduce((a, b) => a + b, 0)} · {sp.tier ?? 'OU'}
              </div>
            </div>
          )}

          <label style={{ display: 'block', marginTop: 12 }}>
            Set
            <select value={setId} onChange={(e) => setSetId(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
              <option value="">— select —</option>
              {setsForSpecies.map((s) => (
                <option key={s.id} value={s.id}>{s.set_name}</option>
              ))}
            </select>
          </label>

          {selSet && (
            <div className="card" style={{ marginTop: 12, fontSize: '0.9rem' }}>
              <div><strong>{selSet.set_name}</strong> · {selSet.role}</div>
              <div className="muted">{selSet.ability} @ {selSet.item}</div>
              <div className="muted">{selSet.moves.join(', ')}</div>
            </div>
          )}
        </div>

        <div className="panel">
          <label>
            Opponent set
            <select value={oppSetId} onChange={(e) => setOppSetId(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
              <option value="">— select —</option>
              {allSets.map((s) => (
                <option key={s.id} value={s.id}>{s.id}</option>
              ))}
            </select>
          </label>

          {matchup && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontSize: '1.4rem', color: matchupColor(matchup.score) }}>
                Score: {matchup.score.toFixed(3)}
              </div>
              <div className="muted">{matchup.category} · conf {matchup.confidence}</div>
              <table style={{ width: '100%', marginTop: 10, fontSize: '0.9rem' }}>
                <tbody>
                  <tr><td>TTK (us → them)</td><td>{matchup.ttkLabel(matchup.turns_to_kill_a)}</td></tr>
                  <tr><td>TTK (them → us)</td><td>{matchup.ttkLabel(matchup.turns_to_kill_b)}</td></tr>
                  <tr><td>Speed</td><td>{matchup.speed_advantage}</td></tr>
                  <tr><td>Best move</td><td>{matchup.best_move_a_id || '—'}</td></tr>
                  <tr><td>Dmg %</td>
                    <td>{matchup.damage_pct_a_to_b_lo.toFixed(1)}–{matchup.damage_pct_a_to_b_hi.toFixed(1)}%</td>
                  </tr>
                </tbody>
              </table>
              <div className="dim" style={{ marginTop: 8, fontSize: '0.8rem' }}>
                {matchup.tags.join(' · ')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
