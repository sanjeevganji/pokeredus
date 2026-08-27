import { connectShowdownWebSocket, closeShowdownWebSocket } from './packages/bridge/src/socket.ts';
import { guestName } from './packages/bridge/src/auth.ts';

const room = 'battle-gen9randombattle-2671287078';
const { ws } = await connectShowdownWebSocket();
const frames = [];
ws.on('message', (data) => {
  const text = typeof data === 'string' ? data : data.toString();
  frames.push(text);
  if (text.includes('|challstr|')) {
    const line = text.split('\n').find((l) => l.includes('|challstr|')) ?? '';
    const challstr = line.split('|').slice(2).join('|');
    void challstr;
    ws.send(`|/trn ${guestName('dump')},0,`);
    ws.send(`|/join ${room}`);
  }
});
await new Promise((r) => setTimeout(r, 10000));
closeShowdownWebSocket(ws);
for (const t of frames) {
  console.log('-----FRAME-----');
  console.log(t);
}
console.log('FRAME_COUNT', frames.length);
