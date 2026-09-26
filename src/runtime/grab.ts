/** Q / E hand grabbing — Half Sword's "grip" verb for bare hands.
 *
 *  Hold Q (left) or E (right) and that hand reaches for the nearest thing it
 *  can hold. With the hand's mouse button also held, the mouse aims the hand
 *  and it snaps onto anything close. What it can hold:
 *
 *    body   — wrist, forearm, neck, collar, head of another fighter.
 *             Pulling drags them (walk backwards to haul), a fast yank on the
 *             collar / neck / head throws them off balance, a yank on their
 *             sword wrist can tear the sword loose.
 *    blade  — the opponent's blade (the classic disarm). Holding it pins their
 *             blade and it can't cut you; yank to wrench it out of their
 *             hands. If your hand is free you keep it.
 *    item   — a loose sword. With no sword in hand you take it up; otherwise
 *             you carry it and drop it on release.
 *
 *  Grabbing with the sword hand isn't possible while it holds the sword; the
 *  off hand leaves the handle to grab (Half Sword's "Release" grip change).
 */

import * as THREE from "three";
import type { HalfSword, HandSide } from "./half_sword.js";
import type { Fighter } from "./combat.js";
import type { LooseSword } from "./loose_items.js";

const UP = new THREE.Vector3(0, 1, 0);
const SIDES: HandSide[] = ["Left", "Right"];

export type BodyPart = "wrist" | "forearm" | "neck" | "collar" | "head";

type Hold =
  | { kind: "body"; target: Fighter; bone: number; local: THREE.Vector3; part: BodyPart; side: HandSide | null; t: number }
  | { kind: "blade"; target: Fighter; along: number; t: number }
  | { kind: "item"; item: LooseSword; t: number };

interface Candidate {
  pos: THREE.Vector3;
  make: () => Hold;
  label: string;
  /** Items on the floor are reached by stooping, with a generous magnet. */
  low?: boolean;
}

export type GrabEvent =
  | { kind: "grab"; who: Fighter; label: string; point: THREE.Vector3 }
  | { kind: "throw"; who: Fighter; target: Fighter; point: THREE.Vector3 }
  | { kind: "disarm"; who: Fighter; target: Fighter; point: THREE.Vector3; kept: boolean }
  | { kind: "pickup"; who: Fighter; point: THREE.Vector3 }
  | { kind: "broke-free"; who: Fighter; target: Fighter; point: THREE.Vector3 };

export interface GrabWorld {
  fighters: Iterable<Fighter>;
  items: LooseSword[];
  /** Knock `f`'s sword loose; returns the spawned loose sword. */
  dropSword(f: Fighter): LooseSword | null;
  /** `f` takes up `item` in `side`'s hand. */
  pickUp(f: Fighter, item: LooseSword, side: HandSide): void;
  event(e: GrabEvent): void;
}

export interface GrabInput {
  /** Q / E held. */
  grab: Record<HandSide, boolean>;
  /** Mouse button for that hand held (aiming the hand). */
  aim: Record<HandSide, boolean>;
}

export class GrabController {
  readonly holds: Record<HandSide, Hold | null> = { Left: null, Right: null };
  private readonly prevDesired: Record<HandSide, THREE.Vector3 | null> = { Left: null, Right: null };
  private disarmCooldown = 0;
  private readonly bone: (n: string) => number;

  constructor(readonly self: Fighter, readonly hs: HalfSword, boneNameToIndex: ReadonlyMap<string, number>) {
    this.bone = (n) => {
      const i = boneNameToIndex.get(n);
      if (i === undefined) throw new Error(`grab: bone ${n} missing`);
      return i;
    };
  }

  /** Human-readable state per hand (HUD). */
  status(side: HandSide): string {
    const h = this.holds[side];
    if (!h) return this.hs.hasOverride(side) ? "reaching" : "";
    if (h.kind === "item") return this.hs.armed && this.hs.mainSide !== side ? "carrying a sword" : "sword";
    if (h.kind === "blade") return `${h.target.label}'s blade`;
    return `${h.target.label}'s ${h.part}`;
  }

