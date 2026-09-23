import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../src/engine/spatial/SpatialHash';

describe('SpatialHash', () => {
  it('finds what was put in and forgets cells that empty out', () => {
    const hash = new SpatialHash<{ _cell: number; name: string }>(10);
    const cells = () => (hash as unknown as { cells: Map<number, Set<unknown>> }).cells.size;
    const a = { _cell: -1, name: 'a' };
    const b = { _cell: -1, name: 'b' };
    hash.update(a, 5, 5);
    hash.update(b, 55, 5);
    expect(cells()).toBe(2);
    expect(hash.queryRadius(0, 0, 12).map((i) => i.name)).toEqual(['a']);
    // walking through a hundred cells doesn't leave a hundred empty ones behind
    for (let x = 0; x < 1000; x += 10) hash.update(a, x, 500);
    expect(cells()).toBe(2);
    expect(hash.queryRadius(990, 500, 1).map((i) => i.name)).toEqual(['a']);
    hash.remove(a);
    hash.remove(b);
    expect(cells()).toBe(0);
  });
});
