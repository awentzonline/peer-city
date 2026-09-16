import type { EntityDef, Infer, NetWorld, Shape } from '@engine/index';
import type { Transport, TransportRoom } from '@engine/transport/types';
import type { VoiceSource } from './audio';
import type { BODY_FIELDS } from './avatar';
import type { Vec3 } from './math';

/** How far a voice carries by default, in meters: about a shout across a clearing. */
export const VOICE_RANGE = 22;
/** Send to someone a little before they're in earshot, and stop a good way after: renegotiating a stream isn't instant. */
const SEND_IN = 1.2;
const SEND_OUT = 1.9;
/** Above this a meter counts as talking, for the settings menu's dots. */
export const SPEAKING = 0.06;

/** Someone who could be heard: where their mouth is, and what to call them in the menu. */
export interface Speaker {
  peer: string;
  name: string;
  at: Vec3;
}

/** A peer's voice as the settings menu sees it. */
export interface VoicePeerView {
  peer: string;
  name: string;
  /** Meters away, or Infinity while we don't know where they are. */
  distance: number;
  muted: boolean;
  /** Whether their voice is actually arriving (they have a microphone on and we're near enough). */
  hearing: boolean;
  /** How loud they are right now, 0..1. */
  level: number;
}

/** What voice needs from the game's sound (audio.ts's `SpatialAudio`, which satisfies this as it stands). */
export interface VoiceAudio {
  readonly listenerAt: Readonly<Vec3>;
  voice(stream: MediaStream, range: number): VoiceSource | null;
  meter(stream: MediaStream): (() => number) | null;
}

export interface VoiceOptions {
  transport: Transport;
  /** Namespace for the voice rooms, usually `${world.worldId}/voice/`. */
  prefix: string;
  audio: VoiceAudio;
  /** Zone keys to keep voice rooms for: normally the world's own, so voice reaches no further than the peer graph. */
  zones: () => Iterable<string>;
  /** Everyone who might be heard right now, and where. */
  speakers: () => Iterable<Speaker>;
  range?: number;
  /** Ask for the microphone. Overridable in tests. */
  getMic?: () => Promise<MediaStream>;
}

interface VoicePeer {
  id: string;
  name: string;
  rooms: Set<string>;
  /** The room our microphone goes out through, while it does. */
  sendingVia: TransportRoom | null;
  stream: MediaStream | null;
  source: VoiceSource | null;
  /** Whether their voice is actually being played: they're sending, and they're inside earshot. */
  heard: boolean;
  at: Vec3 | null;
  distance: number;
}

/**
 * Proximity voice chat. Your microphone goes to the people standing near you and nobody else: it's added to
 * a peer's connection when they come within earshot and taken off it when they leave, so being out of range
 * means the audio never arrives, not that it arrives quietly. Their voices play through HRTF panners at
 * their heads (audio.ts), which is what makes talking in a headset feel like talking.
 *
 * Voice rooms mirror the world's zone rooms (`world.zoneKeys()`), so this opens no connections the engine
 * hasn't already made: Trystero shares one peer connection across rooms, and the tracks ride on that.
 *
 * The microphone starts off. Nothing here asks for it until someone turns it on, from the settings menu or
 * with the talk key; hearing other people needs no permission, so a listener needs to do nothing at all.
 */
export class Voice {
  readonly range: number;
  /** Set when the browser refused the microphone, to show in the menu. */
  error = '';
  /** Hear nobody, without touching who is muted. */
  deafened = false;

  private readonly opts: VoiceOptions;
  private readonly rooms = new Map<string, TransportRoom>();
  private readonly peers = new Map<string, VoicePeer>();
  private readonly muted = new Set<string>();
  private mic: MediaStream | null = null;
  private micLevel: (() => number) | null = null;
  private busy = false;
  private disposed = false;
  /** Null until the first room says whether this transport carries media at all. */
  private carriesMedia: boolean | null = null;

  constructor(opts: VoiceOptions) {
    this.opts = opts;
    this.range = opts.range ?? VOICE_RANGE;
  }

  /** Whether the microphone is open and going out to whoever is near. */
  get talking(): boolean {
    return !!this.mic;
  }

