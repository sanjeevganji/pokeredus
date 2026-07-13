import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PackIndex } from '@pokeredus/pack';
import type { KnowledgeGraph } from '@pokeredus/core';
import { loadPack } from '../lib/pack';

interface PackCtx {
  pack: PackIndex | null;
  kg: KnowledgeGraph | null;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<PackCtx>({ pack: null, kg: null, loading: true, error: null });

export function PackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PackCtx>({ pack: null, kg: null, loading: true, error: null });

  useEffect(() => {
    loadPack()
      .then(({ pack, kg }) => setState({ pack, kg, loading: false, error: null }))
      .catch((e) => setState({ pack: null, kg: null, loading: false, error: String(e) }));
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function usePack() {
  return useContext(Ctx);
}
