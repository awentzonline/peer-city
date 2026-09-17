import { HudBase } from '../crossplay/hud';
import { drawMinimap, type MinimapBase, type MinimapDot } from '../crossplay/minimap';
import { Club, Flight, carry } from './ball';
import type { GolfContext, GolferEntity } from './context';
import { HALF, HOLES, LIE_NAMES } from './course';
import { BallMode, Cart, Golfer as GolferDef, Phase } from './defs';
import { ADDRESS_RANGE, driverOf, type Golfer } from './golfer';
import { TOOLS } from './kit';
import { clock, formatToPar, holesPlayed, standings, toPar } from './match';
import { cssColor, golferColor } from './models';

export interface StandingLine {
  place: string;
  name: string;
  /** Holes played: "thru 3", or "F" for the whole round. */
  thru: string;
  score: string;
  me: boolean;
}

/** How a platform names its controls, for the hints. */
export interface GolfKeys {
  /** Playing the ball from over it: "Hold click to draw back, let go to swing". */
  swing: string;
  /** Standing over your ball from nearby: "F". */
  address: string;
  /** Getting in and out of a cart: "E". */
  cart: string;
  /** The row of controls along the bottom, as HTML, or ''. */
  help: string;
}

/**
 * Status and announcements (see crossplay/hud.ts): the hole and its clock, your ball, the swing meter, the
 * leaderboard and scorecard, and a minimap to find your ball by. A headset paints the same state onto its watch
 * (wrist.ts). Frontends call `showGolfer` every frame.
 */
export class Hud extends HudBase {
  phase = '';
  hole = '';
  ball = '';
  club = '';
  /** 0..1 while standing over the ball on a crosshair, or -1. */
  meter = -1;
  carry = '';
  drive = '';
  lines: StandingLine[] = [];
  /** The scorecard: each golfer's strokes per hole, for everyone playing the round. */
  card: { name: string; strokes: number[]; score: string; me: boolean }[] = [];
  pars: number[] = [];

  private readonly phaseEl = document.getElementById('phase')!;
  private readonly holeEl = document.getElementById('hole-info')!;
  private readonly ballEl = document.getElementById('ball-info')!;
  private readonly clubsEl = document.getElementById('clubs')!;
  private readonly meterEl = document.getElementById('meter')!;
  private readonly meterFillEl = document.getElementById('meter-fill')!;
  private readonly carryEl = document.getElementById('carry')!;
  private readonly driveEl = document.getElementById('drive')!;
  private readonly standingsEl = document.getElementById('standings')!;
  private readonly cardEl = document.getElementById('card')!;
  private readonly helpEl = document.getElementById('help')!;
  private readonly minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private readonly mctx = this.minimap.getContext('2d')!;
  private map: MinimapBase | null = null;
  private standingsDrawn = '';
  private cardDrawn = '';
  private clubsDrawn = '';
  private seated = false;
  private nextMap = 0;
  private dots: MinimapDot[] = [];

  /** The picture of the course the minimap is drawn over (see scenery.ts). */
  setMap(image: HTMLCanvasElement): void {
    this.map = { image, x: 0, y: 0, w: HALF * 2, h: HALF * 2, background: '#3f6b30', smooth: true };
  }

  /** No crosshair while driving. */
  protected override showCursor(): void {
    super.showCursor();
    if (this.seated && this.crosshairEl) this.crosshairEl.hidden = true;
  }

