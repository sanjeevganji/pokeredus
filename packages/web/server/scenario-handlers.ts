import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BattleTracker } from '../../bridge/src/protocol';
import type { BattleObservation, RoundEvaluation } from '../../engine/src/observation';
import { DEFAULT_WEIGHTS, emptyFeatures, scoredChoice, type ScoreWeights } from '../../engine/src/math';
import { defaultPoolPath, loadPool } from '../../engine/src/pool';
import { evaluateRound } from '../../engine/src/evaluate';
import { QuantumPolicyProcess } from '../../engine/src/policy';
import { estimateWinrate, playTurn } from '../../engine/src/scenario';
import { elasticUpdate, loadWeights, resetWeights, saveWeights, type ElasticDiagnostics, type RankedChoice } from '../../engine/src/weights';
import type { EvaluateOptions } from '../../engine/src/evaluate';

export interface SavedScenario {
  id: string;
  name: string;
  source: 'live' | 'transcript' | 'custom';
  createdAt: string;
  observation: BattleObservation;
  rankOurs?: string[];
  rankTheirs?: string[];
  notes?: string;
}

export interface ScenarioMeta {
  id: string;
  name: string;
  source: SavedScenario['source'];
  createdAt: string;
  turn: number;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function publicEval(ev: RoundEvaluation): Omit<RoundEvaluation, 'pairs'> {
  const { pairs: _pairs, ...rest } = ev;
  return rest;
}

let proc: QuantumPolicyProcess | null = null;

function policy(root: string): QuantumPolicyProcess {
  if (!proc) {
    proc = new QuantumPolicyProcess({
      cwd: path.join(root, 'quantum-policy'),
      timeoutMs: 8000,
    });
  }
  return proc;
}

export async function handleScenarioRequest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const dir = path.join(root, 'data', 'scenarios');
  const weightsPath = path.join(root, 'score-weights.json');
  const url = req.url ?? '';
  const route = (url.split('?')[0] ?? url).replace(/\/$/, '') || '/';

  function evalOpts() {
    return {
      weights: loadWeights(weightsPath),
      refine: policy(root),
      refineFallback: 'softmax' as const,
    };
  }

