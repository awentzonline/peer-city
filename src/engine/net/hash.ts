/** 32-bit FNV-1a string hash. Deterministic across peers. */
export function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche (murmur3 fmix32) so similar keys spread well
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Rendezvous (highest-random-weight) hashing: every peer that knows the same
 * candidate set picks the same winner for `key`, and when a candidate joins or
 * leaves only the keys that candidate wins/loses move.
 */
export function rendezvous(key: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = fnv1a(key, fnv1a(c));
    if (score > bestScore || (score === bestScore && best !== null && c < best)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Small deterministic PRNG (mulberry32) for procedural content shared by all peers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
