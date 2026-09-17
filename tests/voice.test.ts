import { describe, expect, it } from 'vitest';
import { MemoryNetwork } from '../src/engine/transport/memory';
import type { RoomMedia, Transport, TransportRoom } from '../src/engine/transport/types';
import type { VoiceSource } from '../src/crossplay/audio';
import type { Vec3 } from '../src/crossplay/math';
import { Settings } from '../src/crossplay/settings';
import { Voice, type VoiceAudio } from '../src/crossplay/voice';

/** A stream we never play: nothing here touches WebRTC or the audio hardware. */
const stream = (id: string): MediaStream => ({ id, getTracks: () => [{ stop: () => {} }] }) as unknown as MediaStream;

interface Sent {
  room: string;
  peer: string;
  stream: MediaStream;
}

/** A transport whose rooms carry media, so the tests can watch who a microphone is sent to. */
class FakeTransport implements Transport {
  readonly name = 'fake';
  readonly selfId = 'me';
  readonly rooms = new Map<string, FakeRoom>();
  readonly sent: Sent[] = [];
  readonly removed: Sent[] = [];

  constructor(private readonly carriesMedia = true) {}

  join(roomId: string): TransportRoom {
    const room = new FakeRoom(roomId, this, this.carriesMedia);
    this.rooms.set(roomId, room);
    return room;
  }

  /** Someone turns up in a room, as the signalling would report. */
  arrive(roomId: string, peer: string): void {
    this.rooms.get(roomId)!.onPeerJoin(peer);
  }

  depart(roomId: string, peer: string): void {
    this.rooms.get(roomId)!.onPeerLeave(peer);
  }

  /** Their microphone reaches us. */
  speak(roomId: string, peer: string, s: MediaStream): void {
    this.rooms.get(roomId)!.media?.onPeerStream(s, peer);
  }
}

class FakeRoom implements TransportRoom {
  onPeerJoin: (peerId: string) => void = () => {};
  onPeerLeave: (peerId: string) => void = () => {};
  onMessage: () => void = () => {};
  readonly media?: RoomMedia;
  left = false;

  constructor(
    readonly id: string,
    net: FakeTransport,
    carriesMedia: boolean,
  ) {
    if (!carriesMedia) return;
    this.media = {
      addStream: (s, peer) => net.sent.push({ room: this.id, peer, stream: s }),
      removeStream: (s, peer) => net.removed.push({ room: this.id, peer, stream: s }),
      onPeerStream: () => {},
    };
  }

  send(): void {}

  peers(): string[] {
    return [];
  }

  leave(): void {
    this.left = true;
  }
}

class FakeAudio implements VoiceAudio {
  readonly listenerAt: Vec3 = { x: 0, y: 0, z: 0 };
  readonly playing = new Map<MediaStream, { at: Vec3; volume: number; disposed: boolean }>();

  voice(s: MediaStream): VoiceSource {
    const state = { at: { x: 0, y: 0, z: 0 }, volume: 1, disposed: false };
    this.playing.set(s, state);
    return {
      setPosition: (at) => Object.assign(state.at, at),
      setVolume: (v) => (state.volume = v),
      level: () => 0.5,
      dispose: () => (state.disposed = true),
    };
  }

  meter(): () => number {
    return () => 0.4;
  }
}

/** A voice with one zone room and one other person in it, standing `distance` meters away. */
function setup(distance: number, carriesMedia = true) {
  const net = new FakeTransport(carriesMedia);
  const audio = new FakeAudio();
  const zones = new Set(['0,0']);
  const them = { peer: 'you', name: 'Ada', at: { x: distance, y: 0, z: 1.65 } };
  const voice = new Voice({
    transport: net,
    prefix: 'w/voice/',
    audio,
    zones: () => zones,
    speakers: () => [them],
    range: 20,
    getMic: () => Promise.resolve(stream('mic')),
  });
  const move = (d: number): void => {
    them.at.x = d;
  };
  return { net, audio, voice, zones, them, move };
}

