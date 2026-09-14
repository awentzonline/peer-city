import { joinRoom, selfId } from 'trystero';
import type { Transport, TransportRoom } from './types';

export interface TrysteroTransportOptions {
  /** Globally unique app identifier; peers only discover others with the same appId. */
  appId: string;
  /** Optional room password (encrypts signalling payloads). */
  password?: string;
  /** Override Nostr relay URLs used for peer discovery. */
  relayUrls?: string[];
  /** Custom ICE / TURN servers for peers behind strict NATs. */
  turnConfig?: { urls: string | string[]; username?: string; credential?: string }[];
}

/**
 * Serverless WebRTC via Trystero (Nostr relays for signalling). Trystero shares
 * one RTCPeerConnection per remote peer across all rooms, so overlapping zone
 * rooms don't multiply connections.
 */
export class TrysteroTransport implements Transport {
  readonly name = 'trystero';
  readonly selfId: string = selfId;

  constructor(private readonly opts: TrysteroTransportOptions) {}

  join(roomId: string): TransportRoom {
    const config: Record<string, unknown> = { appId: this.opts.appId };
    if (this.opts.password) config.password = this.opts.password;
    if (this.opts.relayUrls) config.relayConfig = { urls: this.opts.relayUrls };
    if (this.opts.turnConfig) config.turnConfig = this.opts.turnConfig;

    const room = joinRoom(config as any, roomId);
    const action = room.makeAction<Uint8Array>('g');
    const handle: TransportRoom = {
      id: roomId,
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      onMessage: () => {},
      send: (data, peerId) => {
        action.send(data, { target: peerId }).catch(() => {
          /* peer vanished mid-send; the mesh will notice */
        });
      },
      peers: () => Object.keys(room.getPeers()),
      leave: () => {
        room.leave().catch(() => {});
      },
    };
    room.onPeerJoin = (peerId) => handle.onPeerJoin(peerId);
    room.onPeerLeave = (peerId) => handle.onPeerLeave(peerId);
    action.onMessage = (data, ctx) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
      handle.onMessage(bytes, ctx.peerId);
    };
    return handle;
  }
}
