/**
 * A transport provides named rooms of directly-connected peers.
 *
 * The engine joins one room per nearby world zone, so a peer only ever holds
 * connections to peers in its neighbourhood. Implementations must deliver
 * messages reliably and in order per peer (WebRTC reliable data channels do).
 */
export interface Transport {
  readonly selfId: string;
  readonly name: string;
  join(roomId: string): TransportRoom;
  dispose?(): void;
}

export interface TransportRoom {
  readonly id: string;
  onPeerJoin: (peerId: string) => void;
  onPeerLeave: (peerId: string) => void;
  onMessage: (data: Uint8Array, peerId: string) => void;
  send(data: Uint8Array, peerId: string): void;
  peers(): string[];
  leave(): void;
}

export function randomPeerId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}
