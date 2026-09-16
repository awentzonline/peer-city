import type { NetWorldOptions, Transport } from '@engine/index';
import { BroadcastTransport } from '@engine/transport/broadcast';
import { TrysteroTransport } from '@engine/transport/trystero';

/** Which network a page plays on: across the internet, or between tabs on this machine (no network at all). */
export type NetMode = 'online' | 'local';

/** A transport for a network mode. Peers only meet others with the same `appId`. */
export function connect(appId: string, mode: NetMode): Transport {
  return mode === 'local' ? new BroadcastTransport(appId) : new TrysteroTransport({ appId });
}

/**
 * Engine options for a world measured in meters that players spread out over, like a city or an island: zones of
 * a few hundred meters, so each peer connects only to its neighbourhood. The engine's defaults suit pixels.
 * Spread it into `NetWorld`'s options and override what a game needs (`interestRadius`, most often).
 */
export const OPEN_WORLD = {
  zoneSize: 256,
  cellSize: 64,
  interestRadius: 150,
  tickRate: 20,
  interpDelayMs: 110,
  spatialCellSize: 24,
  focusResendDistance: 1.5,
  zoneJoinMargin: 25,
  zoneKeepMargin: 75,
} satisfies Partial<NetWorldOptions>;

/**
 * Engine options for a meter-scale place small enough that everyone in it should see everyone else, like a
 * garage and its hill or a yard: one zone for the lot, and a bigger byte budget for the crowd that makes. Set
 * `interestRadius` to the size of the place.
 */
export const ONE_ZONE = {
  zoneSize: 4096,
  cellSize: 1024,
  tickRate: 20,
  interpDelayMs: 100,
  bytesPerTick: 4000,
  spatialCellSize: 24,
  focusResendDistance: 3,
  zoneJoinMargin: 100,
  zoneKeepMargin: 300,
} satisfies Partial<NetWorldOptions>;