  /** Whether voice can work here at all. A BroadcastChannel carries no media, so local tabs can't talk. */
  get supported(): boolean {
    return this.carriesMedia !== false;
  }

  /** Whether we could open a microphone. Hearing other people needs nothing; a page has to be secure to talk. */
  get canTalk(): boolean {
    return this.supported && (!!this.opts.getMic || (typeof navigator !== 'undefined' && !!navigator.mediaDevices));
  }

  /** How loud our own microphone is, 0..1, so you can see it hearing you. */
  get level(): number {
    return this.micLevel?.() ?? 0;
  }

  /**
   * Open the microphone or release it. Turning it off really does stop the tracks, so the browser's
   * recording light goes out: "off" means off, not "on but quiet".
   */
  async setTalking(on: boolean): Promise<boolean> {
    if (this.busy || on === this.talking) return this.talking;
    this.busy = true;
    try {
      if (on) await this.openMic();
      else this.closeMic();
    } finally {
      this.busy = false;
    }
    return this.talking;
  }

  toggleTalking(): Promise<boolean> {
    return this.setTalking(!this.talking);
  }

  isMuted(peer: string): boolean {
    return this.muted.has(peer);
  }

  /** Mute or unmute one person. It sticks if they walk off and come back. */
  setMuted(peer: string, muted: boolean): void {
    if (muted) this.muted.add(peer);
    else this.muted.delete(peer);
  }

