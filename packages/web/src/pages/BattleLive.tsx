import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  deleteSpeciesSet,
  detachGame,
  formatFromRoom,
  getLiveState,
  getSpeciesSets,
  putSpeciesSet,
  type CanonicalSet,
  type LiveChoice,
  type LiveEval,
  type LiveQuantum,
  type LiveReply,
  type LiveScorePoint,
  type LiveSlot,
  type LiveState,
  type SetCatalog,
} from '../lib/games';
import {
  computeScoreGraphDomain,
  displayFraction,
  formatPercent,
  formatSigned,
  formatTTK,
  formatWilsonInterval,
  getLatestSettledScore,
  getRecommendedActionId,
} from '../lib/live-score';
import { importScenario } from '../lib/scenarios';
import { ScoreBar } from '../components/ScoreBar';
import { Bench, FieldBadges, actionLabel, prettySpecies } from '../components/theater';

export default function BattleLive() {
  const navigate = useNavigate();
  const [live, setLive] = useState<LiveState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [drawer, setDrawer] = useState<{ slot: LiveSlot; opener: HTMLElement } | null>(null);

  const inFlightRef = useRef(false);
  const lastTsRef = useRef<string | undefined>(undefined);
  const lastSeqRef = useRef<number>(0);
  const lastStatusRef = useRef<string>('');

  const openSet = useCallback((slot: LiveSlot, opener: HTMLElement) => {
    if (!slot.revealed || !slot.speciesId) return;
    setDrawer({ slot, opener });
  }, []);

  const assumeSet = useCallback(async (slot: LiveSlot, set: CanonicalSet) => {
    if (!slot.revealed || !slot.speciesId) return;
    try {
      await putSpeciesSet(formatFromRoom(live.room), slot.speciesId, set);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err));
    }
  }, [live.room]);

  const poll = useCallback(async () => {
    if (inFlightRef.current || document.hidden) return;
    inFlightRef.current = true;
    try {
      const data = await getLiveState();
      const seq = data.points?.length ?? 0;
      if (
        data.ts !== lastTsRef.current ||
        seq !== lastSeqRef.current ||
        data.status !== lastStatusRef.current
      ) {
        lastTsRef.current = data.ts;
        lastSeqRef.current = seq;
        lastStatusRef.current = data.status;
        setLive(data);
      }
    } catch {
      // ignore network hiccups during active play
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 250);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [poll]);

  const detach = useCallback(async () => {
    setBusy(true);
    try {
      await detachGame();
    } catch {
      /* still leave the theater */
    }
    setBusy(false);
    navigate('/games');
  }, [navigate]);

  const save = useCallback(async () => {
    setBusy(true);
    setSaveMsg('');
    try {
      const s = await importScenario({
        source: 'live',
        name: live.room ? `${live.room} turn ${live.turn ?? 0}` : undefined,
      });
      setSaveMsg(`Saved ${s.name}`);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }, [live.room, live.turn]);

  const idle = !live.status || live.status === 'idle';
  if (idle) {
    return (
      <div className="theater">
        <div className="theater-empty">
          <h1>No live battle</h1>
          <p className="muted">Attach a Showdown game from Games, or launch PokeLink from the terminal.</p>
          <Link to="/games" className="btn-primary">Detect a battle</Link>
        </div>
      </div>
    );
  }

  const loading = (live.status === 'connecting' || live.status === 'deciding') && !live.eval;

  return (
    <div className="theater">
      <header className="theater-chrome">
        <Link to="/games" className="btn-secondary">Back to Games</Link>
        <h1 className="theater-title">{live.room || 'PokeLink'}</h1>
        <span className={`status-pill status-${live.status}`}>{live.status}</span>
        <span className="muted">turn {live.turn ?? 0}</span>
        <span className="muted">{live.policy}</span>
        <span className="muted">{live.dryRun ? 'dry-run' : 'send'}</span>
        <FieldBadges field={live.field} />
        <button type="button" className="btn-secondary" onClick={save} disabled={busy}>
          Save scenario
        </button>
        <button type="button" className="btn-danger" onClick={detach} disabled={busy} style={{ marginLeft: 'auto' }}>
          {busy ? 'Detaching…' : 'Detach'}
        </button>
      </header>

      {live.error && <p className="theater-alert theater-alert-error" role="alert">{live.error}</p>}
      {live.warnings?.map((w) => <p key={w} className="theater-alert theater-alert-error" role="alert">{w}</p>)}
      {(live.ours ?? []).concat(live.theirs ?? []).some((s) => s.revealed && s.setComplete === false) && (
        <p className="theater-alert" role="status">Incomplete assumptions — one or more revealed Pokémon has no full set.</p>
      )}
      {live.winner && <p className="theater-alert theater-alert-win" role="status">{live.winner} wins</p>}
      {saveMsg && (
        <p className="theater-alert" role="status">
          {saveMsg} {saveMsg.startsWith('Saved') && <Link to="/scenarios">Open lab</Link>}
        </p>
      )}

      {loading ? (
        <TheaterSkeleton />
      ) : (
        <>
          <ScoreStrip state={live} />
          <div className="theater-body">
            <Bench
              area="ours"
              title="Ours"
              slots={live.ours ?? []}
              field={live.field?.ours}
              accent="cyan"
              compact
              onEditSet={openSet}
              onAssumeSet={assumeSet}
            />
            <OurChoiceList
              area="ourc"
              title="Our choices"
              choices={live.eval?.choices ?? []}
              sampledId={live.eval?.sampledAction}
              quantum={live.eval?.quantum}
              slots={live.ours}
              points={live.points}
            />
            <Bench
              area="theirs"
              title="Theirs"
              slots={live.theirs ?? []}
              field={live.field?.theirs}
              accent="pink"
              compact
              onEditSet={openSet}
              onAssumeSet={assumeSet}
            />
            <TheirReplyList
              area="theirc"
              title="Their replies"
              replies={live.eval?.replies ?? []}
              slots={live.theirs}
            />
          </div>
        </>
      )}

      <details className="theater-log">
        <summary>Protocol log</summary>
        <pre className="event-log">{formatEvents(live.events)}</pre>
      </details>
      {drawer && (
        <SetDrawer
          slot={drawer.slot}
          format={formatFromRoom(live.room)}
          opener={drawer.opener}
          onClose={() => setDrawer(null)}
          onSaved={(msg) => {
            setSaveMsg(msg);
            setDrawer(null);
          }}
        />
      )}
    </div>
  );
}

function ScoreStrip({ state }: { state: LiveState }) {
  const ev = state.eval;
  const points = state.points ?? [];
  const settledScore = getLatestSettledScore(points);
  const sampledChoice = ev?.choices.find((c) => c.id === ev.sampledAction);
  const forecast = ev?.forecast;

  // Primary values
  // 1. Battle score
  const isLegacy = state.isLegacy || state.schemaVersion === 1;
  const battleScoreLabel = isLegacy
    ? (ev?.roundScore != null ? formatSigned(ev.roundScore, 2) : '—')
    : (settledScore != null ? formatSigned(settledScore, 2) : '—');
  const battleScoreStatus = isLegacy
    ? 'Legacy round score'
    : (settledScore != null ? 'Settled cumulative total' : 'Waiting for first decision');

  // 2. This action
  let thisActionValue = '—';
  let thisActionStatus = 'Waiting for first decision';
  if (sampledChoice) {
    const actionName = actionLabel(sampledChoice.id, state.ours);
    const delta = formatSigned(sampledChoice.choiceScore, 2);
    const minD = sampledChoice.minTurnScore != null ? formatSigned(sampledChoice.minTurnScore, 2) : delta;
    const maxD = sampledChoice.maxTurnScore != null ? formatSigned(sampledChoice.maxTurnScore, 2) : delta;
    thisActionValue = `${actionName} (${delta})`;
    thisActionStatus = `Observed range: ${minD} to ${maxD}`;
  } else if (ev?.sampledAction) {
    thisActionValue = actionLabel(ev.sampledAction, state.ours);
    thisActionStatus = ev.roundScore != null ? `Expected ${formatSigned(ev.roundScore, 2)}` : 'Waiting for decision';
  }

  // 3. Win forecast
  let winForecastValue = '—';
  let winForecastStatus = 'Forecast unavailable';
  if (forecast) {
    if (forecast.status === 'incomplete-assumptions') {
      winForecastStatus = 'Incomplete sets';
    } else if (forecast.status === 'running') {
      winForecastStatus = 'Forecasting';
      if (sampledChoice?.winRate != null) {
        winForecastValue = formatPercent(sampledChoice.winRate, 0);
      }
    } else {
      const matchChoice = forecast.choices.find((c) => c.actionId === ev?.sampledAction)
        ?? (sampledChoice?.winRate != null ? sampledChoice : undefined);
      if (matchChoice && matchChoice.winRate != null) {
        winForecastValue = formatPercent(matchChoice.winRate, 0);
        const interval = formatWilsonInterval(matchChoice.winRateLow, matchChoice.winRateHigh);
        const intervalText = interval ? `${interval}, ` : '';
        winForecastStatus = `95% interval: ${intervalText}n=${matchChoice.samples ?? forecast.totalSamples}`;
      } else {
        winForecastStatus = `Completed (${forecast.totalSamples} samples)`;
      }
    }
  } else if (!ev) {
    winForecastStatus = 'Waiting for first decision';
  }

  return (
    <section className="score-strip card" aria-label="Battle Score & Forecast Dashboard">
      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">{isLegacy ? 'Legacy round score' : 'Battle score'}</span>
          <span className="metric-value metric-score">{battleScoreLabel}</span>
          <span className="metric-subtext">{battleScoreStatus}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">This action</span>
          <span className="metric-value metric-action">{thisActionValue}</span>
          <span className="metric-subtext">{thisActionStatus}</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Win forecast</span>
          <span className="metric-value metric-forecast">{winForecastValue}</span>
          <span className="metric-subtext">{winForecastStatus}</span>
        </div>
      </div>

      <TurnGraph points={points} currentEval={ev} isLegacy={isLegacy} />

      <details className="score-disclosure">
        <summary>How this score is calculated</summary>
        <div className="score-disclosure-body">
          <div className="disclosure-col">
            <h4>Score Weights</h4>
            <ul className="disclosure-list">
              <li>Damage/health: {ev?.scoreWeights?.health?.toFixed(2) ?? '1.00'}</li>
              <li>Modifiers: {ev?.scoreWeights?.modifier?.toFixed(2) ?? '1.00'}</li>
              <li>Secondary effects: {ev?.scoreWeights?.secondary?.toFixed(2) ?? '1.00'}</li>
              <li>Switch risk: {ev?.scoreWeights?.switchRisk?.toFixed(2) ?? '1.00'}</li>
              <li>Sacrifice: {ev?.scoreWeights?.sacrifice?.toFixed(2) ?? '1.00'}</li>
            </ul>
          </div>

          <div className="disclosure-col">
            <h4>Utility & Model Input</h4>
            <ul className="disclosure-list">
              <li>Expected round score: {ev?.roundScore != null ? formatSigned(ev.roundScore, 3) : '—'}</li>
              <li>Attributed forced outcome: {ev?.forcedOutcome ?? 'none'}</li>
              <li>Mate probability: {ev?.mateProbability != null ? formatPercent(ev.mateProbability, 1) : '—'}</li>
              {sampledChoice?.hamiltonianInput != null && (
                <li>Hamiltonian input (scaled): {sampledChoice.hamiltonianInput.toFixed(3)}</li>
              )}
            </ul>
          </div>

          <div className="disclosure-col">
            <h4>Quantum Policy</h4>
            <ul className="disclosure-list">
              <li>Mode: {ev?.quantum?.mode ?? 'softmax'}</li>
              <li>Qubits: {ev?.quantum?.nQubits != null ? `${ev.quantum.nQubits} qubits` : '—'}</li>
              <li>Execution: {ev?.quantum?.exact ? 'exact statevector' : (ev?.quantum?.shots != null ? `${ev.quantum.shots} shots` : '—')}</li>
              {ev?.quantum?.params && <li>Parameters: [{ev.quantum.params.map((p) => p.toFixed(2)).join(', ')}]</li>}
              {ev?.quantum?.cost != null && <li>Cost: {ev.quantum.cost.toFixed(4)}</li>}
            </ul>
          </div>

          <div className="disclosure-col">
            <h4>Rollout Forecast</h4>
            <ul className="disclosure-list">
              <li>Samples: {forecast?.totalSamples ?? 0}</li>
              <li>Assumptions: {forecast?.assumptionsComplete ? 'Complete set pool' : 'Incomplete'}</li>
              <li>Status: {forecast?.status ?? 'Not initiated'}</li>
              {forecast?.elapsedMs != null && <li>Latency: {forecast.elapsedMs}ms</li>}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

const GRAPH_LAYOUT = { w: 600, h: 120, l: 48, r: 24, t: 16, b: 28 };

function TurnGraph({
  points,
  currentEval,
  isLegacy,
}: {
  points: LiveScorePoint[];
  currentEval?: LiveEval;
  isLegacy?: boolean;
}) {
  const { w, h, l, r, t, b } = GRAPH_LAYOUT;
  const innerW = w - l - r;
  const innerH = h - t - b;

  const maxAbs = useMemo(
    () => computeScoreGraphDomain(points, [currentEval?.roundScore, currentEval?.expectedRoundScore]),
    [points, currentEval],
  );

  const y0 = t + innerH / 2;
  const yAt = useCallback(
    (score: number) => {
      const clamped = Math.max(-maxAbs, Math.min(maxAbs, score));
      return t + ((maxAbs - clamped) / (2 * maxAbs)) * innerH;
    },
    [maxAbs, t, innerH],
  );

  const xAt = useCallback(
    (index: number, count: number) => {
      if (count <= 1) return l + innerW / 2;
      return l + (index / (count - 1)) * innerW;
    },
    [l, innerW],
  );

  const count = points.length;

  // Build envelope polygon for points with sample bounds
  const hasEnvelope = points.some((p) => p.samples > 0 && Math.abs(p.maxTotal - p.minTotal) > 1e-4);
  const envelopePath = useMemo(() => {
    if (!hasEnvelope || count === 0) return '';
    const topPts: string[] = [];
    const botPts: string[] = [];
    for (let i = 0; i < count; i++) {
      const x = xAt(i, count);
      topPts.push(`${x.toFixed(2)},${yAt(points[i]!.maxTotal).toFixed(2)}`);
      botPts.push(`${x.toFixed(2)},${yAt(points[i]!.minTotal).toFixed(2)}`);
    }
    return `M ${topPts.join(' L ')} L ${botPts.reverse().join(' L ')} Z`;
  }, [hasEnvelope, count, points, xAt, yAt]);

  const minLine = useMemo(() => {
    if (!hasEnvelope || count === 0) return '';
    return points.map((p, i) => `${xAt(i, count).toFixed(2)},${yAt(p.minTotal).toFixed(2)}`).join(' ');
  }, [hasEnvelope, count, points, xAt, yAt]);

  const maxLine = useMemo(() => {
    if (!hasEnvelope || count === 0) return '';
    return points.map((p, i) => `${xAt(i, count).toFixed(2)},${yAt(p.maxTotal).toFixed(2)}`).join(' ');
  }, [hasEnvelope, count, points, xAt, yAt]);

  // Settled line
  const settledPoints = points.filter((p) => p.status === 'settled');
  const settledLine = useMemo(() => {
    if (points.length === 0) return '';
    return points.map((p, i) => `${xAt(i, count).toFixed(2)},${yAt(p.cumulativeTotal).toFixed(2)}`).join(' ');
  }, [points, count, xAt, yAt]);

  // Expected line (dashed, showing expectedTotal)
  const expectedLine = useMemo(() => {
    if (points.length === 0) return '';
    return points.map((p, i) => `${xAt(i, count).toFixed(2)},${yAt(p.expectedTotal).toFixed(2)}`).join(' ');
  }, [points, count, xAt, yAt]);

  const latestPoint = points[points.length - 1];

  return (
    <figure className="turn-graph-figure">
      <figcaption className="turn-graph-caption">
        <span className="caption-title">
          {isLegacy ? 'Legacy round score series' : 'Battle Score Timeline'}
        </span>
        <div className="graph-legend" aria-hidden="true">
          <span className="legend-item"><span className="legend-line legend-settled" /> Settled score</span>
          <span className="legend-item"><span className="legend-line legend-expected" /> Expected total</span>
          {hasEnvelope && <span className="legend-item"><span className="legend-box legend-envelope" /> Min/Max range</span>}
        </div>
      </figcaption>

      <div className="turn-graph-wrap">
        <svg
          className="turn-graph"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Score timeline graph with range +${maxAbs} to -${maxAbs}`}
        >
          <title>{`Score timeline graph (+${maxAbs} to -${maxAbs})`}</title>
          <desc>
            {latestPoint
              ? `Current score total ${formatSigned(latestPoint.cumulativeTotal, 2)}, range ${formatSigned(latestPoint.minTotal, 2)} to ${formatSigned(latestPoint.maxTotal, 2)}`
              : 'No points recorded yet.'}
          </desc>

          {/* Grid lines and labels */}
          <line className="turn-graph-grid" x1={l} y1={t} x2={w - r} y2={t} vectorEffect="non-scaling-stroke" />
          <text className="turn-graph-axis-text" x={l - 6} y={t + 4} textAnchor="end">+{maxAbs}</text>

          <line className="turn-graph-zero" x1={l} y1={y0} x2={w - r} y2={y0} vectorEffect="non-scaling-stroke" />
          <text className="turn-graph-axis-text" x={l - 6} y={y0 + 4} textAnchor="end">0</text>

          <line className="turn-graph-grid" x1={l} y1={t + innerH} x2={w - r} y2={t + innerH} vectorEffect="non-scaling-stroke" />
          <text className="turn-graph-axis-text" x={l - 6} y={t + innerH + 4} textAnchor="end">−{maxAbs}</text>

          {/* Envelope */}
          {hasEnvelope && envelopePath && (
            <>
              <path d={envelopePath} className="turn-graph-envelope" />
              <polyline points={minLine} className="turn-graph-bound-line" fill="none" vectorEffect="non-scaling-stroke" />
              <polyline points={maxLine} className="turn-graph-bound-line" fill="none" vectorEffect="non-scaling-stroke" />
            </>
          )}

          {/* Expected line (dashed) */}
          {expectedLine && (
            <polyline
              className="turn-graph-line-expected"
              points={expectedLine}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Settled line (solid) */}
          {settledLine && (
            <polyline
              className="turn-graph-line-settled"
              points={settledLine}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Point markers */}
          {points.map((p, i) => {
            const x = xAt(i, count);
            const y = yAt(p.status === 'settled' && p.realizedDelta != null ? p.cumulativeTotal : p.expectedTotal);
            const isLatest = i === count - 1;
            const isSwitch = p.actionKind === 'switch';
            const isTera = p.tera;

            return (
              <g key={`${p.sequence}-${p.turn}-${i}`} className="turn-graph-point">
                {isSwitch ? (
                  <rect
                    x={x - 3}
                    y={y - 3}
                    width={6}
                    height={6}
                    className={`turn-graph-marker-switch${isLatest ? ' marker-latest' : ''}`}
                  >
                    <title>{`Seq ${p.sequence} (T${p.turn} Switch): Total ${formatSigned(p.cumulativeTotal, 2)}`}</title>
                  </rect>
                ) : isTera ? (
                  <polygon
                    points={`${x},${y - 4} ${x + 3.5},${y} ${x},${y + 4} ${x - 3.5},${y}`}
                    className={`turn-graph-marker-tera${isLatest ? ' marker-latest' : ''}`}
                  >
                    <title>{`Seq ${p.sequence} (T${p.turn} Tera Move): Total ${formatSigned(p.cumulativeTotal, 2)}`}</title>
                  </polygon>
                ) : (
                  <circle
                    cx={x}
                    cy={y}
                    r={isLatest ? 3.5 : 2.5}
                    className={`turn-graph-dot${p.status === 'forecast' ? ' dot-forecast' : ' dot-settled'}${isLatest ? ' dot-latest' : ''}`}
                  >
                    <title>{`Seq ${p.sequence} (T${p.turn}): Total ${formatSigned(p.cumulativeTotal, 2)}, expected ${formatSigned(p.expectedTotal, 2)}`}</title>
                  </circle>
                )}
                {/* Sparse X-axis label */}
                {(count <= 8 || i % Math.ceil(count / 8) === 0 || isLatest) && (
                  <text className="turn-graph-x-text" x={x} y={t + innerH + 16} textAnchor="middle">
                    T{p.turn}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Visually hidden accessibility list for screen readers */}
        <ol className="sr-only">
          {points.map((p) => (
            <li key={p.sequence}>
              Decision sequence {p.sequence}, Turn {p.turn}, {p.actionKind} {p.actionId}
              {p.tera ? ' (Terastallized)' : ''}, status {p.status}, settled total {formatSigned(p.cumulativeTotal, 2)},
              expected total {formatSigned(p.expectedTotal, 2)}, range {formatSigned(p.minTotal, 2)} to {formatSigned(p.maxTotal, 2)}.
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}

function OurChoiceList({
  title,
  choices,
  sampledId,
  quantum,
  slots,
  points,
  area,
}: {
  title: string;
  choices: LiveChoice[];
  sampledId?: string;
  quantum?: LiveQuantum;
  slots?: LiveSlot[];
  points?: LiveScorePoint[];
  area?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const recommendedId = useMemo(() => getRecommendedActionId(choices), [choices]);
  const baseScore = useMemo(() => getLatestSettledScore(points) ?? 0, [points]);

  // Sort choices: recommended action first, then highest expected terminal or turn score
  const sortedChoices = useMemo(() => {
    return [...choices].sort((a, b) => {
      const aTerm = a.expectedTerminalScore ?? a.choiceScore;
      const bTerm = b.expectedTerminalScore ?? b.choiceScore;
      return bTerm - aTerm;
    });
  }, [choices]);

  const visibleChoices = showAll ? sortedChoices : sortedChoices.slice(0, 3);

  return (
    <section className={`card choice-list compact${area ? ` theater-${area}` : ''}`}>
      <div className="choice-head-row">
        <h2 className="bench-title">{title}</h2>
        {choices.length > 3 && (
          <button
            type="button"
            className="choice-toggle-btn"
            onClick={() => setShowAll((s) => !s)}
            aria-expanded={showAll}
          >
            {showAll ? 'Show top 3' : `Show all (${choices.length})`}
          </button>
        )}
      </div>

      {choices.length === 0 && <p className="muted">No evaluation yet this battle.</p>}

      <ol className="choice-ol">
        {visibleChoices.map((c, i) => {
          const isSampled = c.id === sampledId;
          const isRecommended = c.id === recommendedId;
          const isTera = c.id.endsWith(':tera') || Boolean(c.cta && c.id.includes('tera'));
          const projectedTotal = baseScore + c.choiceScore;
          const policyWeight = c.policyWeight ?? c.probability ?? 0;
          const displayWidth = displayFraction(policyWeight) * 100;
          const minD = c.minTurnScore != null ? formatSigned(c.minTurnScore, 2) : formatSigned(c.choiceScore, 2);
          const maxD = c.maxTurnScore != null ? formatSigned(c.maxTurnScore, 2) : formatSigned(c.choiceScore, 2);

          return (
            <li
              key={c.id}
              className={`choice-row${isSampled ? ' choice-sampled' : ''}${isRecommended ? ' choice-recommended' : ''}`}
            >
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span className="choice-name">
                    {actionLabel(c.id, slots)}
                    {isTera && <span className="badge-tera">TERA (once)</span>}
                    {isRecommended && <span className="badge-recommended">Recommended</span>}
                    {isSampled && <span className="badge-sampled">Sampled</span>}
                  </span>
                  <span className="choice-score">{formatSigned(c.choiceScore, 2)}</span>
                </div>

                <ScoreBar score={c.choiceScore} parts={c} label={`${actionLabel(c.id, slots)} turn score`} />

                {policyWeight > 0 && (
                  <div
                    className="choice-p"
                    role="meter"
                    aria-label={`${actionLabel(c.id, slots)} QAOA policy weight`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={Number(policyWeight.toFixed(4))}
                    title={quantum ? quantumTitle(quantum) : `Policy weight: ${(policyWeight * 100).toFixed(1)}%`}
                  >
                    <div className="choice-p-fill" style={{ width: `${displayWidth}%` }} />
                  </div>
                )}

                <div className="choice-meta dim">
                  <span>TTK: {formatTTK(c.hitsToKill)}</span>
                  <span>Range: [{minD}, {maxD}]</span>
                  <span>Projected total: {formatSigned(projectedTotal, 2)}</span>
                  {policyWeight > 0 && <span>QAOA: {formatPercent(policyWeight, 1)}</span>}
                  {c.winRate != null && (
                    <span className="choice-win-rate">
                      Win: {formatPercent(c.winRate, 0)} ({formatWilsonInterval(c.winRateLow, c.winRateHigh)})
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TheirReplyList({
  title,
  replies,
  slots,
  area,
}: {
  title: string;
  replies: LiveReply[];
  slots?: LiveSlot[];
  area?: string;
}) {
  const [showAll, setShowAll] = useState(false);

  // Opponent rows: sorted from most harmful to us (lowest score / highest impact against us)
  const sortedReplies = useMemo(() => {
    return [...replies].sort((a, b) => {
      const aScore = a.choiceScore ?? a.expectedImpact;
      const bScore = b.choiceScore ?? b.expectedImpact;
      return aScore - bScore;
    });
  }, [replies]);

  const visibleReplies = showAll ? sortedReplies : sortedReplies.slice(0, 3);

  return (
    <section className={`card choice-list compact${area ? ` theater-${area}` : ''}`}>
      <div className="choice-head-row">
        <h2 className="bench-title">{title}</h2>
        {replies.length > 3 && (
          <button
            type="button"
            className="choice-toggle-btn"
            onClick={() => setShowAll((s) => !s)}
            aria-expanded={showAll}
          >
            {showAll ? 'Show top 3' : `Show all (${replies.length})`}
          </button>
        )}
      </div>

      {replies.length === 0 && <p className="muted">No hypothesized replies yet.</p>}

      <ol className="choice-ol">
        {visibleReplies.map((r, i) => {
          const score = r.choiceScore ?? r.expectedImpact;
          const policyWeight = r.policyWeight ?? r.probability ?? 0;
          const displayWidth = displayFraction(policyWeight) * 100;
          const isTera = r.id.endsWith(':tera');

          return (
            <li key={r.id} className="choice-row">
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span className="choice-name">
                    {actionLabel(r.id, slots)}
                    {isTera && <span className="badge-tera">TERA</span>}
                  </span>
                  <span className="choice-score">{formatSigned(score, 2)}</span>
                </div>

                <ScoreBar score={score} parts={r} label={`${actionLabel(r.id, slots)} reply score`} />

                {policyWeight > 0 && (
                  <div
                    className="choice-p choice-p-opp"
                    role="meter"
                    aria-label={`${actionLabel(r.id, slots)} Opponent model weight`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={Number(policyWeight.toFixed(4))}
                    title={`Opponent model weight: ${(policyWeight * 100).toFixed(1)}%`}
                  >
                    <div className="choice-p-fill choice-p-fill-opp" style={{ width: `${displayWidth}%` }} />
                  </div>
                )}

                <div className="choice-meta dim">
                  <span>TTK on us: {formatTTK(r.hitsToKillUs)}</span>
                  {policyWeight > 0 && <span>Opponent weight: {formatPercent(policyWeight, 1)}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TheaterSkeleton() {
  return (
    <div className="theater-body" aria-busy="true" aria-label="Loading battle">
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="card skeleton-block">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton-row" />)}
        </div>
      ))}
    </div>
  );
}

function quantumTitle(q: { mode: string; nQubits?: number; shots?: number; exact?: boolean }): string {
  const bits = [q.mode];
  if (q.nQubits != null) bits.push(`${q.nQubits} qubits`);
  if (q.exact) bits.push('exact');
  else if (q.shots != null) bits.push(`${q.shots} shots`);
  return bits.join(' · ');
}

function formatEvents(events?: { ts: string; text: string }[]): string {
  if (!events?.length) return '(no updates yet)';
  return events
    .map((e) => {
      const clock = e.ts?.length >= 19 ? e.ts.slice(11, 19) : e.ts;
      return clock ? `${clock}  ${e.text}` : e.text;
    })
    .join('\n');
}

type SetForm = {
  level: string;
  item: string;
  ability: string;
  nature: string;
  teraType: string;
  moves: [string, string, string, string];
};

function formFromSet(set: CanonicalSet): SetForm {
  return {
    level: set.level >= 1 && set.level <= 100 ? String(set.level) : '',
    item: set.item ?? '',
    ability: set.ability ?? '',
    nature: set.nature ?? '',
    teraType: set.teraType ?? '',
    moves: [set.moves[0] ?? '', set.moves[1] ?? '', set.moves[2] ?? '', set.moves[3] ?? ''],
  };
}

function formErrors(form: SetForm): Record<string, string> {
  const err: Record<string, string> = {};
  const level = Number(form.level);
  if (!Number.isFinite(level) || level < 1 || level > 100) err.level = 'Level must be 1–100.';
  if (!form.ability.trim()) err.ability = 'Ability is required.';
  if (!form.nature.trim()) err.nature = 'Nature is required.';
  const moves = form.moves.map((m) => m.trim()).filter(Boolean);
  if (moves.length < 1 || moves.length > 4) err.moves = 'Enter 1–4 moves.';
  return err;
}

function SetDrawer({
  slot,
  format,
  opener,
  onClose,
  onSaved,
}: {
  slot: LiveSlot;
  format: string;
  opener: HTMLElement;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<SetCatalog | null>(null);
  const [form, setForm] = useState<SetForm>(() =>
    formFromSet(
      slot.assumedSet ?? {
        species: slot.speciesId,
        level: slot.level ?? 0,
        item: slot.item ?? '',
        ability: slot.ability ?? '',
        moves: slot.knownMoves ?? [],
        nature: '',
        teraType: slot.teraType,
      },
    ),
  );
  const [pick, setPick] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState('');
  const errors = formErrors(form);

  useEffect(() => {
    let alive = true;
    getSpeciesSets(format, slot.speciesId)
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        const start =
          c.override ?? slot.assumedSet ?? c.candidates.find((r) => r.compatible)?.set ?? c.candidates[0]?.set;
        if (start) setForm(formFromSet(start));
      })
      .catch((err) => {
        if (alive) setServerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [format, slot.speciesId, slot.assumedSet]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = () =>
      [...panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
    const nodes = focusable();
    const firstField = nodes.find((el) => el.tagName === 'SELECT' || el.tagName === 'INPUT') ?? nodes[0];
    firstField?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusable();
      if (!els.length) return;
      const i = els.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        els[els.length - 1]!.focus();
      } else if (!e.shiftKey && i === els.length - 1) {
        e.preventDefault();
        els[0]!.focus();
      }
    }
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
      opener.focus();
    };
  }, [onClose, opener]);

  function blur(field: string) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  function applyCandidate(i: string) {
    setPick(i);
    const row = catalog?.candidates[Number(i)];
    if (row) setForm(formFromSet(row.set));
  }

  async function save() {
    const err = formErrors(form);
    if (Object.keys(err).length) {
      setTouched({ level: true, ability: true, nature: true, moves: true });
      return;
    }
    setBusy('save');
    setServerError('');
    try {
      const moves = form.moves.map((m) => m.trim()).filter(Boolean);
      await putSpeciesSet(format, slot.speciesId, {
        species: slot.assumedSet?.species || catalog?.override?.species || prettySpecies(slot.speciesId),
        level: Number(form.level),
        item: form.item,
        ability: form.ability.trim(),
        moves,
        nature: form.nature.trim(),
        teraType: form.teraType.trim() || undefined,
      });
      onSaved(`Saved assumed set for ${prettySpecies(slot.speciesId)}`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  async function resetOverride() {
    setBusy('reset');
    setServerError('');
    try {
      await deleteSpeciesSet(format, slot.speciesId);
      onSaved(`Reset set overrides for ${prettySpecies(slot.speciesId)}`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Assumed set: ${prettySpecies(slot.speciesId)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2 className="drawer-title">{prettySpecies(slot.speciesId)}</h2>
          <span className="muted">{format}</span>
          <button type="button" className="btn-secondary" onClick={onClose} aria-label="Close drawer">
            ✕
          </button>
        </div>

        {serverError && <p className="theater-alert theater-alert-error" role="alert">{serverError}</p>}
        {slot.setWarning && <p className="theater-alert theater-alert-error" role="alert">{slot.setWarning}</p>}

        <div className="drawer-section">
          <label htmlFor="set-pick" className="form-label">
            Candidates from public pool
          </label>
          <select
            id="set-pick"
            value={pick}
            onChange={(e) => applyCandidate(e.target.value)}
            disabled={!catalog || catalog.candidates.length === 0}
          >
            <option value="">
              {catalog?.candidates.length ? '— select candidate —' : 'No candidates in pool'}
            </option>
            {catalog?.candidates.map((c, i) => (
              <option key={i} value={i}>
                {c.set.moves.join('/')} · {c.set.ability} · {c.set.item || 'no item'}
                {c.probability != null ? ` (${(c.probability * 100).toFixed(0)}% pool freq)` : ''}
                {c.compatible ? '' : ' [incompatible]'}
              </option>
            ))}
          </select>
        </div>

        <div className="drawer-form">
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="set-level">Level</label>
              <input
                id="set-level"
                type="number"
                min={1}
                max={100}
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
                onBlur={() => blur('level')}
              />
              {touched.level && errors.level && <span className="field-err">{errors.level}</span>}
            </div>
            <div className="form-field">
              <label htmlFor="set-item">Item</label>
              <input
                id="set-item"
                type="text"
                value={form.item}
                onChange={(e) => setForm({ ...form, item: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label htmlFor="set-ability">Ability</label>
              <input
                id="set-ability"
                type="text"
                value={form.ability}
                onChange={(e) => setForm({ ...form, ability: e.target.value })}
                onBlur={() => blur('ability')}
              />
              {touched.ability && errors.ability && <span className="field-err">{errors.ability}</span>}
            </div>
            <div className="form-field">
              <label htmlFor="set-nature">Nature</label>
              <input
                id="set-nature"
                type="text"
                value={form.nature}
                onChange={(e) => setForm({ ...form, nature: e.target.value })}
                onBlur={() => blur('nature')}
              />
              {touched.nature && errors.nature && <span className="field-err">{errors.nature}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label htmlFor="set-tera">Tera Type</label>
              <input
                id="set-tera"
                type="text"
                value={form.teraType}
                onChange={(e) => setForm({ ...form, teraType: e.target.value })}
              />
            </div>
          </div>

          <div className="form-field">
            <label>Moves (1–4)</label>
            <div className="move-grid">
              {[0, 1, 2, 3].map((idx) => (
                <input
                  key={idx}
                  type="text"
                  placeholder={`Move ${idx + 1}`}
                  value={form.moves[idx as 0 | 1 | 2 | 3]}
                  onChange={(e) => {
                    const next: [string, string, string, string] = [...form.moves];
                    next[idx as 0 | 1 | 2 | 3] = e.target.value;
                    setForm({ ...form, moves: next });
                  }}
                  onBlur={() => blur('moves')}
                />
              ))}
            </div>
            {touched.moves && errors.moves && <span className="field-err">{errors.moves}</span>}
          </div>
        </div>

        <div className="drawer-actions">
          <button type="button" className="btn-primary" onClick={save} disabled={busy !== ''}>
            {busy === 'save' ? 'Saving…' : 'Save assumption'}
          </button>
          {catalog?.override && (
            <button type="button" className="btn-secondary" onClick={resetOverride} disabled={busy !== ''}>
              {busy === 'reset' ? 'Resetting…' : 'Reset to pool'}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy !== ''}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
