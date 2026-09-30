import { Move } from './moves';

/** A finger that moved less than this, px, tapped. */
const TAP_SLOP = 18;
/** A tap that took longer than this, ms, was a finger resting there, not a tap. */
const TAP_MS = 450;

/** What a swipe on the pad means: up is up high, down is down low, sideways is a double, and a tap is a fist bump. */
export function swipeMove(dx: number, dy: number, ms: number): Move {
  if (Math.hypot(dx, dy) < TAP_SLOP) return ms <= TAP_MS ? Move.Fist : Move.None;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? Move.High : Move.Low;
  return Move.Double;
}

/**
 * The pad a touch player gives five on: swipe up for up high, down for down low, sideways for a double, and tap for a
 * fist bump. The move goes when the finger lifts, which is the moment the timing ring grades. A DOM overlay over the
 * look zone, so a finger on it doesn't turn the view.
 */
export class SwipePad {
  private readonly el = document.createElement('div');
  private readonly fingers = new Map<number, { x: number; y: number; at: number }>();
  private move = Move.None;
  private readonly ac = new AbortController();

  constructor(parent: HTMLElement = document.body) {
    this.el.className = 'swipe-pad';
    this.el.innerHTML = '<i class="up">✋</i><i class="down">🫴</i><i class="side">🙌</i><b>👊</b><small>SWIPE TO FIVE</small>';
    const signal = this.ac.signal;
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer ended before this ran */
        }
        this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, at: e.timeStamp });
        this.el.classList.add('held');
        e.preventDefault();
        e.stopPropagation();
      },
      { signal },
    );
    const up = (e: PointerEvent) => {
      const f = this.fingers.get(e.pointerId);
      if (!f) return;
      this.fingers.delete(e.pointerId);
      if (!this.fingers.size) this.el.classList.remove('held');
      const move = swipeMove(e.clientX - f.x, e.clientY - f.y, e.timeStamp - f.at);
      if (move !== Move.None) this.move = move;
      e.stopPropagation();
    };
    this.el.addEventListener('pointerup', up, { signal });
    this.el.addEventListener(
      'pointercancel',
      (e) => {
        this.fingers.delete(e.pointerId);
        if (!this.fingers.size) this.el.classList.remove('held');
      },
      { signal },
    );
    parent.appendChild(this.el);
  }

  /** The move swiped since last asked, if any. */
  take(): Move {
    const m = this.move;
    this.move = Move.None;
    return m;
  }

  setActive(active: boolean): void {
    this.el.hidden = !active;
    if (!active) this.move = Move.None;
  }

  dispose(): void {
    this.ac.abort();
    this.el.remove();
  }
}
