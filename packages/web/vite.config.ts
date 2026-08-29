import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenariosApiPlugin } from './server/scenarios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function teamsApiPlugin(): Plugin {
  const teamsDir = path.join(root, 'pokeredus/data/teams');
  return {
    name: 'teams-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/teams')) return next();
        const url = new URL(req.url, 'http://localhost');
        const id = url.pathname.replace(/^\/api\/teams\/?/, '').replace(/\.json$/, '');

        if (req.method === 'GET' && !id) {
          const files = fs.readdirSync(teamsDir).filter((f) => f.endsWith('.json'));
          const teams = files.map((f) => {
            const stem = f.replace(/\.json$/, '');
            const data = JSON.parse(fs.readFileSync(path.join(teamsDir, f), 'utf8'));
            return { team_id: stem, ...data };
          });
          teams.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(teams));
          return;
        }

        if (req.method === 'GET' && id) {
          const fp = path.join(teamsDir, `${id}.json`);
          if (!fs.existsSync(fp)) { res.statusCode = 404; res.end('not found'); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(fp, 'utf8'));
          return;
        }

        if (req.method === 'POST' || req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const teamId = body.team_id || id || 'untitled_team';
              const fp = path.join(teamsDir, `${teamId}.json`);
              const { team_id: _, ...rest } = body;
              fs.writeFileSync(fp, JSON.stringify(rest, null, 2), 'utf8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ team_id: teamId, ...rest }));
            } catch (e) {
              res.statusCode = 400;
              res.end(String(e));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

// Thin wrapper. Engine/Showdown imports live in server/games.ts and load via
// ssrLoadModule so vite.config itself stays Node-loadable (same as scenarios.ts).
function gamesApiPlugin(root: string): Plugin {
  // ponytail: intercepted TLS on some Windows boxes breaks undici/ws verify. Set NODE_EXTRA_CA_CERTS to drop this.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
  return {
    name: 'games-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (url !== '/api/live' && !url.startsWith('/api/live?') && !url.startsWith('/api/games')) {
          return next();
        }
        const mod = await server.ssrLoadModule('/server/games.ts') as {
          handleGamesRequest: (
            root: string,
            req: IncomingMessage,
            res: ServerResponse,
            next: () => void,
          ) => Promise<void>;
        };
        await mod.handleGamesRequest(root, req, res, next);
      });
    },
  };
}

function clientNodeStubs(): Plugin {
  const stubs: Record<string, string> = {
    'node:fs': path.resolve(__dirname, 'src/stubs/fs.ts'),
    'node:crypto': path.resolve(__dirname, 'src/stubs/crypto.ts'),
    'node:path': path.resolve(__dirname, 'src/stubs/path.ts'),
  };
  return {
    name: 'client-node-stubs',
    enforce: 'pre',
    resolveId(id, _importer, opts) {
      if (opts?.ssr) return null;
      if (stubs[id]) return stubs[id];
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), clientNodeStubs(), teamsApiPlugin(), gamesApiPlugin(root), scenariosApiPlugin(root)],
  resolve: {
    alias: {
      '@pokeredus/pack/schema': path.resolve(__dirname, '../pack/src/schema.ts'),
      '@pokeredus/pack/load': path.resolve(__dirname, '../pack/src/load.ts'),
      '@pokeredus/pack': path.resolve(__dirname, '../pack/src/index.ts'),
      '@pokeredus/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@pokeredus/engine': path.resolve(__dirname, '../engine/src/index.ts'),
      '@pokeredus/calc': path.resolve(__dirname, '../calc/src/index.ts'),
    },
  },
  server: {
    fs: { allow: [root] },
  },
});