describe('Voice', () => {
  it('keeps one voice room per world zone, and leaves with them', () => {
    const { net, voice, zones } = setup(5);
    voice.update();
    expect([...net.rooms.keys()]).toEqual(['w/voice/0,0']);

    zones.add('1,0');
    voice.update();
    expect([...net.rooms.keys()]).toEqual(['w/voice/0,0', 'w/voice/1,0']);

    zones.delete('0,0');
    voice.update();
    expect(net.rooms.get('w/voice/0,0')!.left).toBe(true);
    expect(net.rooms.get('w/voice/1,0')!.left).toBe(false);
  });

  it('sends the microphone to whoever is in earshot, and nobody else', async () => {
    const { net, voice, move } = setup(60);
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    await voice.setTalking(true);
    expect(voice.talking).toBe(true);

    // Too far off to hear: their connection never gets the track at all.
    voice.update();
    expect(net.sent).toEqual([]);

    move(10);
    voice.update();
    expect(net.sent).toMatchObject([{ peer: 'you', room: 'w/voice/0,0' }]);

    // Walking a little way off doesn't churn the connection...
    move(30);
    voice.update();
    expect(net.removed).toEqual([]);

    // ...but walking right away takes the microphone back off it.
    move(60);
    voice.update();
    expect(net.removed).toMatchObject([{ peer: 'you' }]);
    expect(net.sent).toHaveLength(1);
  });

  it('stops sending when the microphone is turned off, and releases it', async () => {
    const { net, voice } = setup(5);
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    await voice.setTalking(true);
    voice.update();
    expect(net.sent).toHaveLength(1);

    await voice.setTalking(false);
    expect(voice.talking).toBe(false);
    expect(net.removed).toMatchObject([{ peer: 'you' }]);
  });

  it('plays a voice where its speaker is standing, and silences the muted', () => {
    const { net, audio, voice, move } = setup(5);
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    const theirs = stream('you');
    net.speak('w/voice/0,0', 'you', theirs);

    voice.update();
    const playing = audio.playing.get(theirs)!;
    expect(playing.at).toEqual({ x: 5, y: 0, z: 1.65 });
    expect(playing.volume).toBe(1);

    move(9);
    voice.update();
    expect(playing.at.x).toBe(9);

    voice.setMuted('you', true);
    voice.update();
    expect(playing.volume).toBe(0);

    // Out of earshot is silence, not a distant murmur: the panner alone never rolls all the way off.
    voice.setMuted('you', false);
    voice.update();
    expect(playing.volume).toBe(1);
    move(30);
    voice.update();
    expect(playing.volume).toBe(0);
    expect(voice.nearby()[0].hearing).toBe(false);
    move(9);
    voice.update();
    expect(playing.volume).toBe(1);
    voice.setMuted('you', true);

    // Muting is about a person, not about the stream, so it survives them walking off and coming back.
    net.depart('w/voice/0,0', 'you');
    expect(playing.disposed).toBe(true);
    net.arrive('w/voice/0,0', 'you');
    net.speak('w/voice/0,0', 'you', stream('you2'));
    voice.update();
    expect(voice.isMuted('you')).toBe(true);
    expect([...audio.playing.values()].at(-1)!.volume).toBe(0);
  });

  it('reports who is nearby for the settings menu', () => {
    const { net, voice } = setup(7);
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    net.speak('w/voice/0,0', 'you', stream('you'));
    voice.update();
    expect(voice.nearby()).toMatchObject([{ peer: 'you', name: 'Ada', distance: Math.hypot(7, 1.65), muted: false, hearing: true }]);
  });

  it('stays out of the way on a transport that carries no media', () => {
    const { net, voice } = setup(5, false);
    voice.update();
    voice.update();
    expect(voice.supported).toBe(false);
    expect(net.rooms.get('w/voice/0,0')!.left).toBe(true);
    expect(net.rooms.size).toBe(1); // it gave up after the first room, rather than opening one per zone
  });

  it("sends to where an overseer listens, and plays it only while its presence is about", async () => {
    const { net, audio, voice, them } = setup(5);
    // looking right at us from on high, but its presence is off across the house
    const overseer = them as { peer: string; name: string; at: Vec3 | null; ears?: Vec3 };
    overseer.at = null;
    overseer.ears = { x: 3, y: 0, z: 1.7 };
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    await voice.setTalking(true);
    voice.update();
    expect(net.sent).toMatchObject([{ peer: 'you' }]);

    const theirs = stream('you');
    net.speak('w/voice/0,0', 'you', theirs);
    voice.update();
    expect(audio.playing.get(theirs)!.volume).toBe(0);
    overseer.at = { x: 4, y: 0, z: 1.7 };
    voice.update();
    expect(audio.playing.get(theirs)!.volume).toBe(1);

    // it looks away: stop sending once it's well out of earshot, whatever its presence does
    overseer.ears = { x: 80, y: 0, z: 1.7 };
    voice.update();
    expect(net.removed).toMatchObject([{ peer: 'you' }]);
  });

  it("doesn't let a voice that won't play stop the frame", () => {
    const { net, voice } = setup(5);
    let fails = 0;
    const audio = (voice as unknown as { opts: { audio: VoiceAudio } }).opts.audio;
    audio.voice = () => {
      fails++;
      throw new Error('MediaStream has no audio track');
    };
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    net.speak('w/voice/0,0', 'you', stream('you'));
    expect(() => voice.update()).not.toThrow();
    voice.update();
    expect(fails).toBe(1); // not retried every frame
  });

  it('carries no media over a BroadcastChannel-style transport', () => {
    const room = new MemoryNetwork().createTransport('me').join('r');
    expect(room.media).toBeUndefined();
  });
});

describe('Settings', () => {
  it('lists the microphone, the people nearby and the game sound', () => {
    const { net, voice } = setup(6);
    voice.update();
    net.arrive('w/voice/0,0', 'you');
    net.speak('w/voice/0,0', 'you', stream('you'));
    voice.update();

    const sfx = { muted: false } as { muted: boolean };
    const settings = new Settings({ voice, sfx: sfx as never });
    const rows = settings.rows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('voice:mic')!.on).toBe(false);
    expect(byId.get('voice:deafen')!.on).toBe(true);

    const peer = byId.get('voice:peer:you')!;
    expect(peer.label).toBe('Ada');
    expect(peer.detail).toContain('6 m away');
    peer.toggle();
    expect(voice.isMuted('you')).toBe(true);

    byId.get('sfx')!.toggle();
    expect(sfx.muted).toBe(true);
  });
});
