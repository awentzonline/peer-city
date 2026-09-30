import { HudBase } from '../crossplay/hud';
import type { FiveEvent, SlapEvent } from './actions';
import { boardKey, standings, type Standing } from './board';
import type { BuddyEntity, HiContext } from './context';
import { Buddy, BuddyMode } from './defs';
import { GRADE_NAMES, Grade, MOVE_NAMES, Move, RING_HIT, clean } from './moves';
import type { PalRole } from './pal';
import { BUDDY_NAMES } from './partners';

/** How a platform names its controls, for the HUD's hints. */
export interface PalKeys {
  /** What to press for each move. */
  moves: Record<Move, string>;
  slap: string;
  /** How to creep up on someone. */
  sneak: string;
}

export const GRADE_COLORS: Record<Grade, string> = {
  [Grade.Perfect]: '#ffd23f',
  [Grade.Great]: '#6ef0a0',
  [Grade.Good]: '#8fd3ff',
  [Grade.Limp]: '#c8c8c8',
  [Grade.Whiff]: '#9aa5ad',
  [Grade.TooSlow]: '#ff6b6b',
  [Grade.Awkward]: '#d7a8ff',
};

/**
 * Status and announcements (see crossplay/hud.ts). A headset paints the same state onto panels in the scene
 * (wrist.ts). Frontends call `showPal` every frame with how the device names its controls; a headset has no
 * keys to name, and no timing ring (its hands are real).
 */
export class Hud extends HudBase {
  status = '';
  /** -1 until it's first drawn, so a score of 0 is drawn too. */
  score = -1;
  best = 0;
  /** The combo going with whoever you're facing, and their name. */
  combo = 0;
  comboWith = '';
  alert = '';
  board: Standing[] = [];
  /** The one thing to do next, for a panel that's short of room. */
  offerText = '';

  private readonly statusEl = document.getElementById('status');
  private readonly scoreEl = document.getElementById('score');
  private readonly comboEl = document.getElementById('combo');
  private readonly boardEl = document.getElementById('board');
  private readonly ringEl = document.getElementById('ring');
  private readonly closerEl = document.getElementById('ring-closer');
  private readonly ringLabelEl = document.getElementById('ring-label');
  private readonly offerEl = document.getElementById('offer');
  private readonly alertEl = document.getElementById('alert');
  private readonly helpEl = document.getElementById('help');
  private boardDrawn = '';
  private nextBoard = 0;

  /** The pal's state, worded for the platform. `keys` null for a headset. */
  showPal(ctx: HiContext, role: PalRole, keys: PalKeys | null, help: string): void {
    const { world, now } = ctx;
    const me = ctx.me;
    if (!me) return;
    const s = me.state;
    const here = standings(world).length;
    const status = here > 1 ? `HIGH FIVE WITH FRIENDS · ${here} here` : 'HIGH FIVE WITH FRIENDS';
    this.set('status', status, () => this.statusEl && (this.statusEl.textContent = status));
    this.set('score', s.score, () => this.scoreEl && (this.scoreEl.innerHTML = `<b>${s.score}</b><small>POINTS</small>`));
    this.set('best', s.best);

    const partner = role.engaged ?? role.facing;
    const combo = partner ? ctx.pairs.streak(me.id, partner.id, now) : 0;
    const comboText = combo > 1 && partner ? `×${combo} with ${partner.name}` : '';
    this.set('combo', combo);
    this.set('comboWith', comboText, () => {
      if (!this.comboEl) return;
      this.comboEl.textContent = comboText;
      this.comboEl.hidden = !comboText;
    });

    if (now >= this.nextBoard) {
      this.nextBoard = now + 400;
      const rows = standings(world);
      const key = `${boardKey(rows)}#${me.id}`;
      if (key !== this.boardDrawn) {
        this.boardDrawn = key;
        this.board = rows;
        this.version++;
        if (this.boardEl) {
          this.boardEl.innerHTML = rows
            .slice(0, 6)
            .map((r, i) => `<div class="${r.id === me.id ? 'me' : ''}"><span>${i + 1}. ${escape(r.name)}</span><b>${r.score}</b></div>`)
            .join('');
        }
      }
    }

    this.showRing(role, keys);

    const offerText = s.offer !== Move.None ? `Holding out: ${MOVE_NAMES[s.offer]}${keys ? ` · ${keys.moves[s.offer]} again to pull it away` : ''}` : '';
    this.set('offerText', offerText, () => {
      if (!this.offerEl) return;
      this.offerEl.textContent = offerText;
      this.offerEl.hidden = !offerText;
    });

    const alert = role.alert === 'windup' ? 'SLAP INCOMING! TURN ROUND!' : role.alert === 'behind' ? 'Someone’s behind you…' : '';
    if (alert && !this.alert) ctx.sfx.play('alert', undefined, role.alert === 'windup' ? 1 : 0.5);
    this.set('alert', alert, () => {
      if (!this.alertEl) return;
      this.alertEl.textContent = alert;
      this.alertEl.hidden = !alert;
      this.alertEl.classList.toggle('urgent', role.alert === 'windup');
    });

    // a headset has no alert box: the warning goes where it can't be missed
    this.setHint(!keys && alert ? alert : this.hintFor(ctx, role, keys));
    if (this.helpEl && this.helpEl.innerHTML !== help) this.helpEl.innerHTML = help;
  }