  releaseAll(world: GrabWorld): void {
    for (const s of SIDES) this.release(s, world);
  }

  update(dt: number, input: GrabInput, world: GrabWorld): void {
    const hs = this.hs;
    this.disarmCooldown = Math.max(0, this.disarmCooldown - dt);
    let lean = 0;
    const self = this.self;
    const unable = (self.downTime > 0) || ((self.stagger ?? 0) > 0);

    for (const side of SIDES) {
      const want = input.grab[side] && !unable && hs.active && !this.armDisabled(side);
      // The sword hand can't grab while it holds the sword.
      const swordHand = hs.armed && hs.mainSide === side;
      if (!want || swordHand) {
        this.release(side, world);
        continue;
      }
      const shoulder = hs.shoulderPosition(side);
      const reach = hs.armReach(side);

      // Where the player wants the hand.
      let desired: THREE.Vector3;
      const hold = this.holds[side];
      if (input.aim[side]) {
        desired = hs.handTarget(side);
      } else if (hold) {
        desired = this.holdPosition(hold) ?? hs.handTarget(side);
      } else {
        desired = hs.bodyToWorld(new THREE.Vector3(side === "Right" ? 0.16 : -0.16, -0.08, 0.5));
      }

      if (!hold) {
        // --- reaching -------------------------------------------------------
        const cands = this.candidates(side, world);
        let best: Candidate | null = null, bestD = Infinity;
        const hand = hs.handPoint(side);
        for (const c of cands) {
          const fromShoulder = c.pos.distanceTo(shoulder);
          if (!c.low && fromShoulder > reach * 1.05) continue;
          // Aimed: snap only to things near the aim point. Auto: nearest.
          const d = input.aim[side] ? c.pos.distanceTo(desired) : c.pos.distanceTo(shoulder);
          const limit = input.aim[side] ? 0.24 : Infinity;
          if (c.low) {
            // Floor items: horizontal distance from the reaching hand.
            const dh = Math.hypot(c.pos.x - shoulder.x, c.pos.z - shoulder.z);
            if (dh > 0.85) continue;
          }
          if (d < limit && d < bestD) { best = c; bestD = d; }
        }
        let target = desired;
        if (best) {
          target = best.pos.clone();
          if (best.low) lean = Math.max(lean, 1);
          const close = best.low
            ? Math.hypot(hand.x - best.pos.x, hand.z - best.pos.z) < 0.4 && hand.y < 0.95
            : hand.distanceTo(best.pos) < 0.13;
          if (close) {
            const h = best.make();
            this.holds[side] = h;
            if (h.kind === "body") h.target.grabbedBy = (h.target.grabbedBy ?? 0) + 1;
            if (h.kind === "blade") { h.target.grabbedBy = (h.target.grabbedBy ?? 0) + 1; self.holdingBladeOf = h.target.id; }
            if (h.kind === "item") h.item.heldBy = self.id;
            world.event({ kind: "grab", who: self, label: best.label, point: best.pos.clone() });
          }
        }
        // Keep the reach target inside arm's length (floor items: the lean
        // brings the shoulder down to them).
        const d = target.clone().sub(shoulder);
        if (d.length() > reach && !best?.low) target = shoulder.clone().addScaledVector(d.normalize(), reach);
        hs.setHandOverride(side, target, false);
        this.prevDesired[side] = desired.clone();
        continue;
      }

      // --- holding --------------------------------------------------------------
      hold.t += dt;
      const attach = this.holdPosition(hold);
      if (!attach) { this.release(side, world); continue; }
      const prev = this.prevDesired[side] ?? desired;
      const yank = desired.clone().sub(prev).divideScalar(Math.max(dt, 1e-3));
      this.prevDesired[side] = desired.clone();
      // Pull: where the hand wants to be vs where the held thing is, plus
      // anything beyond arm's length (walking away hauls them along).
      const pull = desired.clone().sub(attach);
      const fromShoulder = attach.clone().sub(shoulder);
      const over = fromShoulder.length() - reach;
      if (over > 0) pull.addScaledVector(fromShoulder.normalize(), -over);

      if (hold.kind === "item") {
        hold.item.position.lerp(hs.handPoint(side), 1 - Math.exp(-dt * 20));
        hold.item.velocity.copy(yank).multiplyScalar(0.6);
        if (hold.t > 0.15 && !hs.armed) {
          world.pickUp(self, hold.item, side);
          world.event({ kind: "pickup", who: self, point: hold.item.position.clone() });
          this.holds[side] = null;
          hs.setHandOverride(side, null);
          continue;
        }
        hs.setHandOverride(side, hs.handTarget(side), true);
        continue;
      }

      const T = hold.target;
      if (T.breakFree) {
        T.breakFree = false;
        const away = shoulder.clone().sub(attach).setY(0).normalize();
        self.push = (self.push ?? new THREE.Vector3()).addScaledVector(away, 1.4);
        self.reactor.impulse(away, 2.2);
        world.event({ kind: "broke-free", who: self, target: T, point: attach.clone() });
        this.release(side, world);
        continue;
      }
      hs.setHandOverride(side, attach, true);

      const flat = pull.clone().setY(0);
      const yankSpeed = yank.length();
      if (hold.kind === "body") {
        // Drag: pull → imposed velocity on the held fighter.
        const push = T.push ?? (T.push = new THREE.Vector3());
        const drag = flat.clone().multiplyScalar(4.5);
        if (drag.length() > 2.4) drag.setLength(2.4);
        if (drag.lengthSq() > push.lengthSq()) push.copy(drag);
        T.reactor.impulse(pull, Math.min(pull.length(), 0.3) * 14 * dt);
        const body = hold.part === "neck" || hold.part === "collar" || hold.part === "head";
        if (body && yankSpeed > 3.0 && hold.t > 0.2) {
          // Throw: yank them off their feet.
          const dir = yank.clone().setY(0).normalize();
          T.stagger = 1.5;
          T.push = dir.clone().multiplyScalar(2.8);
          T.reactor.impulse(dir, 4.5);
          world.event({ kind: "throw", who: self, target: T, point: attach.clone() });
          this.release(side, world);
          continue;
        }
        const swordWrist = hold.part === "wrist" || hold.part === "forearm";
        if (swordWrist && T.sword?.armed && hold.side === T.sword.mainSide) {
          // Their sword arm is held: drag their grip after your hand.
          T.sword.impulseGrip(pull.clone().multiplyScalar(18 * dt));
          if (yankSpeed > 2.6 && this.disarmCooldown <= 0) {
            this.disarmCooldown = 0.4;
            if (Math.random() < 0.45) this.disarm(T, side, attach, world);
          }
        }
      } else if (hold.kind === "blade") {
        if (!T.sword?.armed) { this.release(side, world); continue; }
        // Pin their blade to your hand.
        T.sword.pushTip(pull.clone().multiplyScalar(0.35));
        T.sword.impulseGrip(pull.clone().multiplyScalar(10 * dt));
        if ((yankSpeed > 2.2 || pull.length() > 0.35) && this.disarmCooldown <= 0 && hold.t > 0.12) {
          this.disarmCooldown = 0.35;
          if (Math.random() < 0.7) this.disarm(T, side, attach, world);
        }
      }
    }

    // Stoop for things on the floor.
    const fwd = hs.bodyForward.clone();
    self.reactor.leanTarget.copy(new THREE.Vector3().crossVectors(UP, fwd).normalize().multiplyScalar(0.85 * lean));
  }

