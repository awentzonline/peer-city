import { TouchInput, type TouchTuning, type TouchZone } from './touch';

/**
 * The on-screen controls a touch frontend builds: two invisible zones (walk on the left, look everywhere
 * else), a floating stick under the walking thumb, round buttons by the right thumb, small chips along the
 * top, and a strip of tool slots. Buttons feed the same `TouchInput` the zones do, so a frontend reads
 * `pressed('jump')` exactly as a desktop one reads `pressed('Space')`.
 *
 * It's a DOM overlay rather than geometry in the scene because the phone's screen is the device here, the
 * same way the desktop HUD is the desktop's. A headset never builds one.
 */
export interface TouchButtonSpec {
  /** What `TouchInput.down` and `pressed` call it. */
  id: string;
  label: string;
  /** A second, smaller line: what the button does. */
  hint?: string;
  /** A round button by the right thumb, or a small pill along the top. */
  kind?: 'pad' | 'chip';
  /** The big one under the thumb, e.g. fire. */
  big?: boolean;
  /** Start hidden; `setVisible` shows it (e.g. the horn, only in a car). */
  hidden?: boolean;
}

/** One tool the player can put in hand, drawn as a slot in the strip. */
export interface TouchSlot {
  name: string;
  /** Rounds, arrows, seeds: left off when the tool never runs out. */
  charges: number;
  current: boolean;
}

interface ButtonEls {
  el: HTMLButtonElement;
  label: HTMLElement;
  hint: HTMLElement;
}

export class TouchControls {
  readonly input: TouchInput;
  private readonly root = document.createElement('div');
  private readonly stick = document.createElement('div');
  private readonly knob = document.createElement('i');
  private readonly pad = document.createElement('div');
  private readonly chips = document.createElement('div');
  private readonly strip = document.createElement('div');
  private readonly buttons = new Map<string, ButtonEls>();
  private readonly onChip: (id: string) => void;
  /** What the strip is showing, so it's only rebuilt when it changes. */
  private slotSig = '';
  private slots = 0;

  constructor(opts: { buttons: TouchButtonSpec[]; onChip?: (id: string) => void; tuning?: TouchTuning; parent?: HTMLElement }) {
    this.input = new TouchInput(opts.tuning);
    this.onChip = opts.onChip ?? (() => {});
    this.root.className = 'touch-ui';
    this.root.appendChild(this.zone('look', 'touch-look'));
    this.root.appendChild(this.zone('stick', 'touch-walk'));

    this.stick.className = 'touch-stick';
    this.stick.appendChild(this.knob);
    this.pad.className = 'touch-pad';
    this.chips.className = 'touch-chips';
    this.strip.className = 'touch-strip';
    this.root.append(this.stick, this.pad, this.chips, this.strip);
    for (const spec of opts.buttons) this.build(spec);

    // A long press mustn't select text or pop the callout menu over the controls.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', this.onBlur);
    (opts.parent ?? document.body).appendChild(this.root);
  }

  /** Hide the controls and drop every touch, e.g. while the settings menu is up or you're dead. */
  setActive(active: boolean): void {
    if (this.root.classList.contains('off') === !active) return;
    this.root.classList.toggle('off', !active);
    if (!active) this.input.clear();
    this.drawStick();
  }

  setLabel(id: string, label: string, hint?: string): void {
    const b = this.buttons.get(id);
    if (!b) return;
    if (b.label.textContent !== label) b.label.textContent = label;
    if (hint !== undefined && b.hint.textContent !== hint) b.hint.textContent = hint;
  }

  setVisible(id: string, visible: boolean): void {
    const b = this.buttons.get(id);
    if (b && b.el.hidden === visible) {
      b.el.hidden = !visible;
      if (!visible) this.input.release(id);
    }
  }

  /** The tool strip. Tapping slot `i` presses `slot<i>`, which the frontend turns into a tool. */
  setSlots(slots: TouchSlot[]): void {
    const sig = slots.map((s) => `${s.name}|${Number.isFinite(s.charges) ? s.charges : ''}|${s.current ? 1 : 0}`).join(',');
    if (sig === this.slotSig) return;
    this.slotSig = sig;
    if (slots.length !== this.slots) {
      this.slots = slots.length;
      this.strip.replaceChildren(...slots.map((_, i) => this.slot(i)));
    }
    slots.forEach((s, i) => {
      const el = this.strip.children[i] as HTMLElement;
      el.classList.toggle('on', s.current);
      el.firstChild!.textContent = s.name;
      el.lastChild!.textContent = Number.isFinite(s.charges) ? String(s.charges) : '';
    });
  }

  dispose(): void {
    window.removeEventListener('blur', this.onBlur);
    this.root.remove();
  }

  /** Called every frame the stick may have moved: the knob follows the thumb. */
  drawStick(): void {
    const p = this.input.stickPose;
    this.stick.classList.toggle('on', p.active);
    if (!p.active) return;
    this.stick.style.transform = `translate(${p.ox}px, ${p.oy}px)`;
    this.knob.style.transform = `translate(${p.kx}px, ${p.ky}px)`;
  }

  private onBlur = (): void => this.input.clear();

  private zone(zone: TouchZone, className: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `touch-zone ${className}`;
    el.addEventListener('pointerdown', (e) => {
      capture(el, e);
      this.input.pointerDown(e.pointerId, e.clientX, e.clientY, zone, e.timeStamp);
      if (zone === 'stick') this.drawStick();
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      this.input.pointerMove(e.pointerId, e.clientX, e.clientY);
      if (zone === 'stick') this.drawStick();
    });
    const up = (e: PointerEvent) => {
      this.input.pointerUp(e.pointerId, e.timeStamp);
      if (zone === 'stick') this.drawStick();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => {
      this.input.cancel(e.pointerId);
      if (zone === 'stick') this.drawStick();
    });
    return el;
  }

  private build(spec: TouchButtonSpec): void {
    const el = document.createElement('button');
    const chip = spec.kind === 'chip';
    el.className = `touch-btn ${chip ? 'touch-chip' : 'touch-round'}${spec.big ? ' big' : ''}`;
    el.hidden = !!spec.hidden;
    const label = document.createElement('b');
    label.textContent = spec.label;
    const hint = document.createElement('small');
    hint.textContent = spec.hint ?? '';
    el.append(label, hint);
    // Chips are one-shot (settings, microphone); pad buttons are held, so an automatic weapon keeps firing.
    if (chip) {
      el.addEventListener('click', () => this.onChip(spec.id));
    } else {
      el.addEventListener('pointerdown', (e) => {
        capture(el, e);
        el.classList.add('held');
        this.input.press(spec.id);
        e.preventDefault();
      });
      const up = () => {
        el.classList.remove('held');
        this.input.release(spec.id);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    (chip ? this.chips : this.pad).appendChild(el);
    this.buttons.set(spec.id, { el, label, hint });
  }

  private slot(i: number): HTMLElement {
    const el = document.createElement('button');
    el.className = 'touch-slot';
    el.append(document.createElement('b'), document.createElement('small'));
    el.addEventListener('pointerdown', (e) => {
      this.input.tap(`slot${i}`);
      e.preventDefault();
    });
    return el;
  }
}

/**
 * Follow a finger even when it slides off the control it started on, which thumbs do constantly. A pointer
 * that's already gone can't be captured, and that's not worth losing the press over.
 */
function capture(el: HTMLElement, e: PointerEvent): void {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* the pointer ended before this ran */
  }
}
