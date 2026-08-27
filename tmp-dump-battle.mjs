// one-shot spectator dump of a live Showdown battle log
import { ShowdownClient } from './packages/bridge/src/client.ts';

const room = 'battle-gen9randombattle-2671287078';
const lines = [];
const client = new ShowdownClient({ battleRoom: room, dryRun: true });
client.onEvent((ev) => {
  lines.push({ kind: 'battle', type: ev.type, ev });
});
client.onLobby((ev) => {
  lines.push({ kind: 'lobby', type: ev.type, ev });
});

const orig = client.onMessage?.bind(client);
// tap raw frames by wrapping connect
const raw = [];
await client.connect();
const ws = client.ws ?? client['ws'];
if (ws) {
  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString();
    raw.push(text);
  });
}

await new Promise((r) => setTimeout(r, 8000));
client.close();
console.log('RAW_FRAMES', raw.length);
for (const t of raw) {
  console.log('-----FRAME-----');
  console.log(t.slice(0, 8000));
}
console.log('EVENTS', lines.map((x) => x.type).join(','));
