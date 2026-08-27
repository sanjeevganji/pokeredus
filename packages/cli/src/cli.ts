// PokeRedus CLI — knowledge-pack tools, Random Battle scoring, live play.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadKnowledgePack } from '@pokeredus/pack/load';
import { BattleTracker, decideAndAct, LiveStateWriter, ShowdownClient, type BattleEvent } from '@pokeredus/bridge';
import {
  QuantumPolicyProcess,
  loadPool,
  defaultPoolPath,
  defaultSetOverridesPath,
  loadSetOverrides,
  type CanonicalSet,
  type PolicyMode,
} from '@pokeredus/engine';
import {
  exportKnowledgePack,
  formatExportSummary,
  resolveExportPaths,
} from './export-pack.js';

interface Args {
  cmd: string;
  flags: Record<string, string>;
  bools: Record<string, boolean>;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: '', flags: {}, bools: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.bools[key] = true;
      }
    } else if (!args.cmd) {
      args.cmd = a;
    }
  }
  return args;
}

function policyMode(flags: Record<string, string>): PolicyMode {
  return flags['policy'] === 'softmax' ? 'softmax' : 'quantum';
}

function agentLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string): void {
  // #region agent log
  fetch('http://127.0.0.1:7559/ingest/6200673b-d438-4c7f-9e45-49a0c341555a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '246bd1' }, body: JSON.stringify({ sessionId: '246bd1', runId: 'post-fix', hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
}

function ourSetsFromFlag(raw?: string): CanonicalSet[] {
  if (!raw) return [];
  return JSON.parse(fs.readFileSync(raw, 'utf8')) as CanonicalSet[];
}

async function withPolicy<T>(fn: (proc: QuantumPolicyProcess) => Promise<T>): Promise<T> {
  const proc = new QuantumPolicyProcess();
  try {
    proc.start();
    return await fn(proc);
  } finally {
    proc.close();
  }
}

async function main(): Promise<void> {
  const { cmd, flags, bools } = parseArgs(process.argv.slice(2));
  if (!cmd) {
    printHelp();
    process.exit(1);
  }

  if (cmd === 'export-pack') {
    const { templatePath, outPath } = resolveExportPaths({
      template: flags['template'],
      out: flags['out'],
      mini: bools['mini'],
    });
    if (!fs.existsSync(templatePath)) {
      console.error(`export-pack: template not found: ${templatePath}`);
      process.exit(1);
    }
    const maxSpecies = flags['max-species'] ? Number(flags['max-species']) : undefined;
    const result = exportKnowledgePack({
      templatePath,
      outPath,
      mini: bools['mini'],
      maxSpecies: Number.isFinite(maxSpecies) ? maxSpecies : undefined,
    });
    console.log(formatExportSummary(result));
    return;
  }

  const packPath = flags['pack'] ?? 'knowledge-pack-v1.json';
  const dryRun = Boolean(bools['dry-run'] || flags['dry-run'] !== undefined);
  const ourSets = ourSetsFromFlag(flags['our-sets']);
  const logPath = flags['decision-log'];
  const seed = flags['seed'] ? Number(flags['seed']) : undefined;
  const shots = flags['shots'] ? Number(flags['shots']) : null;

  if (cmd === 'render-pack') {
    const pack = loadKnowledgePack(packPath);
    console.log(pack.summary());
    return;
  }

  if (cmd === 'score') {
    const replay = flags['replay'];
    if (!replay) {
      console.error('score requires --replay <transcript.txt>');
      process.exit(1);
    }
    const pool = loadPool(flags['pool'] ?? defaultPoolPath());
    await withPolicy(async (proc) => {
      const tracker = new BattleTracker();
      const log = { send() {} };
      const lines = fs.readFileSync(replay, 'utf8').split('\n');
      let turns = 0;
      for (const line of lines) {
        const ev: BattleEvent | null = tracker.applyLine(line);
        if (ev && ev.type === 'request') {
          const obs = tracker.toObservation(pool, ourSets, loadSetOverrides());
          console.log(`\n=== turn ${obs.turn} (request) ===`);
          await decideAndAct(log, obs, {
            dryRun: true,
            policy: policyMode(flags),
            process: proc,
            seed,
            shots,
            logPath,
          });
          turns++;
        }
      }
      console.log(`\n[pokeredus] replayed ${turns} decision point(s).`);
    });
    return;
  }

  if (cmd === 'live') {
    const battle = flags['battle'];
    if (!battle) {
      console.error('live requires --battle <roomid>');
      process.exit(1);
    }
    const room = battle.startsWith('battle-')
      ? battle
      : /^\d+$/.test(battle)
        ? `battle-gen9randombattle-${battle}`
        : `battle-${battle}`;
    const policy = policyMode(flags);
    const hud = new LiveStateWriter({
      path: flags['live-state'] || process.env.POKELINK_STATE,
      room,
      dryRun,
      policy,
    });
    hud.patch({ status: 'connecting' });
    const pool = loadPool(flags['pool'] ?? defaultPoolPath());
    const overridesPath = defaultSetOverridesPath();
    await withPolicy(async (proc) => {
      const client = new ShowdownClient({
        url: flags['url'],
        user: flags['user'],
        pass: flags['pass'],
        battleRoom: room,
        dryRun,
      });
      const tracker = new BattleTracker({ ourName: flags['user'] || '' });
      let decideGen = 0;
      let decideBusy = false;
      let decideQueued = false;
      let queuedSend = false;
      let lastObsKey = '';

      const observe = (settle: boolean) => {
        try {
          const obs = tracker.toObservation(pool, ourSets, loadSetOverrides(overridesPath));
          hud.fromObservation(obs, { settle });
          const oursRevealed = obs.ours.filter((s) => s.revealed).map((s) => s.speciesId);
          const theirsRevealed = obs.theirs.filter((s) => s.revealed).map((s) => s.speciesId);
          const key = `${obs.turn}:${obs.legalActions.length}:${oursRevealed.join(',')}:${theirsRevealed.join(',')}:${Boolean(obs.request)}`;
          if (key !== lastObsKey) {
            lastObsKey = key;
            agentLog('cli.ts:observe', 'observation built', {
              turn: obs.turn,
              ourSide: obs.ourSide,
              legal: obs.legalActions.length,
              oursRevealed,
              theirsRevealed,
              activeSetMoves: obs.ours.find((s) => s.active)?.set?.moves?.length ?? 0,
              hasRequest: Boolean(obs.request),
            }, 'A');
          }
          return obs;
        } catch (err) {
          console.error('[pokeredus] observation failed:', err);
          agentLog('cli.ts:observe', 'observation failed', { error: err instanceof Error ? err.message : String(err) }, 'F');
          hud.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
          return undefined;
        }
      };

      const runDecide = (send: boolean) => {
        const req = tracker.lastRequest;
        const canSend = Boolean(req?.active?.length && !req.wait);
        const obs = observe(false);
        if (!obs) return;
        const ourOk = obs.ours.some((s) => s.active && s.revealed);
        const theirOk = obs.theirs.some((s) => s.active && s.revealed);
        if (!ourOk || !theirOk || !obs.legalActions.length) {
          agentLog('cli.ts:runDecide', 'eval skipped', {
            send, canSend, ourOk, theirOk,
            legal: obs.legalActions.length,
            hasRequest: Boolean(req),
            pokeCount: req?.side?.pokemon?.length ?? 0,
            turn: obs.turn,
            setMoves: obs.ours.find((s) => s.active)?.set?.moves?.length ?? 0,
          }, 'B');
          return;
        }
        const key = `${obs.turn}|${obs.ours.find((s) => s.active)?.speciesId}|${obs.theirs.find((s) => s.active)?.speciesId}|${obs.legalActions.map((a) => a.id).join(',')}|${obs.ours.find((s) => s.active)?.set?.moves?.join(',')}|${obs.theirs.find((s) => s.active)?.set?.moves?.join(',')}`;
        if (!send && key === lastEvalKey) return;
        if (decideBusy) {
          decideQueued = true;
          if (send) queuedSend = true;
          return;
        }
        lastEvalKey = key;
        decideBusy = true;
        const gen = ++decideGen;
        hud.patch({ status: 'deciding' });
        if (send && canSend) console.log(`\n=== turn ${obs.turn} (your move) ===`);
        else console.log(`\n=== turn ${obs.turn} (eval) ===`);
        agentLog('cli.ts:runDecide', 'eval starting', {
          send, canSend, turn: obs.turn, legal: obs.legalActions.length,
          dryRun: send && canSend ? dryRun : true,
        }, 'D');
        void decideAndAct(client, obs, {
          dryRun: send && canSend ? dryRun : true,
          policy,
          process: proc,
          seed,
          shots,
          logPath: send && canSend ? logPath : undefined,
        }).then((result) => {
          agentLog('cli.ts:runDecide', 'eval ok', {
            sampledId: result.sampledId,
            choices: result.evaluation.choices.length,
            replies: result.evaluation.replies.length,
            roundScore: result.evaluation.roundScore,
          }, 'D');
          if (gen === decideGen) hud.fromDecision(result, { rescore: !canSend || !send });
        }).catch((err) => {
          console.error('[pokeredus] engine/quantum failed:', err);
          agentLog('cli.ts:runDecide', 'eval failed', { error: err instanceof Error ? err.message : String(err) }, 'F');
          if (gen === decideGen) hud.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        }).finally(() => {
          decideBusy = false;
          if (decideQueued) {
            decideQueued = false;
            const nextSend = queuedSend;
            queuedSend = false;
            runDecide(nextSend);
          }
        });
      };

      client.onLobby((ev) => {
        if (ev.type === 'updateuser' && ev.name.trim()) tracker.setOurName(ev.name);
        if (ev.type === 'updateuser' || ev.type === 'nametaken' || ev.type === 'popup') {
          agentLog('cli.ts:lobby', ev.type, {
            name: 'name' in ev ? ev.name : undefined,
            named: 'named' in ev ? ev.named : undefined,
            text: 'text' in ev ? String(ev.text).slice(0, 160) : undefined,
            reason: 'reason' in ev ? ev.reason : undefined,
            hasUserFlag: Boolean(flags['user']),
            hasPassFlag: Boolean(flags['pass']),
          }, 'A');
        }
      });

      client.onEvent((ev: BattleEvent) => {
        tracker.apply(ev);
        hud.noteEvent(ev);
        if (ev.type === 'request' || ev.type === 'turn' || ev.type === 'player' || ev.type === 'switch') {
          agentLog('cli.ts:event', ev.type, {
            turn: tracker.turn,
            ourSide: tracker.ourSide,
            wait: ev.type === 'request' ? Boolean(ev.json.wait) : undefined,
            activeLen: ev.type === 'request' ? (ev.json.active?.length ?? 0) : undefined,
            pokeCount: ev.type === 'request' ? (ev.json.side?.pokemon?.length ?? 0) : undefined,
            species: ev.type === 'switch' ? ev.speciesId : undefined,
            side: ev.type === 'switch' || ev.type === 'player' ? ev.side : undefined,
            playerName: ev.type === 'player' ? ev.name : undefined,
          }, ev.type === 'request' ? 'B' : 'A');
        }
        const settle = ev.type === 'turn' || ev.type === 'win';
        observe(settle);
        const canSend = ev.type === 'request' && Boolean(ev.json.active?.length) && !ev.json.wait;
        if (canSend) runDecide(true);
        else if (ev.type === 'request' || ev.type === 'turn' || ev.type === 'switch') runDecide(false);
      });

      const stopWatch = watchOverrides(overridesPath, () => runDecide(false));
      console.log(`[pokeredus] joining ${room} ...`);
      await client.connect();
      hud.patch({ status: 'connected' });
      hud.pushEvent(`joined ${room}`);
      console.log('[pokeredus] connected. Waiting for your turn — Ctrl-C to quit.');
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          console.log('\n[pokeredus] shutting down.');
          stopWatch();
          hud.patch({ status: 'idle' });
          client.close();
          proc.close();
          resolve();
        });
      });
    });
    return;
  }

  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`pokeredus — Random Battle quantum policy CLI

Usage:
  pokeredus render-pack --pack <pack.json>
  pokeredus export-pack [--template <pack.json>] [--out <path>] [--mini]
  pokeredus score --replay <transcript.txt> [--pool <pool.json>] [--policy quantum|softmax] [--dry-run]
  pokeredus live  --battle <roomid> [--policy quantum|softmax] [--dry-run]

Flags:
  --pack <f>          Knowledge Pack JSON.
  --pool <f>          Random Battle set data (pkmn/randbats JSON, default).
  --our-sets <f>      JSON array of our six known CanonicalSets.
  --policy <m>        quantum (default) or softmax (benchmark only).
  --seed <n>          Policy / pool seed.
  --shots <n>         Finite-shot QAOA (omit for exact).
  --decision-log <f>  Append-only JSONL decision records.
  --live-state <f>    HUD snapshot JSON for the PokeRedus game-state screen.
  --dry-run           Log the chosen move but never send it.
`);
}

function watchOverrides(filePath: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  try {
    const dir = path.dirname(filePath) || '.';
    const base = path.basename(filePath);
    const watcher = fs.watch(dir, (_event, name) => {
      if (!name || name === base || String(name).startsWith(`${base}.`)) bump();
    });
    watcher.on('error', () => { /* ignore */ });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => { clearTimeout(timer); };
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
