// Thin Vite plugin. Engine/Showdown imports live in scenario-handlers.ts and
// are loaded via ssrLoadModule so vite.config itself stays Node-loadable.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export function scenariosApiPlugin(root: string): Plugin {
  return {
    name: 'scenarios-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/scenarios') && !url.startsWith('/api/model/weights')) return next();
        const mod = await server.ssrLoadModule('/server/scenario-handlers.ts') as {
          handleScenarioRequest: (
            root: string,
            req: IncomingMessage,
            res: ServerResponse,
            next: () => void,
          ) => Promise<void>;
        };
        await mod.handleScenarioRequest(root, req, res, next);
      });
    },
  };
}
