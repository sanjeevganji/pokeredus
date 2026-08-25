export function canonicalizeSet(set: CanonicalSet): string {
  const moves = [...set.moves].map((m) => m.toLowerCase()).sort().join(',');
  return [
    set.species.toLowerCase().replace(/[^a-z0-9]/g, ''),
    (set.item || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    (set.ability || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    moves,
    String(set.level || 0),
    (set.teraType || '').toLowerCase(),
  ].join('|');
}

export function compatible(set: CanonicalSet, facts: RevealedFacts): boolean {
  const species = set.species.toLowerCase().replace(/[^a-z0-9]/g, '');
  const factSpecies = facts.species.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (species !== factSpecies) return false;
  if (facts.item && set.item.toLowerCase().replace(/[^a-z0-9]/g, '') !== facts.item.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    return false;
  }
  if (facts.ability && set.ability.toLowerCase().replace(/[^a-z0-9]/g, '') !== facts.ability.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    return false;
  }
  if (facts.level !== undefined && set.level !== facts.level) return false;
  if (facts.teraType && (set.teraType || '').toLowerCase() !== facts.teraType.toLowerCase()) return false;
  const setMoves = new Set(set.moves.map((m) => m.toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const move of facts.moves) {
    const id = move.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!setMoves.has(id)) return false;
  }
  return true;
}

export function hypothesesForSpecies(pool: RandomSetPool, species: string): SetHypothesis[] {
  const key = species.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = pool.species[key] ?? pool.species[species];
  dbg({runId:'post-fix',hypothesisId:'C',location:'beliefs.ts:hypothesesForSpecies',message:'pool lookup',data:{species,key,hasKey:!!pool.species[key],hasRaw:!!pool.species[species],rowCount:rows?.length??0,speciesCount:Object.keys(pool.species).length,hasToxapex:!!pool.species.toxapex,garchompItems:(pool.species.garchomp??[]).map((r)=>({item:r.set.item,count:r.count}))}});
  if (!rows || !rows.length) {
    throw new Error(`random-set pool has no hypotheses for ${species}`);
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total <= 0) throw new Error(`random-set pool has zero counts for ${species}`);
  return rows
    .map((r) => ({ set: r.set, count: r.count, probability: r.count / total }))
    .sort((a, b) => b.count - a.count || canonicalizeSet(a.set).localeCompare(canonicalizeSet(b.set)));
}

export function updateBeliefs(prior: SetHypothesis[], facts: RevealedFacts): SetHypothesis[] {
  const kept = prior.filter((h) => compatible(h.set, facts));
  dbg({runId:'post-fix',hypothesisId:'B',location:'beliefs.ts:updateBeliefs',message:'filter result',data:{species:facts.species,factItem:facts.item,factMoves:facts.moves,priorLen:prior.length,keptLen:kept.length,topItem:prior[0]?.set.item,topProb:prior[0]?.probability,priorItems:prior.map((h)=>h.set.item)}});
  if (!kept.length) {
    throw new Error(`no compatible Random Battle sets remain for ${facts.species}`);
  }
  const total = kept.reduce((s, h) => s + h.count, 0);
  if (total <= 0) throw new Error(`compatible Random Battle sets have zero mass for ${facts.species}`);
  return kept
    .map((h) => ({ ...h, probability: h.count / total }))
    .sort((a, b) => b.probability - a.probability || canonicalizeSet(a.set).localeCompare(canonicalizeSet(b.set)));
}

export function initialBelief(pool: RandomSetPool, facts: RevealedFacts): SetHypothesis[] {
  return updateBeliefs(hypothesesForSpecies(pool, facts.species), facts);
}
