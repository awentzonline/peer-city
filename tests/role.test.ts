import { describe, expect, it } from 'vitest';
import { seniorHolder } from '../src/crossplay/role';

describe('seniorHolder', () => {
  const at = (id: number, since: number) => ({ id, render: { since } });
  it('yields to whoever took the role first, and to the lower id when taken at once', () => {
    const me = at(7, 100);
    expect(seniorHolder([me], me)).toBeNull();
    expect(seniorHolder([me, at(9, 101)], me)).toBeNull();
    expect(seniorHolder([me, at(9, 99)], me)?.id).toBe(9);
    expect(seniorHolder([me, at(9, 100)], me)).toBeNull();
    expect(seniorHolder([me, at(3, 100)], me)?.id).toBe(3);
    expect(seniorHolder([me, at(3, 100), at(9, 99)], me)?.id).toBe(9);
  });
});
