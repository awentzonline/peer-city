import { describe, expect, it } from 'vitest';
import { InterpBuffer } from '../src/engine/net/interp';

const GAP = 50;

describe('InterpBuffer', () => {
  it('interpolates between samples and caps extrapolation', () => {
    const b = new InterpBuffer(['linear'], 150);
    const out = [0];
    b.push(0, [0], GAP);
    b.push(50, [10], GAP);
    b.push(100, [20], GAP);
    b.sample(75, out);
    expect(out[0]).toBeCloseTo(15);
    // extrapolation is capped at one sample span
    b.sample(400, out);
    expect(out[0]).toBeCloseTo(30);
  });

  it('interpolates angles the short way round', () => {
    const b = new InterpBuffer(['angle'], 150);
    const out = [0];
    b.push(0, [6.2], GAP);
    b.push(50, [0.1], GAP);
    b.sample(25, out);
    expect(out[0]).toBeCloseTo(6.2 + (0.1 + Math.PI * 2 - 6.2) / 2);
  });

  it('holds the previous value across gaps and does not extrapolate from the hold', () => {
    const b = new InterpBuffer(['linear'], 150);
    const out = [0];
    b.push(0, [0], GAP);
    b.push(1000, [100], GAP);
    b.sample(500, out);
    expect(out[0]).toBe(0);
    b.sample(975, out);
    expect(out[0]).toBeCloseTo(50);
    b.sample(1100, out);
    expect(out[0]).toBe(100);
  });

  it('keeps a bounded window as samples wrap around the ring', () => {
    const b = new InterpBuffer(['linear', 'linear'], 150);
    const out = [0, 0];
    for (let i = 0; i < 40; i++) b.push(i * GAP, [i, -i], GAP);
    expect(b.count).toBe(12);
    expect(b.lastTime).toBe(39 * GAP);
    for (let i = 28; i < 39; i++) {
      b.sample(i * GAP + 25, out);
      expect(out[0]).toBeCloseTo(i + 0.5);
      expect(out[1]).toBeCloseTo(-i - 0.5);
    }
    for (let i = 40; i < 60; i++) {
      b.push(i * GAP, [i, -i], GAP);
      b.sample(i * GAP - 25, out);
      expect(out[0]).toBeCloseTo(i - 0.5);
    }
  });
});