  /** The golfer's state, worded for the platform. `showCard` holds the scorecard open. */
  showGolfer(ctx: GolfContext, g: Golfer, keys: GolfKeys, showCard = false): void {
    const me = ctx.me;
    const ball = ctx.ball;
    const match = ctx.match();
    if (!me || !ball) return;
    const s = me.state;
    const b = ball.state;
    const { course } = ctx;
    if (g.seated !== this.seated) {
      this.seated = g.seated;
      this.driveEl.hidden = !g.seated;
      this.showCursor();
    }

    // the hole and its clock, top middle
    let phase = 'LOOKING FOR THE FIRST TEE…';
    let hole = '';
    const m = match?.state;
    if (m) {
      const h = course.holes[m.hole];
      switch (m.phase) {
        case Phase.Playing:
          phase = `HOLE ${m.hole + 1} · PAR ${h.par} · ${clock(m.timer)}${m.first ? ' left' : ''}`;
          break;
        case Phase.HoleOver:
          phase = `HOLE ${m.hole + 1} OVER · ${m.hole + 1 < HOLES ? `next tee in ${Math.ceil(m.timer)}s` : `results in ${Math.ceil(m.timer)}s`}`;
          break;
        case Phase.Results:
          phase = `ROUND ${m.round} OVER · new round in ${Math.ceil(m.timer)}s`;
          break;
      }
      hole = `Hole ${m.hole + 1} · Par ${h.par} · ${Math.round(h.length)} m`;
    }
    this.set('phase', phase, () => (this.phaseEl.textContent = phase));
    this.set('hole', hole, () => (this.holeEl.textContent = hole));

    // your ball
    const par = course.holes[Math.min(HOLES - 1, b.hole)].par;
    const onHole = !!m && b.round === m.round && b.hole === m.hole;
    const pin = g.hole.pin;
    const toPin = Math.round(Math.hypot(g.sim.x - pin.x, g.sim.y - pin.y));
    let ballText = '';
    if (!onHole) ballText = '';
    else if (b.mode === BallMode.Holed) ballText = `Holed in ${b.strokes} · par ${par}`;
    else if (b.mode === BallMode.Out) ballText = b.strokes ? `Picked up after ${b.strokes}` : '';
    else if (b.mode === BallMode.Moving) ballText = `Stroke ${b.strokes} · ${g.sim.flight === Flight.Air ? 'in the air' : 'rolling'} · ${toPin} m to the pin`;
    else ballText = `Stroke ${b.strokes + 1} · ${LIE_NAMES[g.lie]} · ${toPin} m to the pin`;
    this.set('ball', ballText, () => (this.ballEl.textContent = ballText));

    const club = g.inventory.current?.name ?? '';
    this.set('club', club, () => {});
    const clubsKey = `${g.inventory.current?.id}`;
    if (clubsKey !== this.clubsDrawn) {
      this.clubsDrawn = clubsKey;
      this.clubsEl.textContent = '';
      TOOLS.all.forEach((tool, i) => {
        const el = document.createElement('div');
        el.className = tool === g.inventory.current ? 'on' : '';
        el.textContent = `${i + 1} ${tool.name}`;
        this.clubsEl.appendChild(el);
      });
    }

    // the swing meter, while standing over the ball
    const meter = g.addressing ? Math.round(g.charge * 100) / 100 : -1;
    this.set('meter', meter, () => {
      this.meterEl.hidden = meter < 0;
      this.meterFillEl.style.height = `${Math.max(0, meter) * 100}%`;
    });
    let carryText = '';
    if (g.addressing) {
      const full = carry(g.sim, g.club, 1, g.aimHeading, g.lie, course);
      const d = Math.round(Math.hypot(full.x - g.sim.x, full.y - g.sim.y));
      carryText = `${club} · full swing ${g.club === Club.Putter ? 'rolls' : 'carries'} ~${d} m`;
      if (g.charging) {
        const now = carry(g.sim, g.club, g.charge, g.aimHeading, g.lie, course);
        carryText = `${Math.round(g.charge * 100)}% · ~${Math.round(Math.hypot(now.x - g.sim.x, now.y - g.sim.y))} m`;
      }
    }
    this.set('carry', carryText, () => (this.carryEl.textContent = carryText));

    // driving
    if (g.seated && g.cart) {
      const drive = `${Math.round(Math.abs(g.cart.state.speed) * 3.6)} km/h`;
      this.set('drive', drive, () => (this.driveEl.textContent = drive));
    }

    // the leaderboard, top left
    const round = m?.round ?? 0;
    const order = standings(ctx.world, round, course);
    const lines = order.map((x, i) => line(x, i, order, me, course));
    const key = lines.map((l) => `${l.place}${l.name}${l.thru}${l.score}`).join('|');
    if (key !== this.standingsDrawn) {
      this.standingsDrawn = key;
      this.lines = lines;
      this.standingsEl.textContent = '';
      for (const l of lines.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = l.me ? 'me' : '';
        row.innerHTML = '<b></b><span></span><small></small><em></em>';
        row.children[0].textContent = l.place;
        row.children[1].textContent = l.name;
        row.children[2].textContent = l.thru;
        row.children[3].textContent = l.score;
        this.standingsEl.appendChild(row);
      }
      this.version++;
    }

    // the scorecard: between holes, or held open
    const open = showCard || (!!m && m.phase !== Phase.Playing);
    this.cardEl.hidden = !open;
    if (open) this.drawCard(ctx, order, me);

    this.setHint(this.hintFor(ctx, g, keys));
    if (this.helpEl.innerHTML !== keys.help) this.helpEl.innerHTML = keys.help;
    if (ctx.now >= this.nextMap) {
      this.nextMap = ctx.now + 120;
      this.dots = mapDots(ctx);
      const heading = g.seated && g.cart ? g.heading : s.yaw;
      this.drawMinimap(this.mctx, this.minimap.width, s.x, s.y, heading);
    }
  }

