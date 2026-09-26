/** Gamepad teleop (standard mapping), polled once per frame.
 *
 *  Mirrors the velocity-command style of robot teleop (e.g. GR00T WBC's
 *  joystick streamer): the left stick is a planar velocity command, the right
 *  stick a facing command, triggers modulate speed.
 *
 *    Left stick    move            Right stick   facing (biped)
 *    RT            sprint / canter LT            walk (quadruped)
 *    LB / RB       previous / next style (biped)
 *    A / B / X     sit / stand / lie (quadruped)
 *    Y             switch controlled character
 */

const DEADZONE = 0.15;

function deadzone(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  // Rescale so output starts from 0 just outside the deadzone.
  const s = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
  return [x * s, y * s];
}

export class GamepadInput {
  /** Left stick, y up-positive (forward). */
  move: [number, number] = [0, 0];
  /** Right stick, y up-positive. */
  look: [number, number] = [0, 0];
  sprint = 0;
  slow = 0;
  connected = false;

  private prev: boolean[] = [];
  private pressed = new Set<number>();

  /** Read the first connected pad. Cheap no-op when none is present. */
  poll(): void {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    this.connected = pad !== null;
    if (!pad) {
      this.move = [0, 0]; this.look = [0, 0]; this.sprint = 0; this.slow = 0;
      return;
    }
    const ax = (i: number) => pad.axes[i] ?? 0;
    const [mx, my] = deadzone(ax(0), ax(1));
    const [lx, ly] = deadzone(ax(2), ax(3));
    this.move = [mx, -my];
    this.look = [lx, -ly];
    this.slow = pad.buttons[6]?.value ?? 0;
    this.sprint = pad.buttons[7]?.value ?? 0;
    pad.buttons.forEach((b, i) => {
      if (b.pressed && !this.prev[i]) this.pressed.add(i);
      this.prev[i] = b.pressed;
    });
  }

  /** True while the left stick is deflected (pad overrides keys then). */
  get moving(): boolean { return this.move[0] !== 0 || this.move[1] !== 0; }
  get looking(): boolean { return this.look[0] !== 0 || this.look[1] !== 0; }
  get moveMagnitude(): number { return Math.min(1, Math.hypot(this.move[0], this.move[1])); }

  /** Edge-triggered button press (consumed on read). */
  consume(button: number): boolean {
    const had = this.pressed.has(button);
    this.pressed.delete(button);
    return had;
  }

  isHeld(button: number): boolean { return this.prev[button] === true; }
}

export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5 } as const;
