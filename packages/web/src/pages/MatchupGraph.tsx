import { useEffect, useMemo, useRef, useState } from 'react';
import { computeMatchup } from '@pokeredus/core';
import { usePack } from '../context/PackContext';
import { listTeams, type TeamRecord } from '../lib/teams';
import { drawForceGraph, runForceLayout, type GraphEdge, type GraphNode } from '../lib/forceGraph';

export default function MatchupGraph() {
  const { pack, kg } = usePack();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [teamId, setTeamId] = useState('');
  const [mode, setMode] = useState<'team' | 'all'>('team');

  useEffect(() => { listTeams().then(setTeams); }, []);

  const setIds = useMemo(() => {
    if (mode === 'all' && pack) return [...pack.sets.keys()].slice(0, 20);
    const team = teams.find((t) => t.team_id === teamId);
    return team?.sets.filter(Boolean) ?? [];
  }, [mode, pack, teams, teamId]);

  const { nodes, edges, scores } = useMemo(() => {
    if (!kg || setIds.length < 2) {
      return { nodes: [] as GraphNode[], edges: [] as GraphEdge[], scores: new Map<string, number>() };
    }

    const nodes: GraphNode[] = setIds.map((id, i) => {
      const angle = (i / setIds.length) * Math.PI * 2;
      const r = 120;
      return {
        id,
        label: id.split('_')[0] ?? id,
        x: 300 + Math.cos(angle) * r,
        y: 250 + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });

    const edges: GraphEdge[] = [];
    const scores = new Map<string, number>();

    for (let i = 0; i < setIds.length; i++) {
      for (let j = i + 1; j < setIds.length; j++) {
        const a = kg.getSet(setIds[i]!);
        const b = kg.getSet(setIds[j]!);
        if (!a || !b) continue;
        const m = computeMatchup(a, b, kg);
        const key = `${setIds[i]}->${setIds[j]}`;
        scores.set(key, m.score);
        edges.push({ source: setIds[i]!, target: setIds[j]!, weight: m.score });
      }
    }

    return { nodes, edges, scores };
  }, [kg, setIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w;
    canvas.height = h;

    const layoutNodes = nodes.map((n) => ({ ...n }));
    runForceLayout({ width: w, height: h, nodes: layoutNodes, edges });

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    drawForceGraph(ctx, layoutNodes, edges, (src, tgt) => scores.get(`${src}->${tgt}`) ?? 0);
  }, [nodes, edges, scores]);

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Matchup Graph</h1>
      <p className="muted">2D force graph — green favorable, red unfavorable</p>

      <div className="panel" style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'team' | 'all')} style={{ marginLeft: 8 }}>
            <option value="team">Team sets</option>
            <option value="all">Pack sample (20)</option>
          </select>
        </label>
        {mode === 'team' && (
          <label>
            Team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={{ marginLeft: 8 }}>
              <option value="">— select —</option>
              {teams.map((t) => (
                <option key={t.team_id} value={t.team_id}>{t.team_name}</option>
              ))}
            </select>
          </label>
        )}
        <span className="dim">{setIds.length} nodes · {edges.length} edges</span>
      </div>

      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: 500,
          marginTop: 16,
          border: '1px solid var(--fg-dim)',
          borderRadius: 8,
          background: 'var(--bg-dark)',
        }}
      />
    </div>
  );
}
