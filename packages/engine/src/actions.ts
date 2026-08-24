import { actionId, type LegalAction } from './observation.js';

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

export function enumerateFromRequest(req: ShowdownRequest | undefined | null): LegalAction[] {
  if (!req || req.wait) return [];
  const pokemon = req.side?.pokemon ?? [];
  const force = req.forceSwitch?.[0] === true;
  const trapped = req.active?.[0]?.trapped === true;
  const actions: LegalAction[] = [];

  if (!force && req.active?.[0]) {
    for (const mv of req.active[0].moves ?? []) {
      if (!mv?.id || mv.disabled || mv.pp <= 0) continue;
      actions.push({ id: actionId({ type: 'move', moveId: mv.id }), type: 'move', moveId: mv.id, tera: false });
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

export function formatChoice(a: LegalAction): string {
  if (a.type === 'switch') return `|/choose switch ${a.slot ?? 1}`;
  return `|/choose move ${a.moveId ?? ''}${a.tera ? ' terastallize' : ''}`;
}

export function simChoice(a: LegalAction): string {
  if (a.type === 'switch') return `switch ${a.slot ?? 1}`;
  return `move ${a.moveId ?? ''}${a.tera ? ' terastallize' : ''}`;
}
