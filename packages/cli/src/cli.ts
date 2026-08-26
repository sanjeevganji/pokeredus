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
      const tracker = new BattleTracker();
      let decideGen = 0;
      let decideBusy = false;
      let decideQueued = false;
      let queuedSend = false;

      const observe = (settle: boolean) => {
        try {
          const obs = tracker.toObservation(pool, ourSets, loadSetOverrides(overridesPath));
          hud.fromObservation(obs, { settle });
          return obs;
        } catch (err) {
          console.error('[pokeredus] observation failed:', err);
          hud.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
          return undefined;
        }
      };

      const runDecide = (send: boolean) => {
        if (!tracker.lastRequest?.active?.length) {
          observe(false);
          return;
        }
        if (decideBusy) {
          decideQueued = true;
          if (send) queuedSend = true;
          return;
        }
        const obs = observe(send);
        if (!obs) return;
        decideBusy = true;
        const gen = ++decideGen;
        hud.patch({ status: 'deciding' });
        if (send) console.log(`\n=== turn ${obs.turn} (your move) ===`);
        void decideAndAct(client, obs, {
          dryRun: send ? dryRun : true,
          policy,
          process: proc,
          seed,
          shots,
          logPath: send ? logPath : undefined,
        }).then((result) => {
          if (gen === decideGen) hud.fromDecision(result, { rescore: !send });
        }).catch((err) => {
          console.error(err);
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

      client.onEvent((ev: BattleEvent) => {
        tracker.apply(ev);
        hud.noteEvent(ev);
        hud.fromTracker(tracker);
        if (ev.type === 'request' && ev.json.active && ev.json.active.length > 0) runDecide(true);
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
