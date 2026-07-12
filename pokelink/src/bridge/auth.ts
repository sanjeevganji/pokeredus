// Showdown auth — guest or named-account login.
//
// Showdown hands the client a `|challstr|` on connect. For a named account we
// POST it to action.php to get an assertion token, then `|/trn name,0,ASSERTION`.
// Guests need no assertion — `|/trn guestname,0,` is enough.
import type { BattleEvent } from './protocol.js';

export const SHOWDOWN_ACTION_URL = 'https://play.pokemonshowdown.com/action.php';

/** A randomly-suffixed guest name (no account needed). */
export function guestName(prefix = 'pokelink'): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Exchange a challstr for an assertion token via action.php (act=login).
 * Returns the `assertion` string. Throws on network/parse failure so the
 * caller can fall back to a guest login.
 */
export async function getAssertion(user: string, pass: string, challstr: string): Promise<string> {
  const body = new URLSearchParams({ act: 'login', name: user, pass, challstr });
  const res = await fetch(SHOWDOWN_ACTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  const idx = text.indexOf('{');
  if (idx < 0) throw new Error(`showdown login: no json in response (${text.slice(0, 80)})`);
  const json = JSON.parse(text.slice(idx)) as { assertion?: string };
  if (!json.assertion) throw new Error('showdown login: missing assertion');
  return json.assertion;
}
