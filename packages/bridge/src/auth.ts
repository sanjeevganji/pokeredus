// Showdown auth — guest or named-account login.
//
// Showdown hands the client a `|challstr|` on connect. For a named account we
// POST it to the login API to get an assertion token, then `|/trn name,0,ASSERTION`.
// Guests need no assertion — `|/trn guestname,0,` is enough.
export const SHOWDOWN_ACTION_URL = 'https://play.pokemonshowdown.com/action.php';
export const SHOWDOWN_LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';

/** A randomly-suffixed guest name (no account needed). */
export function guestName(prefix = 'pokeredus'): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000)}`;
}

export function assertionErrorMessage(assertion: string): string | undefined {
  if (!assertion) return 'missing assertion';
  if (!assertion.startsWith(';')) return undefined;
  if (assertion === ';' || assertion === ';1') return 'unregistered username';
  if (assertion === ';2') return 'wrong password';
  const rest = assertion.slice(1).trim();
  return rest || 'login rejected';
}

/** Parse `]{json}` (or bare JSON) from action.php / api/login. Throws on failed assertion. */
export function parseLoginResponse(text: string): { assertion: string } {
  const idx = text.indexOf('{');
  if (idx < 0) throw new Error(`showdown login: no json in response (${text.slice(0, 80)})`);
  const json = JSON.parse(text.slice(idx)) as {
    assertion?: string;
    actionerror?: string;
    actionsuccess?: boolean;
  };
  const assertion = json.assertion ?? '';
  const fail = assertionErrorMessage(assertion);
  if (fail) {
    throw new Error(`showdown login: ${json.actionerror || fail}`);
  }
  if (json.actionerror && json.actionsuccess === false) {
    throw new Error(`showdown login: ${json.actionerror}`);
  }
  return { assertion };
}

/**
 * Exchange a challstr for an assertion token.
 * Tries the documented `/api/login` endpoint, then legacy `action.php`.
 */
export async function getAssertion(user: string, pass: string, challstr: string): Promise<string> {
  const attempts: Array<{ url: string; body: URLSearchParams }> = [
    { url: SHOWDOWN_LOGIN_URL, body: new URLSearchParams({ name: user, pass, challstr }) },
    { url: SHOWDOWN_ACTION_URL, body: new URLSearchParams({ act: 'login', name: user, pass, challstr }) },
  ];
  let last: Error | undefined;
  for (const { url, body } of attempts) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const text = await res.text();
      return parseLoginResponse(text).assertion;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw last ?? new Error('showdown login failed');
}
