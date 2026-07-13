// cli.ts — the pokelink entrypoint.
//
// Subcommands:
//   pokelink render-pack --pack <pack.json>
//       Print pack stats (#species, #sets, #edges, byteSizeMB, version).
//   pokelink export-pack [--template <pack.json>] [--out <path>] [--mini]
//       Recompute knowledge-pack edges from template data (TS computeMatchup).
//   pokelink score --replay <transcript.txt> --pack <pack.json> [--biases <b>] [--dry-run]
//       Offline tuning surface: replay a saved battle transcript and print a
//       decision per |request|. Never connects to a server.
//   pokelink live --battle <roomid> --pack <pack.json> [--user <u> --pass <p>] [--dry-run]
//       Connect to play.pokemonshowdown.com and play a real battle, posting
//       chosen moves back over the websocket.
//
// Arg parsing is stdlib-only (no yargs) — ponytail: a tiny parser is enough.
import * as fs from 'node:fs';
import { loadKnowledgePack } from '@pokeredus/pack/load';
import { loadBiases } from '@pokeredus/biases';
import { BattleTracker, type BattleEvent, decideAndAct, type DecideClient, ShowdownClient } from '@pokeredus/bridge';
import type { Biases } from '@pokeredus/biases';
import {
  exportKnowledgePack,
  formatExportSummary,
  resolveExportPaths,
} from './export-pack.js';
import {
  exportTrainingData,
  resolveTrainingOutPath,
  defaultTrainingPackPath,
} from './export-training.js';

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

  if (cmd === 'export-training') {
    const packPath = flags['pack'] ?? defaultTrainingPackPath();
    const outPath = resolveTrainingOutPath(flags['out']);
    if (!fs.existsSync(packPath)) {
      console.error(`export-training: pack not found: ${packPath}`);
      process.exit(1);
    }
    const maxPairs = flags['max-pairs'] ? Number(flags['max-pairs']) : undefined;
    const result = exportTrainingData({ packPath, outPath, maxPairs });
    console.log(`export-training: wrote ${result.samples} sample(s) → ${result.outPath}`);
    return;
  }

  const packPath = flags['pack'] ?? 'knowledge-pack-v1.json';
  const pack = loadKnowledgePack(packPath);

  let biases: Biases = loadBiases(flags['biases']);
  if (bools['dry-run'] || flags['dry-run'] !== undefined) biases = { ...biases, dry_run: true };

  if (cmd === 'render-pack') {
    console.log(pack.summary());
    return;
  }

  if (cmd === 'score') {
    const replay = flags['replay'];
    if (!replay) {
      console.error('score requires --replay <transcript.txt>');
      process.exit(1);
    }
    const tracker = new BattleTracker();
    const log: DecideClient = { send() {} }; // dry-run: decisions are logged, never sent
    const lines = fs.readFileSync(replay, 'utf8').split('\n');
    let turns = 0;
    for (const line of lines) {
      const ev: BattleEvent | null = tracker.applyLine(line);
      if (ev && ev.type === 'request') {
        const state = tracker.toTurnState(pack, { allowThin: true });
        console.log(`\n=== turn ${state.turn} (request) ===`);
        decideAndAct(log, state, pack, biases);
        turns++;
      }
    }
    console.log(`\n[pokelink] replayed ${turns} decision point(s).`);
    return;
  }

  if (cmd === 'live') {
    const battle = flags['battle'];
    if (!battle) {
      console.error('live requires --battle <roomid>');
      process.exit(1);
    }
    const room = battle.startsWith('battle-') ? battle : `battle-${battle}`;
    const client = new ShowdownClient({
      url: flags['url'],
      user: flags['user'],
      pass: flags['pass'],
      battleRoom: room,
      dryRun: biases.dry_run,
    });
    const tracker = new BattleTracker();
    client.onEvent((ev) => {
      tracker.apply(ev);
      if (ev.type === 'request') {
        if (!ev.json.active || ev.json.active.length === 0) return; // team preview — no move yet
        const state = tracker.toTurnState(pack);
        console.log(`\n=== turn ${state.turn} (your move) ===`);
        decideAndAct(client, state, pack, biases);
      }
    });
    console.log(`[pokelink] joining ${room} ...`);
    await client.connect();
    console.log('[pokelink] connected. Waiting for your turn — Ctrl-C to quit.');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        console.log('\n[pokelink] shutting down.');
        client.close();
        resolve();
      });
    });
    return;
  }

  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`pokelink — PokeRedus external battle bridge

Usage:
  pokelink render-pack --pack <pack.json>
  pokelink export-pack [--template <pack.json>] [--out <path>] [--mini] [--max-species <n>]
  pokelink export-training [--pack <pack.json>] [--out <path>] [--max-pairs <n>]
  pokelink score  --replay <transcript.txt> --pack <pack.json> [--biases <biases.json>] [--dry-run]
  pokelink live   --battle <roomid> --pack <pack.json> [--user <u> --pass <p>] [--url <ws>] [--dry-run]

Subcommands:
  render-pack  Print pack stats (#species, #sets, #edges, byteSizeMB, version).
  export-pack      Recompute knowledge-pack edges from template (default: pokeredus/data/knowledge-pack/).
  export-training  Write JSONL training corpus from pack set pairs (demo warm-start).
  score        Offline: replay a saved transcript and print a decision per turn.
  live         Connect to play.pokemonshowdown.com and play a real battle.

Flags:
  --pack <f>     Knowledge Pack JSON (default: knowledge-pack-v1.json).
  --template <f> Source pack for export-pack (default: pokeredus/data/knowledge-pack/knowledge-pack-v1.json).
  --out <f>      Output path for export-pack.
  --mini         Export first 5 species only (export-pack).
  --max-species  Cap species count (export-pack debugging).
  --biases <f>   Biases JSON (default: built-in defaults / biases.json).
  --replay <f>   Transcript file for 'score'.
  --battle <id>  Battle room id (or bare id) for 'live'.
  --user/--pass  Named Showdown account (omit for guest).
  --dry-run      Log the chosen move but never send it.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
