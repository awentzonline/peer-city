import { randomPeerId, type Transport, type TransportRoom } from './types';

type Wire =
  | { t: 'hello'; from: string }
  | { t: 'here'; from: string; to: string }
  | { t: 'bye'; from: string }
  | { t: 'beat'; from: string }
  | { t: 'data'; from: string; to: string; data: Uint8Array };

/**
 * Same-origin transport over BroadcastChannel. Every browser tab is a peer; no
 * network required. Handy for development and for testing many clients on
 * one machine (`?net=local`).
 */
export class BroadcastTransport implements Transport {
  readonly name = 'broadcast';
  readonly selfId = randomPeerId();

  constructor(private readonly appId: string) {}

  join(roomId: string): TransportRoom {
    const channel = new BroadcastChannel(`p2pge:${this.appId}:${roomId}`);
    const self = this.selfId;
    const lastSeen = new Map<string, number>();
    let closed = false;

    const handle: TransportRoom = {
      id: roomId,
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      onMessage: () => {},
      send: (data, to) => {
        if (!closed && lastSeen.has(to)) channel.postMessage({ t: 'data', from: self, to, data } satisfies Wire);
      },
      peers: () => [...lastSeen.keys()],
      leave: () => {
        if (closed) return;
        channel.postMessage({ t: 'bye', from: self } satisfies Wire);
        closed = true;
        clearInterval(timer);
        channel.close();
        window.removeEventListener('pagehide', onUnload);
      },
    };

    const touch = (peer: string) => {
      const known = lastSeen.has(peer);
      lastSeen.set(peer, performance.now());
      if (!known) handle.onPeerJoin(peer);
    };
    const drop = (peer: string) => {
      if (lastSeen.delete(peer)) handle.onPeerLeave(peer);
    };

    channel.onmessage = (ev: MessageEvent<Wire>) => {
      const m = ev.data;
      if (closed || m.from === self) return;
      switch (m.t) {
        case 'hello':
          channel.postMessage({ t: 'here', from: self, to: m.from } satisfies Wire);
          touch(m.from);
          break;
        case 'here':
          if (m.to === self) touch(m.from);
          break;
        case 'beat':
          touch(m.from);
          break;
        case 'bye':
          drop(m.from);
          break;
        case 'data':
          if (m.to !== self) return;
          touch(m.from);
          handle.onMessage(m.data, m.from);
          break;
      }
    };

    const timer = setInterval(() => {
      channel.postMessage({ t: 'beat', from: self } satisfies Wire);
      const now = performance.now();
      for (const [peer, seen] of lastSeen) if (now - seen > 2600) drop(peer);
    }, 800);
    const onUnload = () => handle.leave();
    window.addEventListener('pagehide', onUnload);

    // Let the caller attach handlers before announcing.
    queueMicrotask(() => {
      if (!closed) channel.postMessage({ t: 'hello', from: self } satisfies Wire);
    });
    return handle;
  }
}
