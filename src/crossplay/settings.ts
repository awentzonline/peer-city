import type { SpatialAudio } from './audio';
import { SPEAKING, type Voice } from './voice';

/**
 * One line of the settings menu. Both frontends (a DOM panel on desktop, a canvas panel in a headset) draw
 * the same rows, so a setting is added in one place and shows up on every platform.
 */
export interface SettingsRow {
  /** Stable across redraws, so a menu can keep a row's element and its focus. */
  id: string;
  kind: 'heading' | 'toggle' | 'note';
  label: string;
  /** Second line: what the setting means in its current state. */
  detail: string;
  /** Toggles: whether it's on. */
  on: boolean;
  /** A live loudness meter, 0..1, or -1 on rows that have none. */
  level: number;
  toggle(): void;
}

export interface SettingsDeps {
  voice: Voice;
  sfx: SpatialAudio;
}

const noop = (): void => {};

function heading(label: string): SettingsRow {
  return { id: `h:${label}`, kind: 'heading', label, detail: '', on: false, level: -1, toggle: noop };
}

function note(id: string, label: string): SettingsRow {
  return { id, kind: 'note', label, detail: '', on: false, level: -1, toggle: noop };
}

/**
 * What's in the in-game settings menu, with no idea how it's drawn. Rows are rebuilt on every read because
 * most of them are about who is standing next to you, which changes as people walk about.
 */
export class Settings {
  /** Whether the menu is up. The frontends own how it's opened; this is what they agree on. */
  open = false;

  constructor(private readonly deps: SettingsDeps) {}

  rows(): SettingsRow[] {
    const { voice, sfx } = this.deps;
    const rows: SettingsRow[] = [heading('Voice')];

    if (!voice.supported) {
      rows.push(note('voice:unsupported', 'Voice needs the online network, not local tabs'));
    } else {
      const mic = voice.canTalk ? (voice.talking ? 'People near you can hear you' : 'Nobody can hear you') : 'This page can\'t reach a microphone';
      rows.push({
        id: 'voice:mic',
        kind: 'toggle',
        label: 'Microphone',
        detail: voice.error || mic,
        on: voice.talking,
        level: voice.talking ? voice.level : -1,
        toggle: () => void voice.toggleTalking(),
      });
      rows.push({
        id: 'voice:deafen',
        kind: 'toggle',
        label: 'Hear others',
        detail: voice.deafened ? 'Everyone is silenced' : `Voices carry about ${Math.round(voice.range)} m`,
        on: !voice.deafened,
        level: -1,
        toggle: () => (voice.deafened = !voice.deafened),
      });

      const nearby = voice.nearby();
      rows.push(heading('People nearby'));
      if (nearby.length === 0) rows.push(note('voice:alone', 'Nobody else is near you'));
      for (const p of nearby) {
        const far = !Number.isFinite(p.distance);
        const where = far ? 'somewhere out of sight' : `${Math.round(p.distance)} m away`;
        const state = p.muted ? 'muted' : p.hearing ? (p.level > SPEAKING ? 'talking' : 'in earshot') : 'not talking';
        rows.push({
          id: `voice:peer:${p.peer}`,
          kind: 'toggle',
          label: p.name || 'Someone',
          detail: `${where} · ${state}`,
          on: !p.muted,
          level: p.muted ? -1 : p.level,
          toggle: () => voice.setMuted(p.peer, !p.muted),
        });
      }
    }

    rows.push(heading('Sound'));
    rows.push({
      id: 'sfx',
      kind: 'toggle',
      label: 'Game sound',
      detail: sfx.muted ? 'Muted' : 'Footsteps, weather, tools and the rest',
      on: !sfx.muted,
      level: -1,
      toggle: () => (sfx.muted = !sfx.muted),
    });
    return rows;
  }
}