  /** Heading-up circular map of the course round (cx, cy). */
  drawMinimap(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, heading: number, viewRadius = 130): void {
    if (this.map) drawMinimap(ctx, size, this.map, cx, cy, heading, this.dots, viewRadius);
  }

  private hintFor(ctx: GolfContext, g: Golfer, keys: GolfKeys): string {
    const s = ctx.me!.state;
    if (g.down) return 'Seeing stars…';
    if (g.seated) return `${keys.cart} to get out`;
    if (g.addressing) return g.charging ? '' : keys.swing;
    const m = ctx.match()?.state;
    if (!m) return '';
    if (m.phase !== Phase.Playing) return m.phase === Phase.HoleOver && m.hole + 1 < HOLES ? `Head for hole ${m.hole + 2}: the next tee's close by` : '';
    const cart = g.nearestFreeCart();
    if (g.playable) {
      const d = Math.hypot(s.x - g.sim.x, s.y - g.sim.y);
      if (d < 6 && keys.address) return `${keys.address} to stand over your ball`;
      if (cart && d > 30) return `${keys.cart} to drive the cart · your ball is ${Math.round(d)} m away`;
      if (d > ADDRESS_RANGE) return `Your ball is ${Math.round(d)} m away: walk up to it to play it`;
      return '';
    }
    if (cart) return `${keys.cart} to drive the cart`;
    return '';
  }

  private drawCard(ctx: GolfContext, order: GolferEntity[], me: GolferEntity): void {
    const { course } = ctx;
    const card = order.map((g) => ({ name: g.render.name, strokes: [...g.render.card], score: formatToPar(toPar(g.render.card, course)), me: g === me }));
    const key = card.map((c) => `${c.name}:${c.strokes.join(',')}`).join('|');
    if (key === this.cardDrawn) return;
    this.cardDrawn = key;
    this.card = card;
    this.pars = course.holes.map((h) => h.par);
    const cell = (tag: string, text: string, cls = '') => `<${tag}${cls ? ` class="${cls}"` : ''}>${text}</${tag}>`;
    let html = `<table><tr>${cell('th', 'Hole')}${this.pars.map((_, i) => cell('th', String(i + 1))).join('')}${cell('th', '')}</tr>`;
    html += `<tr class="par">${cell('td', 'Par')}${this.pars.map((p) => cell('td', String(p))).join('')}${cell('td', String(this.pars.reduce((a, b) => a + b, 0)))}</tr>`;
    for (const c of card) {
      const row = c.strokes.map((n, i) => cell('td', n ? String(n) : '·', n ? scoreClass(n, this.pars[i]) : ''));
      html += `<tr${c.me ? ' class="me"' : ''}>${cell('td', escapeHtml(c.name))}${row.join('')}${cell('td', c.score)}</tr>`;
    }
    this.cardEl.innerHTML = `${html}</table>`;
    this.version++;
  }
}

function line(g: GolferEntity, i: number, order: GolferEntity[], me: GolferEntity, course: GolfContext['course']): StandingLine {
  const played = holesPlayed(g.render.card);
  const score = toPar(g.render.card, course);
  // tied golfers share a place
  const first = order.findIndex((o) => toPar(o.render.card, course) === score && holesPlayed(o.render.card) > 0);
  const place = !played ? '–' : `${first < i && first >= 0 ? 'T' : ''}${(first >= 0 ? first : i) + 1}`;
  return { place, name: g.render.name, thru: played === HOLES ? 'F' : played ? `thru ${played}` : '', score: played ? formatToPar(score) : '', me: g === me };
}

function scoreClass(strokes: number, par: number): string {
  const d = strokes - par;
  return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? '' : d === 1 ? 'bogey' : 'double';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** What the map shows: everyone else in their colours, carts, the pin, and your ball. */
export function mapDots(ctx: GolfContext): MinimapDot[] {
  const dots: MinimapDot[] = [];
  const m = ctx.match()?.state;
  for (const cart of ctx.world.all(Cart)) dots.push({ x: cart.x, y: cart.y, color: driverOf(ctx, cart) ? '#dfe6e9' : '#b2bec3', size: 2.6 });
  for (const g of ctx.world.all(GolferDef)) if (g !== ctx.me) dots.push({ x: g.x, y: g.y, color: cssColor(golferColor(g.render.skin)), size: 3.2 });
  if (m) {
    const pin = ctx.course.holes[m.hole].pin;
    dots.push({ x: pin.x, y: pin.y, color: '#ff3b30', size: 3.6 });
  }
  const b = ctx.ball;
  if (b && (b.state.mode === BallMode.Rest || b.state.mode === BallMode.Moving)) dots.push({ x: b.x, y: b.y, color: '#ffffff', size: 3.4 });
  return dots;
}
