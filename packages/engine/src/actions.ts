import {
  actionId,
  observationTera,
  type CanonicalSet,
  type LegalAction,
  type SlotSnapshot,
} from './observation.js';

export interface RequestMove {
  move: string;
  id: string;
  pp: number;
  maxpp: number;
  disabled: boolean;
}

export interface RequestPokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  moves: Array<RequestMove | string>;
}

export interface RequestActive {
  moves: RequestMove[];
  canTerastallize?: boolean | string;
  trapped?: boolean;
}

export interface ShowdownRequest {
  wait?: boolean;
  forceSwitch?: boolean[];
  active?: RequestActive[];
  side: { id?: string; pokemon: RequestPokemon[] };
}

function fainted(condition: string): boolean {
  const c = (condition || '').toLowerCase();
  return c.includes('fnt') || c.startsWith('0 ');
}

export function toMoveId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function movesFromPokemon(p: RequestPokemon | undefined): RequestMove[] {
  const out: RequestMove[] = [];
  for (const m of p?.moves ?? []) {
    if (typeof m === 'string') {
      const id = toMoveId(m);
      if (id) out.push({ move: m, id, pp: 1, maxpp: 1, disabled: false });
    } else if (m?.id || m?.move) {
      out.push({ ...m, id: m.id || toMoveId(m.move) });
    }
  }
  return out;
}

function pushMove(actions: LegalAction[], moveId: string, tera: boolean): void {
  const id = toMoveId(moveId);
  if (!id) return;
  actions.push({ id: actionId({ type: 'move', moveId: id, tera }), type: 'move', moveId: id, tera });
}

/** Legal actions we can send. `wait` requests yield nothing. */
export function enumerateFromRequest(req: ShowdownRequest | undefined | null, teraUsed = false): LegalAction[] {
  return enumerateRequest(req, teraUsed, false);
}

/** Legal actions for scoring, including wait requests that still list our team. */
export function enumerateForEval(req: ShowdownRequest | undefined | null, teraUsed = false): LegalAction[] {
  return enumerateRequest(req, teraUsed, true);
}

function enumerateRequest(
  req: ShowdownRequest | undefined | null,
  teraUsed: boolean,
  allowWait: boolean,
): LegalAction[] {
  if (!req) return [];
  if (req.wait && !allowWait) return [];
  const pokemon = req.side?.pokemon ?? [];
  const force = req.forceSwitch?.[0] === true;
  const trapped = req.active?.[0]?.trapped === true;
  const actions: LegalAction[] = [];
  const activeBlock = req.active?.[0];
  const poke = pokemon.find((p) => p.active) ?? pokemon[0];
  const listed = activeBlock?.moves?.length ? activeBlock.moves : movesFromPokemon(poke);

  if (!force && listed.length) {
    const canTera = !teraUsed && Boolean(activeBlock?.canTerastallize);
    for (const mv of listed) {
      const id = typeof mv === 'string' ? toMoveId(mv) : (mv.id || toMoveId(mv.move));
      if (!id) continue;
      if (typeof mv !== 'string' && (mv.disabled || mv.pp <= 0)) continue;
      pushMove(actions, id, false);
      if (canTera) pushMove(actions, id, true);
    }
  }

  if (!trapped) {
    for (let i = 0; i < pokemon.length; i++) {
      const p = pokemon[i]!;
      if (p.active || fainted(p.condition)) continue;
      actions.push({
        id: actionId({ type: 'switch', slot: i + 1 }),
        type: 'switch',
        slot: i + 1,
        forced: force,
      });
    }
  }
  return actions;
}

export function slotsWithActiveSet(slots: SlotSnapshot[], set: CanonicalSet | undefined): SlotSnapshot[] {
  if (!set) return slots;
  return slots.map((s) => {
    if (!s.active) return s;
    return {
      ...s,
      set,
      knownMoves: set.moves?.length ? set.moves : s.knownMoves,
      teraType: s.teraType ?? set.teraType,
    };
  });
}

function livingRevealedSwitches(slots: SlotSnapshot[], forced: boolean): LegalAction[] {
  const fielded = slots.find((s) => s.active) ?? (forced ? slots[0] : undefined);
  const out: LegalAction[] = [];
  for (const s of slots) {
    if (fielded && s.slot === fielded.slot) continue;
    if (s.active || s.fainted || !s.revealed || s.hp <= 0) continue;
    out.push({
      id: actionId({ type: 'switch', slot: s.slot + 1 }),
      type: 'switch',
      slot: s.slot + 1,
      forced: forced || undefined,
    });
  }
  return out;
}

export function legalFromSlots(ours: SlotSnapshot[], teraUsed = false): LegalAction[] {
  const active = ours.find((s) => s.active);
  const forced = !active || active.fainted || active.hp <= 0;
  if (forced) return livingRevealedSwitches(ours, true);

  const canTera = !teraUsed && Boolean(active.teraType) && !active.terastallized;
  const isChoiceLocked = Boolean(active.choiceLock);
  const isTrapped = Boolean(active.trapped);

  const moveIds: string[] = [];
  const seen = new Set<string>();
  const take = (raw: string[]) => {
    for (const m of raw) {
      const id = toMoveId(m);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      moveIds.push(id);
    }
  };
  if (active.moveSlots && active.moveSlots.length > 0) {
    take(active.moveSlots.filter((ms) => !ms.disabled && ms.pp > 0).map((ms) => ms.id));
  } else if (active.set?.moves?.length) {
    take(active.set.moves);
  } else {
    take(active.knownMoves ?? []);
  }

  const moves: LegalAction[] = [];
  for (const moveId of moveIds) {
    if (isChoiceLocked && moveId !== toMoveId(active.choiceLock ?? '')) continue;
    pushMove(moves, moveId, false);
    if (canTera) pushMove(moves, moveId, true);
  }

  const switches = isTrapped ? [] : livingRevealedSwitches(ours, false);
  return [...moves, ...switches];
}

export function legalActionsForEval(obs: {
  ours: SlotSnapshot[];
  request?: unknown;
  teraUsedOurs?: boolean;
  teraUsed?: boolean;
}): LegalAction[] {
  const tera = observationTera(obs);
  const fromReq = enumerateForEval(obs.request as ShowdownRequest | undefined, tera.ours);
  if (fromReq.length) return fromReq;
  return legalFromSlots(obs.ours, tera.ours);
}

export function formatChoice(a: LegalAction): string {
  if (a.type === 'switch') return `|/choose switch ${a.slot ?? 1}`;
  return `|/choose move ${a.moveId ?? ''}${a.tera ? ' terastallize' : ''}`;
}

export function simChoice(a: LegalAction): string {
  if (a.type === 'switch') return `switch ${a.slot ?? 1}`;
  return `move ${a.moveId ?? ''}${a.tera ? ' terastallize' : ''}`;
}
