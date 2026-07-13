import { useCallback, useEffect, useState } from 'react';
import { usePack } from '../context/PackContext';
import { getTeam, listTeams, makeTeamId, saveTeam, type TeamRecord } from '../lib/teams';

const MAX_SLOTS = 6;

export default function TeamBuilder() {
  const { pack } = usePack();
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [teamName, setTeamName] = useState('New Team');
  const [slots, setSlots] = useState<string[]>(Array(MAX_SLOTS).fill(''));
  const [status, setStatus] = useState('');

  const refresh = useCallback(() => {
    listTeams().then(setTeams).catch((e) => setStatus(String(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const loadTeam = async (id: string) => {
    const t = await getTeam(id);
    if (!t) return;
    setSelectedId(t.team_id);
    setTeamName(t.team_name);
    const filled = [...t.sets];
    while (filled.length < MAX_SLOTS) filled.push('');
    setSlots(filled.slice(0, MAX_SLOTS));
    setStatus(`Loaded ${t.team_name}`);
  };

  const save = async () => {
    const id = selectedId || makeTeamId(teamName);
    const sets = slots.filter(Boolean);
    const record: TeamRecord = {
      team_id: id,
      team_name: teamName,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      sets,
    };
    const saved = await saveTeam(record);
    setSelectedId(saved.team_id);
    setStatus(`Saved ${saved.team_name} (${sets.length} sets)`);
    refresh();
  };

  const setOptions = pack ? [...pack.sets.values()].sort((a, b) => a.id.localeCompare(b.id)) : [];

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Team Builder</h1>
      <p className="muted">Load/save teams from <code>pokeredus/data/teams/</code></p>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 style={{ marginTop: 0, color: 'var(--neon-cyan)' }}>Saved Teams</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {teams.map((t) => (
              <li key={t.team_id} style={{ marginBottom: 6 }}>
                <button type="button" onClick={() => loadTeam(t.team_id)} style={{ width: '100%', textAlign: 'left' }}>
                  {t.team_name} <span className="dim">({t.sets.length})</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <label>
            Team name<br />
            <input value={teamName} onChange={(e) => setTeamName(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          </label>
          <p className="dim" style={{ fontSize: '0.85rem' }}>ID: {selectedId || makeTeamId(teamName)}</p>

          {slots.map((slot, i) => (
            <label key={i} style={{ display: 'block', marginTop: 10 }}>
              Slot {i + 1}
              <select
                value={slot}
                onChange={(e) => {
                  const next = [...slots];
                  next[i] = e.target.value;
                  setSlots(next);
                }}
                style={{ width: '100%', marginTop: 4 }}
              >
                <option value="">— empty —</option>
                {setOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.id} ({s.set_name})</option>
                ))}
              </select>
            </label>
          ))}

          <button type="button" onClick={save} style={{ marginTop: 16 }}>Save Team</button>
          {status && <p className="muted" style={{ marginTop: 8 }}>{status}</p>}
        </div>
      </div>
    </div>
  );
}
