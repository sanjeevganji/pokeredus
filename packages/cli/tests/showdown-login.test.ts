import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHOWDOWN_WS,
  assertionErrorMessage,
  parseLoginResponse,
  resolveShowdownWsUrl,
} from '@pokeredus/bridge';

describe('parseLoginResponse', () => {
  it('accepts a ]json assertion from action.php', () => {
    expect(parseLoginResponse(']{"assertion":"ok-token","actionsuccess":true}')).toEqual({
      assertion: 'ok-token',
    });
  });

  it('rejects ;-prefixed assertions instead of treating them as logged in', () => {
    expect(() => parseLoginResponse(']{"assertion":";2"}')).toThrow(/wrong password/);
    expect(() => parseLoginResponse(']{"assertion":";","actionerror":"unregistered"}')).toThrow(/unregistered/);
    expect(assertionErrorMessage('token')).toBeUndefined();
  });
});

describe('resolveShowdownWsUrl', () => {
  it('defaults empty/garbage to the official wss endpoint', () => {
    expect(resolveShowdownWsUrl()).toBe(DEFAULT_SHOWDOWN_WS);
    expect(resolveShowdownWsUrl('')).toBe(DEFAULT_SHOWDOWN_WS);
    expect(resolveShowdownWsUrl('play.pokemonshowdown.com')).toBe(DEFAULT_SHOWDOWN_WS);
  });

  it('rewrites SockJS http(s) prefixes to a raw websocket path', () => {
    expect(resolveShowdownWsUrl('https://sim3.psim.us/showdown')).toBe(DEFAULT_SHOWDOWN_WS);
    expect(resolveShowdownWsUrl('http://sim3.psim.us:8000/showdown')).toBe(
      'ws://sim3.psim.us:8000/showdown/websocket',
    );
    expect(resolveShowdownWsUrl('wss://sim3.psim.us/showdown/websocket')).toBe(DEFAULT_SHOWDOWN_WS);
  });
});