  /** The closing ring round the crosshair, while you're lined up on someone's offer. */
  private showRing(role: PalRole, keys: PalKeys | null): void {
    const el = this.ringEl;
    if (!el || !this.closerEl || !this.ringLabelEl) return;
    const p = role.engaged;
    const show = !!p && !!keys && !role.swing;
    el.hidden = !show;
    if (!show || !p) return;
    const phase = role.ringPhase();
    const scale = 1 + (RING_HIT - phase) * 2.2;
    this.closerEl.style.transform = `scale(${scale.toFixed(3)})`;
    const close = Math.abs(scale - 1) < 0.12;
    el.classList.toggle('close', close);
    const label = p.offer !== Move.None ? `${MOVE_NAMES[p.offer].toUpperCase()} · ${keys.moves[p.offer]}` : 'PULLED AWAY!';
    if (this.ringLabelEl.textContent !== label) this.ringLabelEl.textContent = label;
    el.classList.toggle('yanked', p.offer === Move.None);
  }

  private hintFor(ctx: HiContext, role: PalRole, keys: PalKeys | null): string {
    const me = ctx.me!;
    const s = me.state;
    // a buddy wants a five from you
    for (const b of ctx.world.all(Buddy) as ReadonlySet<BuddyEntity>) {
      const r = b.render;
      if (r.mode === BuddyMode.Offer && r.target === me.id && role.engaged?.id !== b.id) return `${BUDDY_NAMES[r.slot]} wants a five: ${MOVE_NAMES[r.offer].toLowerCase()}. Turn to face them`;
    }
    if (role.engaged || s.offer !== Move.None) return '';
    const t = role.slapTarget;
    if (t && keys) {
      switch (role.slapCheck) {
        case 'ok':
          return `${keys.slap} to slap ${t.name}'s backside${s.sneak ? '' : ` · ${keys.sneak} so they don't hear you`}`;
        case 'theirs-off':
          return `${t.name} has butt slaps turned off`;
        case 'resting':
          return `Give ${t.name}'s backside a moment`;
        case 'mine-off':
          break;
        default:
          break;
      }
    }
    const f = role.facing;
    if (f && keys) return `Hold one out for ${f.name}: ${keys.moves[Move.High]} up high, ${keys.moves[Move.Low]} down low, ${keys.moves[Move.Fist]} fist bump, ${keys.moves[Move.Double]} double`;
    return '';
  }

  /** A five you were in: how it went, and what you got. */
  fiveNews(e: FiveEvent, swung: boolean, other: string, gets: number): void {
    const color = GRADE_COLORS[e.grade];
    const move = MOVE_NAMES[e.move].toLowerCase();
    if (clean(e.grade)) {
      this.showBanner(`${GRADE_NAMES[e.grade]}${e.streak > 1 ? ` ×${e.streak}` : ''}`, color, 1400);
      this.message(`+${gets} · ${move} with ${other}${e.air ? ' (in the air!)' : ''}`);
      return;
    }
    switch (e.grade) {
      case Grade.TooSlow:
        if (swung) {
          this.showBanner('TOO SLOW!', color, 1800);
          this.message(`${other} pulled it away`);
        } else {
          this.showBanner('GOTCHA!', '#ffd23f', 1800);
          this.message(`+${gets} · ${other} was too slow`);
        }
        break;
      case Grade.Awkward:
        this.showBanner('AWKWARD…', color, 1600);
        this.message(swung ? `That wasn't a ${move}` : `${other} went for something else`);
        break;
      case Grade.Whiff:
        if (swung) this.showBanner('WHIFF', color, 1200);
        break;
    }
  }

  /** A slap you were in. */
  slapNews(e: SlapEvent, slapper: boolean, other: string, gets: number): void {
    if (slapper) {
      if (e.denied) {
        this.showBanner('DENIED!', '#6ab8ff', 1800);
        this.message(`${other} turned round in time`);
      } else {
        this.showBanner('SLAP!', '#ff7ab8', 1500);
        this.message(`+${gets} · got ${other}'s backside`);
      }
    } else if (e.denied) {
      this.showBanner('DENIED!', '#6ab8ff', 1800);
      this.message(`+${gets} · you caught ${other} at it`);
    } else {
      this.showBanner('SLAPPED!', '#ff7ab8', 1500);
      this.message(`${other} slapped your backside!`);
    }
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