  /** Everyone whose voice we could hear, nearest first, for the settings menu. */
  nearby(): VoicePeerView[] {
    const out: VoicePeerView[] = [];
    for (const p of this.peers.values()) {
      out.push({
        peer: p.id,
        name: p.name,
        distance: p.distance,
        muted: this.muted.has(p.id),
        hearing: p.heard,
        level: p.source?.level() ?? 0,
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  /** Follow the world's zones, and work out who is near enough to talk to. Call once a frame. */
  update(): void {
    if (this.disposed) return;
    this.syncRooms();
    this.locate();
    for (const peer of this.peers.values()) {
      this.updateSending(peer);
      this.updatePlayback(peer);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeMic();
    for (const peer of this.peers.values()) this.stopHearing(peer);
    this.peers.clear();
    for (const room of this.rooms.values()) room.leave();
    this.rooms.clear();
  }

  // ---------------------------------------------------------------------------

  private async openMic(): Promise<void> {
    if (!this.canTalk) {
      this.error = 'This page can\'t reach a microphone';
      return;
    }
    try {
      const ask = this.opts.getMic ?? (() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
      const stream = await ask();
      if (this.disposed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.mic = stream;
      this.micLevel = this.opts.audio.meter(stream);
      this.error = '';
    } catch (err: unknown) {
      this.error = err instanceof Error && err.name === 'NotAllowedError' ? 'The browser blocked the microphone' : 'No microphone available';
    }
  }

  private closeMic(): void {
    const mic = this.mic;
    if (!mic) return;
    for (const peer of this.peers.values()) this.stopSending(peer, mic);
    for (const track of mic.getTracks()) track.stop();
    this.mic = null;
    this.micLevel = null;
  }

  /** One voice room per zone room the world is in, joined and left with them. */
  private syncRooms(): void {
    if (this.carriesMedia === false) return;
    const want = new Set(this.opts.zones());
    for (const key of want) {
      if (this.rooms.has(key)) continue;
      const room = this.opts.transport.join(`${this.opts.prefix}${key}`);
      this.carriesMedia = !!room.media;
      if (!room.media) {
        // This transport can't carry voice, so don't hold rooms nothing will ever use.
        room.leave();
        return;
      }
      this.rooms.set(key, room);
      room.onPeerJoin = (peer) => this.onPeerJoin(key, room, peer);
      room.onPeerLeave = (peer) => this.onPeerLeave(key, peer);
      room.media.onPeerStream = (stream, peer) => this.onPeerStream(peer, stream);
      for (const peer of room.peers()) this.onPeerJoin(key, room, peer);
    }
    for (const [key, room] of this.rooms) {
      if (want.has(key)) continue;
      this.rooms.delete(key);
      room.leave();
      for (const peer of this.peers.values()) this.onPeerLeave(key, peer.id);
    }
  }

  private onPeerJoin(key: string, room: TransportRoom, id: string): void {
    if (id === this.opts.transport.selfId || !this.rooms.has(key)) return;
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { id, name: '', rooms: new Set(), sendingVia: null, stream: null, source: null, heard: false, at: null, distance: Infinity };
      this.peers.set(id, peer);
    }
    peer.rooms.add(key);
  }

  private onPeerLeave(key: string, id: string): void {
    const peer = this.peers.get(id);
    if (!peer?.rooms.delete(key)) return;
    // The room is going or gone, so the track goes with it; there's nothing to take off the connection.
    if (peer.sendingVia?.id === `${this.opts.prefix}${key}`) peer.sendingVia = null;
    if (peer.rooms.size > 0) return;
    this.stopHearing(peer);
    this.peers.delete(id);
  }

  private onPeerStream(id: string, stream: MediaStream): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.stopHearing(peer);
    peer.stream = stream;
  }

  /** Where everyone is this frame, and how far off. Someone we can't place yet is treated as out of earshot. */
  private locate(): void {
    for (const peer of this.peers.values()) peer.at = null;
    const me = this.opts.audio.listenerAt;
    for (const speaker of this.opts.speakers()) {
      const peer = this.peers.get(speaker.peer);
      if (!peer) continue;
      peer.name = speaker.name;
      peer.at = { x: speaker.at.x, y: speaker.at.y, z: speaker.at.z };
      peer.distance = Math.hypot(speaker.at.x - me.x, speaker.at.y - me.y, speaker.at.z - me.z);
    }
    for (const peer of this.peers.values()) if (!peer.at) peer.distance = Infinity;
  }

  /** Add our microphone to the people who have come into earshot, and take it off the ones who left it. */
  private updateSending(peer: VoicePeer): void {
    const mic = this.mic;
    if (!mic) return;
    if (peer.sendingVia) {
      if (peer.distance <= this.range * SEND_OUT) return;
      this.stopSending(peer, mic);
      return;
    }
    if (peer.distance > this.range * SEND_IN) return;
    const room = this.roomFor(peer);
    if (!room?.media) return;
    peer.sendingVia = room;
    room.media.addStream(mic, peer.id);
  }

  private stopSending(peer: VoicePeer, mic: MediaStream): void {
    peer.sendingVia?.media?.removeStream(mic, peer.id);
    peer.sendingVia = null;
  }

  private roomFor(peer: VoicePeer): TransportRoom | null {
    for (const key of peer.rooms) {
      const room = this.rooms.get(key);
      if (room) return room;
    }
    return null;
  }

  /** Keep a voice playing where its speaker is, and silent while they're muted or out of earshot. */
  private updatePlayback(peer: VoicePeer): void {
    peer.heard = false;
    if (!peer.stream) return;
    // The audio context only exists once the game has had a gesture, so keep trying until it does.
    if (!peer.source) peer.source = this.opts.audio.voice(peer.stream, this.range);
    const source = peer.source;
    if (!source) return;
    if (peer.at) source.setPosition(peer.at);
    // The panner rolls a voice off with distance but never quite to nothing, so earshot is cut here.
    // We stop sending a good way beyond it (SEND_OUT), which is only to keep connections from churning.
    peer.heard = peer.distance <= this.range;
    source.setVolume(peer.heard && !this.deafened && !this.muted.has(peer.id) ? 1 : 0);
  }

  private stopHearing(peer: VoicePeer): void {
    peer.source?.dispose();
    peer.source = null;
    peer.stream = null;
    peer.heard = false;
  }
}

/** Every other player's mouth, for `VoiceOptions.speakers`: any entity built on `BODY_FIELDS` will do. */
export function bodySpeakers<S extends Shape>(world: NetWorld, def: EntityDef<S>): () => Iterable<Speaker> {
  return function* speakers(): Iterable<Speaker> {
    for (const e of world.remote(def)) {
      const body = e.render as Infer<S> & Infer<typeof BODY_FIELDS> & { name: string };
      yield { peer: e.owner, name: body.name, at: { x: e.x, y: e.y, z: body.z + body.head } };
    }
  };
}