  private disarm(T: Fighter, side: HandSide, at: THREE.Vector3, world: GrabWorld): void {
    const item = world.dropSword(T);
    const hold = this.holds[side];
    if (hold && hold.kind !== "item") { T.grabbedBy = Math.max(0, (T.grabbedBy ?? 1) - 1); }
    this.self.holdingBladeOf = null;
    let kept = false;
    if (item) {
      item.cooldown = 0;
      if (!this.hs.armed) {
        // Wrench it out of their hands straight into yours.
        world.pickUp(this.self, item, side);
        kept = true;
        this.holds[side] = null;
        this.hs.setHandOverride(side, null);
      } else {
        item.heldBy = this.self.id;
        this.holds[side] = { kind: "item", item, t: 0 };
      }
    } else {
      this.holds[side] = null;
    }
    world.event({ kind: "disarm", who: this.self, target: T, point: at.clone(), kept });
  }

  private armDisabled(side: HandSide): boolean {
    return (this.self.limbs?.[side === "Left" ? "armL" : "armR"] ?? 1) <= 0;
  }

  private release(side: HandSide, world: GrabWorld): void {
    const h = this.holds[side];
    if (h) {
      if (h.kind === "item") {
        h.item.heldBy = null;
        h.item.cooldown = 0.3;
        h.item.resting = false;
        if (!world.items.includes(h.item)) world.items.push(h.item);
      } else {
        h.target.grabbedBy = Math.max(0, (h.target.grabbedBy ?? 1) - 1);
        if (h.kind === "blade") this.self.holdingBladeOf = null;
      }
    }
    this.holds[side] = null;
    this.prevDesired[side] = null;
    this.hs.setHandOverride(side, null);
  }

