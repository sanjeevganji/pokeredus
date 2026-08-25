// PokeRedus CLI — knowledge-pack tools, Random Battle scoring, live play.
import * as fs from 'node:fs';
import { loadKnowledgePack } from '@pokeredus/pack/load';
import { BattleTracker, decideAndAct, LiveStateWriter, ShowdownClient, type BattleEvent } from '@pokeredus/bridge';
import {
  QuantumPolicyProcess,
  generateRandomSetPool,
  loadPool,
  defaultPoolPath,
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

  if (cmd === 'generate-pool') {
    const samples = flags['samples'] ? Number(flags['samples']) : 64;
    const seed = flags['seed'] ? Number(flags['seed']) : 1;
    const outPath = flags['out'] ?? defaultPoolPath();
    const pool = generateRandomSetPool({ samples, seed, outPath });
    console.log(`generate-pool: ${pool.samples} teams, ${Object.keys(pool.species).length} species → ${outPath}`);
    return;
  }

  const packPath = flags['pack'] ?? 'knowledge-pack-v1.json';
  const dryRun = Boolean(bools['dry-run'] || flags['dry-run'] !== undefined);
  const pool = loadPool(flags['pool'] ?? defaultPoolPath());
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
    await withPolicy(async (proc) => {
      const client = new ShowdownClient({
        url: flags['url'],
        user: flags['user'],
        pass: flags['pass'],
        battleRoom: room,
        dryRun,
      });
      const tracker = new BattleTracker();
      client.onEvent((ev: BattleEvent) => {
        tracker.apply(ev);
        hud.noteEvent(ev);
        hud.fromTracker(tracker);
        if (ev.type === 'request') {
          if (!ev.json.active || ev.json.active.length === 0) return;
          let obs;
          try {
            obs = tracker.toObservation(pool, ourSets, loadSetOverrides());
          } catch (err) {
            console.error('[pokeredus] observation failed:', err);
            hud.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            return;
          }
          hud.fromObservation(obs);
          hud.patch({ status: 'deciding' });
          console.log(`\n=== turn ${obs.turn} (your move) ===`);
          void decideAndAct(client, obs, {
            dryRun,
            policy,
            process: proc,
            seed,
            shots,
            logPath,
          }).then((result) => hud.fromDecision(result)).catch((err) => {
            console.error(err);
            hud.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
          });
        }
      });
      console.log(`[pokeredus] joining ${room} ...`);
      await client.connect();
      hud.patch({ status: 'connected' });
      hud.pushEvent(`joined ${room}`);
      console.log('[pokeredus] connected. Waiting for your turn — Ctrl-C to quit.');
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          console.log('\n[pokeredus] shutting down.');
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
  pokeredus generate-pool [--samples <n>] [--seed <n>] [--out <path>]
  pokeredus score --replay <transcript.txt> [--pool <pool.json>] [--policy quantum|softmax] [--dry-run]
  pokeredus live  --battle <roomid> [--policy quantum|softmax] [--dry-run]

Flags:
  --pack <f>          Knowledge Pack JSON.
  --pool <f>          Empirical Random Battle set pool.
  --our-sets <f>      JSON array of our six known CanonicalSets.
  --policy <m>        quantum (default) or softmax (benchmark only).
  --seed <n>          Policy / pool seed.
  --shots <n>         Finite-shot QAOA (omit for exact).
  --decision-log <f>  Append-only JSONL decision records.
  --live-state <f>    HUD snapshot JSON for the PokeRedus game-state screen.
  --dry-run           Log the chosen move but never send it.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
