from pathlib import Path

p = Path(__file__).with_name("BattleLive.tsx")
text = p.read_text(encoding="utf-8")
start = text.index("function OurChoiceList(")
end = text.index("function TheaterSkeleton()")
new = r'''function TeraToggle({
  on,
  available,
  type,
  onToggle,
}: {
  on: boolean;
  available: boolean;
  type?: string;
  onToggle: (next: boolean) => void;
}) {
  if (!available && !on) return null;
  const label = type ? `Tera ${type}` : 'Terastallize';
  return (
    <button
      type="button"
      className={`tera-switch${on ? ' tera-switch-on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={!available}
      onClick={() => onToggle(!on)}
    >
      <span className="tera-switch-track" aria-hidden="true">
        <span className="tera-switch-knob" />
      </span>
      <span className="tera-switch-label">{label}</span>
    </button>
  );
}

function hpFrac(slot?: LiveSlot): number | undefined {
  if (!slot?.revealed || slot.fainted || !(slot.maxHp > 0)) return undefined;
  return slot.hp / slot.maxHp;
}

function OurChoiceList({
  title,
  choices,
  sampledId,
  quantum,
  slots,
  foe,
  teraUsed,
  area,
}: {
  title: string;
  choices: LiveChoice[];
  sampledId?: string;
  quantum?: LiveQuantum;
  slots?: LiveSlot[];
  foe?: LiveSlot;
  teraUsed?: boolean;
  area?: string;
}) {
  const [teraOn, setTeraOn] = useState(false);
  const canTera = !teraUsed && choices.some((c) => isTeraAction(c.id));
  const teraType = slots?.find((s) => s.active)?.teraType
    || slots?.find((s) => s.active)?.assumedSet?.teraType;
  const visible = useMemo(() => {
    const rows = playableChoices(choices, teraOn && canTera, slots);
    return [...rows].sort((a, b) => {
      const aTerm = a.expectedTerminalScore ?? a.choiceScore;
      const bTerm = b.expectedTerminalScore ?? b.choiceScore;
      return bTerm - aTerm;
    });
  }, [choices, teraOn, canTera, slots]);
  const mass = useMemo(() => normalizeMass(visible), [visible]);
  const recommendedId = useMemo(() => getRecommendedActionId(visible), [visible]);
  const sampledBase = sampledId ? baseActionId(sampledId) : '';
  const foeHp = hpFrac(foe);

  return (
    <section className={`card choice-list compact${area ? ` theater-${area}` : ''}`}>
      <div className="choice-head-row">
        <h2 className="bench-title">{title}</h2>
        <TeraToggle
          on={teraOn && canTera}
          available={canTera}
          type={teraType}
          onToggle={setTeraOn}
        />
      </div>

      {choices.length === 0 && <p className="muted">No evaluation yet this battle.</p>}

      <ol className="choice-ol">
        {visible.map((c, i) => {
          const isSampled = sampledBase !== '' && baseActionId(c.id) === sampledBase;
          const isRecommended = recommendedId != null && baseActionId(c.id) === baseActionId(recommendedId);
          const p = mass[i] ?? 0;
          const ttk = workingHitsToKill(c.hitsToKill, foeHp, c.theirHealth);
          const ko = formatKO(ttk);
          const connect = c.type === 'move' ? formatConnect(c.cta) : '';
          const range = formatScoreRange(c.minTurnScore, c.maxTurnScore, c.choiceScore);

          return (
            <li
              key={c.id}
              className={`choice-row${isSampled ? ' choice-sampled' : ''}${isRecommended ? ' choice-recommended' : ''}`}
            >
              {p > 0 && (
                <div
                  className="choice-q-fill"
                  style={{ width: `${p * 100}%` }}
                  title={quantum ? quantumTitle(quantum) : undefined}
                />
              )}
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span className="choice-name">
                    {actionLabel(c.id, slots)}
                    {isRecommended && <span className="badge-recommended">Recommended</span>}
                    {isSampled && <span className="badge-sampled">Sampled</span>}
                  </span>
                  <span className="choice-score" title="Worst to best this turn">{range}</span>
                </div>

                <ScoreBar score={c.choiceScore} parts={c} label={`${actionLabel(c.id, slots)} turn score`} />

                <div className="choice-meta dim">
                  {ko ? <span>{ko}</span> : null}
                  {connect ? <span>{connect}</span> : null}
                  {p > 0 ? (
                    <span title={quantum ? quantumTitle(quantum) : 'Policy mass'}>
                      {formatPercent(p, 0)}
                    </span>
                  ) : null}
                  {c.winRate != null && (
                    <span className="choice-win-rate">
                      Win {formatPercent(c.winRate, 0)}
                      {formatWilsonInterval(c.winRateLow, c.winRateHigh)
                        ? ` (${formatWilsonInterval(c.winRateLow, c.winRateHigh)})`
                        : ''}
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
  us,
  teraUsed,
  area,
}: {
  title: string;
  replies: LiveReply[];
  slots?: LiveSlot[];
  us?: LiveSlot;
  teraUsed?: boolean;
  area?: string;
}) {
  const [teraOn, setTeraOn] = useState(false);
  const canTera = !teraUsed && replies.some((r) => isTeraAction(r.id));
  const teraType = slots?.find((s) => s.active)?.teraType
    || slots?.find((s) => s.active)?.assumedSet?.teraType;
  const visible = useMemo(() => {
    const rows = playableChoices(replies, teraOn && canTera, slots);
    return [...rows].sort((a, b) => {
      const aScore = a.choiceScore ?? a.expectedImpact;
      const bScore = b.choiceScore ?? b.expectedImpact;
      return aScore - bScore;
    });
  }, [replies, teraOn, canTera, slots]);
  const mass = useMemo(() => normalizeMass(visible), [visible]);
  const ourHp = hpFrac(us);

  return (
    <section className={`card choice-list compact${area ? ` theater-${area}` : ''}`}>
      <div className="choice-head-row">
        <h2 className="bench-title">{title}</h2>
        <TeraToggle
          on={teraOn && canTera}
          available={canTera}
          type={teraType}
          onToggle={setTeraOn}
        />
      </div>

      {replies.length === 0 && <p className="muted">No hypothesized replies yet.</p>}

      <ol className="choice-ol">
        {visible.map((r, i) => {
          const score = r.choiceScore ?? r.expectedImpact;
          const p = mass[i] ?? 0;
          const ttk = workingHitsToKill(r.hitsToKillUs, ourHp, r.ourHealth);
          const ko = formatKO(ttk, true);
          const range = formatScoreRange(r.minTurnScore, r.maxTurnScore, score);

          return (
            <li key={r.id} className="choice-row">
              {p > 0 && <div className="choice-q-fill choice-q-fill-opp" style={{ width: `${p * 100}%` }} />}
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span className="choice-name">{actionLabel(r.id, slots)}</span>
                  <span className="choice-score" title="Worst to best this turn">{range}</span>
                </div>

                <ScoreBar score={score} parts={r} label={`${actionLabel(r.id, slots)} reply score`} />

                <div className="choice-meta dim">
                  {ko ? <span>{ko}</span> : null}
                  {p > 0 ? <span>{formatPercent(p, 0)}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

'''
p.write_text(text[:start] + new + text[end:], encoding="utf-8")
print("replaced", start, "to", end)