  private holdPosition(h: Hold): THREE.Vector3 | null {
    if (h.kind === "item") return h.item.position.clone();
    const w = h.target.agent.actor.worldMatrices;
    if (h.kind === "body") return h.local.clone().applyMatrix4(w[h.bone]);
    const s = h.target.sword;
    if (!s?.armed || !s.swordVisible) return null;
    const g = new THREE.Vector3(), t = new THREE.Vector3();
    s.bladeSegment(g, t);
    return g.lerp(t, h.along);
  }

  private candidates(side: HandSide, world: GrabWorld): Candidate[] {
    const out: Candidate[] = [];
    const shoulder = this.hs.shoulderPosition(side);
    for (const T of world.fighters) {
      if (T === this.self) continue;
      const w = T.agent.actor.worldMatrices;
      if (!w || w.length === 0) continue;
      const P = (n: string) => new THREE.Vector3().setFromMatrixPosition(w[this.bone(n)]);
      const body = (pos: THREE.Vector3, boneName: string, part: BodyPart, s: HandSide | null) => {
        const bi = this.bone(boneName);
        const local = pos.clone().applyMatrix4(w[bi].clone().invert());
        out.push({
          pos, label: `${T.label}'s ${part}`,
          make: () => ({ kind: "body", target: T, bone: bi, local, part, side: s, t: 0 }),
        });
      };
      for (const s of SIDES) {
        body(P(`${s}Hand`), `${s}Hand`, "wrist", s);
        body(P(`${s}ForeArm`).lerp(P(`${s}Hand`), 0.5), `${s}ForeArm`, "forearm", s);
      }
      const neck = P("Neck"), chest = P("Spine3"), head = P("Head");
      const fwd = neck.clone().sub(shoulder).setY(0).normalize().negate(); // toward the grabber
      body(neck.clone().addScaledVector(fwd, 0.05), "Neck", "neck", null);
      body(chest.clone().lerp(neck, 0.6).addScaledVector(fwd, 0.1), "Spine3", "collar", null);
      body(head.clone().addScaledVector(UP, 0.09), "Head", "head", null);
      // Their blade (not near the hilt).
      const s = T.sword;
      if (s?.armed && s.swordVisible) {
        const g = new THREE.Vector3(), t = new THREE.Vector3();
        s.bladeSegment(g, t);
        const ab = t.clone().sub(g);
        const u = THREE.MathUtils.clamp(shoulder.clone().sub(g).dot(ab) / ab.lengthSq(), 0.15, 0.95);
        out.push({
          pos: g.clone().addScaledVector(ab, u), label: `${T.label}'s blade`,
          make: () => ({ kind: "blade", target: T, along: u, t: 0 }),
        });
      }
    }
    for (const item of world.items) {
      if (item.heldBy || item.cooldown > 0) continue;
      const pos = item.gripPoint();
      out.push({ pos, label: "sword", low: pos.y < 0.5, make: () => ({ kind: "item", item, t: 0 }) });
    }
    return out;
  }
}