  function listFiles(): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  }

  function readScenario(id: string): SavedScenario | null {
    const fp = path.join(dir, `${id}.json`);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8')) as SavedScenario;
    } catch {
      return null;
    }
  }

  function writeScenario(s: SavedScenario): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n', 'utf8');
  }

  function newId(): string {
    return `s-${Date.now().toString(36)}`;
  }

  function liveObsPath(): string {
    const state = process.env.POKELINK_STATE || path.join(root, 'live-state.json');
    return path.join(path.dirname(path.resolve(state)), 'live-observation.json');
  }

  async function importLive(name?: string): Promise<SavedScenario> {
    const fp = liveObsPath();
    if (!fs.existsSync(fp)) throw new Error('No live observation. Attach a battle and wait for a decision first.');
    const observation = JSON.parse(fs.readFileSync(fp, 'utf8')) as BattleObservation;
    if (!observation?.ours) throw new Error('live-observation.json is not a battle snapshot.');
    const s: SavedScenario = {
      id: newId(),
      name: name || `Live turn ${observation.turn ?? '?'}`,
      source: 'live',
      createdAt: new Date().toISOString(),
      observation,
    };
    writeScenario(s);
    return s;
  }

  async function importTranscript(text: string, name?: string): Promise<SavedScenario> {
    const tracker = new BattleTracker();
    let last: BattleObservation | null = null;
    const pool = loadPool(defaultPoolPath());
    for (const line of text.split(/\r?\n/)) {
      const ev = tracker.applyLine(line);
      if (ev && ev.type === 'request') {
        try { last = tracker.toObservation(pool, []); }
        catch { /* incomplete request */ }
      }
    }
    if (!last) throw new Error('Transcript had no usable |request| turn.');
    const s: SavedScenario = {
      id: newId(),
      name: name || `Transcript turn ${last.turn}`,
      source: 'transcript',
      createdAt: new Date().toISOString(),
      observation: last,
    };
    writeScenario(s);
    return s;
  }

  try {
    if (req.method === 'GET' && route === '/api/model/weights') {
      sendJson(res, loadWeights(weightsPath));
      return;
    }
    if (req.method === 'PUT' && route === '/api/model/weights') {
      const body = await readJsonBody(req);
      if (body.reset) {
        sendJson(res, resetWeights(weightsPath));
        return;
      }
      saveWeights({ ...DEFAULT_WEIGHTS, ...body } as ScoreWeights, weightsPath);
      sendJson(res, loadWeights(weightsPath));
      return;
    }
    if (!route.startsWith('/api/scenarios')) {
      next();
      return;
    }

    if (req.method === 'GET' && route === '/api/scenarios') {
      const items: ScenarioMeta[] = [];
      for (const f of listFiles()) {
        const s = readScenario(f.replace(/\.json$/, ''));
        if (!s) continue;
        items.push({
          id: s.id, name: s.name, source: s.source, createdAt: s.createdAt,
          turn: s.observation?.turn ?? 0,
        });
      }
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      sendJson(res, items);
      return;
    }

    if (req.method === 'POST' && route === '/api/scenarios/import') {
      const body = await readJsonBody(req);
      const source = body.source === 'transcript' ? 'transcript' : 'live';
      const name = typeof body.name === 'string' ? body.name : undefined;
      const s = source === 'transcript'
        ? await importTranscript(String(body.text ?? ''), name)
        : await importLive(name);
      sendJson(res, s);
      return;
    }

    const idMatch = route.match(/^\/api\/scenarios\/([^/]+)(?:\/(eval|rank|play|winrate))?$/);
    if (!idMatch) {
      next();
      return;
    }
    const id = decodeURIComponent(idMatch[1]!);
    const action = idMatch[2];

    if (req.method === 'GET' && !action) {
      const s = readScenario(id);
      if (!s) { sendJson(res, { error: 'not found' }, 404); return; }
      sendJson(res, s);
      return;
    }

    if (req.method === 'PUT' && !action) {
      const body = await readJsonBody(req);
      const prev = readScenario(id);
      if (!prev) { sendJson(res, { error: 'not found' }, 404); return; }
      const nextSc: SavedScenario = {
        ...prev,
        name: typeof body.name === 'string' ? body.name : prev.name,
        notes: typeof body.notes === 'string' ? body.notes : prev.notes,
        observation: (body.observation as BattleObservation) ?? prev.observation,
        rankOurs: Array.isArray(body.rankOurs) ? body.rankOurs.map(String) : prev.rankOurs,
        rankTheirs: Array.isArray(body.rankTheirs) ? body.rankTheirs.map(String) : prev.rankTheirs,
      };
      writeScenario(nextSc);
      sendJson(res, nextSc);
      return;
    }

    if (req.method === 'DELETE' && !action) {
      const fp = path.join(dir, `${id}.json`);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      sendJson(res, { ok: true });
      return;
    }

    if (req.method !== 'POST' || !action) {
      next();
      return;
    }
    const s = readScenario(id);
    if (!s) { sendJson(res, { error: 'not found' }, 404); return; }
    const body = await readJsonBody(req);

    if (action === 'eval') {
      const ev = await evaluateRound(s.observation, evalOpts());
      sendJson(res, { eval: publicEval(ev), weights: loadWeights(weightsPath) });
      return;
    }

    if (action === 'rank') {
      const side = body.side === 'theirs' ? 'theirs' : 'ours';
      const order = Array.isArray(body.order) ? body.order.map(String) : [];
      const ev = await evaluateRound(s.observation, evalOpts());
      const rows = side === 'ours' ? ev.choices : ev.replies;
      const ranked = order.map((oid) => {
        const row = rows.find((r) => r.action.id === oid);
        if (!row || !row.features) return null;
        return { id: oid, score: row.choiceScore, features: row.features };
      }).filter((x): x is NonNullable<typeof x> => Boolean(x));
      const nextW = elasticUpdate(loadWeights(weightsPath), ranked);
      saveWeights(nextW, weightsPath);
      if (side === 'ours') s.rankOurs = order;
      else s.rankTheirs = order;
      writeScenario(s);
      const ev2 = await evaluateRound(s.observation, evalOpts());
      sendJson(res, { eval: publicEval(ev2), weights: nextW, scenario: s });
      return;
    }

    if (action === 'play') {
      const facing = body.side === 'theirs' ? 'theirs' : 'ours';
      const actionId = String(body.actionId ?? '');
      const played = await playTurn(s.observation, actionId, facing, evalOpts());
      s.observation = played.observation;
      writeScenario(s);
      const ev = await evaluateRound(s.observation, evalOpts());
      sendJson(res, {
        scenario: s,
        eval: publicEval(ev),
        sampledOpp: played.sampledOpp,
        weWin: played.weWin,
        theyWin: played.theyWin,
      });
      return;
    }

    if (action === 'winrate') {
      const n = typeof body.n === 'number' ? body.n : 16;
      const wr = await estimateWinrate(s.observation, {
        n,
        maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : 12,
        chanceSeeds: 1,
        weights: loadWeights(weightsPath),
      });
      sendJson(res, wr);
      return;
    }

    next();
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
