import { useMemo, useState } from 'react';
import { computeDamage } from '@pokeredus/calc';
import { DEFAULT_BIASES } from '@pokeredus/biases';
import { scoreTurn, makeMon, emptyField } from '@pokeredus/engine';
import { usePack } from '../context/PackContext';
import { matchupColor } from '../lib/pack';

export default function Simulator() {
  const { pack, loading } = usePack();
  const [mySetId, setMySetId] = useState('venusaur_sun-sweeper');
  const [oppSetId, setOppSetId] = useState('clefable_showdown-usage');

  const allSets = useMemo(
    () => (pack ? [...pack.sets.values()].sort((a, b) => a.id.localeCompare(b.id)) : []),
    [pack],
  );

  const damageRows = useMemo(() => {
    if (!pack || !mySetId || !oppSetId) return [];
    const atkSet = pack.getSet(mySetId);
    const defSet = pack.getSet(oppSetId);
    if (!atkSet || !defSet) return [];
    const atkSp = pack.getSpecies(atkSet.pokemon_id);
    const defSp = pack.getSpecies(defSet.pokemon_id);
    if (!atkSp || !defSp) return [];

    return atkSet.moves.map((moveId) => {
      const move = pack.getMove(moveId);
      if (!move) return null;
      const r = computeDamage(atkSet, defSet, move, atkSp, defSp, 100);
      return { moveId, moveName: move.name, ...r };
    }).filter(Boolean) as Array<{
      moveId: string; moveName: string;
      min_damage: number; max_damage: number;
      turns_to_kill: number; type_effectiveness: number;
      is_ohko: boolean; is_immune: boolean;
    }>;
  }, [pack, mySetId, oppSetId]);

  const recommendations = useMemo(() => {
    if (!pack) return [];
    const mySet = pack.getSet(mySetId);
    const oppSet = pack.getSet(oppSetId);
    if (!mySet || !oppSet) return [];

    const benchIds = allSets
      .filter((s) => s.id !== mySetId && s.id !== oppSetId)
      .slice(0, 3)
      .map((s) => s.id);

    const hp = 300;
    const state = {
      side: 'a' as const,
      turn: 1,
      myActive: makeMon(mySetId, hp),
      myBench: benchIds.map((id) => makeMon(id, hp)),
      oppActive: makeMon(oppSetId, hp),
      field: emptyField(),
      teraUsed: false,
      allowThin: true,
    };

    try {
      return scoreTurn(state, pack, DEFAULT_BIASES).slice(0, 3);
    } catch {
      return [];
    }
  }, [pack, mySetId, oppSetId, allSets]);

  if (loading) return <p className="muted">Loading pack…</p>;

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Simulator</h1>
      <p className="muted">Damage ranges (@pokeredus/calc) + top-3 turns (@pokeredus/engine)</p>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <label>
          Your set
          <select value={mySetId} onChange={(e) => setMySetId(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
            {allSets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </label>
        <label>
          Opponent set
          <select value={oppSetId} onChange={(e) => setOppSetId(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
            {allSets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </label>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0, color: 'var(--neon-orange)' }}>Damage Ranges</h3>
        <table style={{ width: '100%', fontSize: '0.9rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-secondary)' }}>
              <th>Move</th><th>Min–Max</th><th>TTK</th><th>Eff</th>
            </tr>
          </thead>
          <tbody>
            {damageRows.map((r) => (
              <tr key={r.moveId}>
                <td>{r.moveName}</td>
                <td>{r.is_immune ? 'immune' : `${r.min_damage}–${r.max_damage}`}</td>
                <td>{r.is_ohko ? 'OHKO' : r.turns_to_kill || '—'}</td>
                <td>{r.type_effectiveness}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0, color: 'var(--neon-green)' }}>Top 3 Recommendations</h3>
        {recommendations.length === 0 && <p className="muted">No recommendations available.</p>}
        <ol style={{ paddingLeft: 20 }}>
          {recommendations.map((rec, i) => (
            <li key={i} style={{ marginBottom: 12 }}>
              <strong style={{ color: matchupColor(rec.score) }}>
                {rec.score.toFixed(3)}
              </strong>
              {' — '}
              {rec.action.type === 'move'
                ? `Move: ${rec.action.moveId}${rec.action.tera ? ' (Tera)' : ''}`
                : `Switch to slot ${rec.action.slot}`}
              <div className="dim" style={{ fontSize: '0.8rem' }}>
                {rec.reasoning.slice(0, 3).join(' · ')}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
