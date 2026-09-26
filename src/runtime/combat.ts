/** Blade collision + melee combat on top of the Half Sword controller.
 *
 *  - Every biped gets a set of body capsules rebuilt each frame from the
 *    skeleton pose the GPU just received (head, neck, torso, arms, legs).
 *  - Blades are segments (crossguard → tip). Each frame, every sword is tested
 *    against the other swords (parries / binds) and against other bodies.
 *  - Contacts are resolved on the simulated sword: the blade can't pass
 *    through a body or another blade, it bounces off with an impulse at the
 *    contact point, so cuts stop on impact and parries knock blades aside.
 *  - Hits deal damage scaled by the blade speed at the contact point and the
 *    body zone (head > neck > torso > legs > arms); tip-first contacts moving
 *    along the blade count as thrusts. Targets flinch through a spring-driven
 *    spine / neck bend (HitReactor).
 */

import * as THREE from "three";
import type { HalfSword } from "./half_sword.js";
import type { NMMAgent } from "../engine/NMMAgent.js";

const UP = new THREE.Vector3(0, 1, 0);

export type Zone = "head" | "neck" | "torso" | "arm" | "leg";
const ZONE_DAMAGE: Record<Zone, number> = { head: 1.8, neck: 1.6, torso: 1.0, arm: 0.55, leg: 0.7 };

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Closest points between segments p1q1 and p2q2 (Ericson, RTCD 5.1.9).
 *  Returns params s (on 1) and t (on 2) plus squared distance. */
export function closestSegSeg(
  p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3,
  c1: THREE.Vector3, c2: THREE.Vector3,
): { s: number; t: number; dist2: number } {
  const d1 = _v1.subVectors(q1, p1), d2 = _v2.subVectors(q2, p2), r = _v3.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), denom = a * e - b * b;
      s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return { s, t, dist2: c1.distanceToSquared(c2) };
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Body capsules
// ---------------------------------------------------------------------------

export interface Capsule { a: THREE.Vector3; b: THREE.Vector3; r: number; zone: Zone }

const CAPSULE_DEFS: [string, string, number, Zone][] = [
  ["Hips", "Spine2", 0.14, "torso"],
  ["Spine2", "Neck", 0.14, "torso"],
  ["Neck", "Head", 0.06, "neck"],
  ["LeftArm", "LeftForeArm", 0.055, "arm"],
  ["LeftForeArm", "LeftHand", 0.045, "arm"],
  ["RightArm", "RightForeArm", 0.055, "arm"],
  ["RightForeArm", "RightHand", 0.045, "arm"],
  ["LeftUpLeg", "LeftLeg", 0.08, "leg"],
  ["LeftLeg", "LeftFoot", 0.06, "leg"],
  ["RightUpLeg", "RightLeg", 0.08, "leg"],
  ["RightLeg", "RightFoot", 0.06, "leg"],
];

export class BodyColliders {
  private readonly defs: { a: number; b: number; r: number; zone: Zone }[];
  private readonly neck: number;
  private readonly head: number;

  constructor(boneNameToIndex: Map<string, number>) {
    const idx = (n: string) => {
      const i = boneNameToIndex.get(n);
      if (i === undefined) throw new Error(`combat: bone ${n} missing`);
      return i;
    };
    this.defs = CAPSULE_DEFS.map(([a, b, r, zone]) => ({ a: idx(a), b: idx(b), r, zone }));
    this.neck = idx("Neck");
    this.head = idx("Head");
  }

  /** Capsules for one pose (fresh vectors — callers may keep them a frame). */
  build(world: readonly THREE.Matrix4[]): Capsule[] {
    const caps: Capsule[] = this.defs.map((d) => ({
      a: new THREE.Vector3().setFromMatrixPosition(world[d.a]),
      b: new THREE.Vector3().setFromMatrixPosition(world[d.b]),
      r: d.r, zone: d.zone,
    }));
    // Skull: from the head joint up along the neck → head direction.
    const n = new THREE.Vector3().setFromMatrixPosition(world[this.neck]);
    const h = new THREE.Vector3().setFromMatrixPosition(world[this.head]);
    const up = h.clone().sub(n).normalize();
    caps.push({ a: h.clone().addScaledVector(up, 0.04), b: h.clone().addScaledVector(up, 0.13), r: 0.095, zone: "head" });
    return caps;
  }
}

// ---------------------------------------------------------------------------
// Hit reactions
// ---------------------------------------------------------------------------

/** Spring-driven flinch: the upper body bends away from a blow and wobbles
 *  back. Applied as rotations about Spine1 / Spine3 / Neck to their whole
 *  subtrees (arms and the sword grip ride along before arm IK runs). */
export class HitReactor {
  private readonly rotVec = new THREE.Vector3();   // axis * angle
  private readonly angVel = new THREE.Vector3();
  private readonly pivots: { idx: number; share: number; subtree: number[] }[];

  constructor(parents: readonly number[], boneNameToIndex: Map<string, number>) {
    const children: number[][] = parents.map(() => []);
    parents.forEach((p, i) => { if (p >= 0) children[p].push(i); });
    const subtree = (root: number) => {
      const out: number[] = [];
      const stack = [root];
      while (stack.length) { const i = stack.pop()!; out.push(i); stack.push(...children[i]); }
      return out;
    };
    this.pivots = ([["Spine1", 0.35], ["Spine3", 0.3], ["Neck", 0.35]] as [string, number][])
      .map(([n, share]) => {
        const idx = boneNameToIndex.get(n)!;
        return { idx, share, subtree: subtree(idx) };
      });
  }

  /** Push the upper body along horizontal direction `dir` (world). */
  impulse(dir: THREE.Vector3, strength: number): void {
    const d = dir.clone().setY(0);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    const axis = new THREE.Vector3().crossVectors(UP, d);
    this.angVel.addScaledVector(axis, strength);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const k = 110, c = 2 * Math.sqrt(k) * 0.42;   // slightly under-damped wobble
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.angVel.addScaledVector(this.rotVec, -k * h).addScaledVector(this.angVel, -c * h);
      this.rotVec.addScaledVector(this.angVel, h);
    }
    const max = 0.7;
    if (this.rotVec.length() > max) this.rotVec.setLength(max);
  }

  get active(): boolean { return this.rotVec.lengthSq() > 1e-7 || this.angVel.lengthSq() > 1e-6; }

  apply(world: THREE.Matrix4[]): void {
    const angle = this.rotVec.length();
    if (angle < 1e-4) return;
    const axis = this.rotVec.clone().divideScalar(angle);
    const q = new THREE.Quaternion(), m = new THREE.Matrix4(), t1 = new THREE.Matrix4(), t2 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (const pv of this.pivots) {
      q.setFromAxisAngle(axis, angle * pv.share);
      p.setFromMatrixPosition(world[pv.idx]);
      m.makeRotationFromQuaternion(q);
      t1.makeTranslation(p.x, p.y, p.z).multiply(m).multiply(t2.makeTranslation(-p.x, -p.y, -p.z));
      for (const i of pv.subtree) world[i].premultiply(t1);
    }
  }
}

// ---------------------------------------------------------------------------
// Fighters + contact resolution
// ---------------------------------------------------------------------------

export interface Fighter {
  id: string;
  label: string;
  agent: NMMAgent;
  reactor: HitReactor;
  /** The sword this fighter wields right now (null = unarmed). */
  sword: HalfSword | null;
  health: number;
  maxHealth: number;
  /** Multiplier on the damage this fighter's blade deals. */
  damageScale?: number;
  /** Seconds left of being "down" (no damage taken, no control). */
  downTime: number;
  capsules: Capsule[];
}

export type CombatEvent =
  | { kind: "hit"; attacker: Fighter; target: Fighter; point: THREE.Vector3; dir: THREE.Vector3;
      speed: number; damage: number; zone: Zone; thrust: boolean }
  | { kind: "parry"; a: Fighter; b: Fighter; point: THREE.Vector3; normal: THREE.Vector3; speed: number }
  | { kind: "graze"; attacker: Fighter; target: Fighter; point: THREE.Vector3; speed: number }
  | { kind: "down"; target: Fighter };

const BLADE_RADIUS = 0.018;
const HIT_SPEED = 2.2;       // m/s at the contact point to count as a blow
const HIT_COOLDOWN = 0.35;   // s between damaging hits from one blade on one target
const PARRY_COOLDOWN = 0.12;

export class CombatSystem {
  readonly fighters = new Map<string, Fighter>();
  private time = 0;
  private readonly cooldown = new Map<string, number>();
  /** Last frame's blade segment per fighter, for swept (anti-tunnelling)
   *  contact tests. */
  private readonly prevBlade = new Map<string, { g: THREE.Vector3; t: THREE.Vector3 }>();

  constructor(private readonly colliders: BodyColliders) {}

  add(f: Fighter): void { this.fighters.set(f.id, f); }
  remove(id: string): void { this.fighters.delete(id); }

  /** Run after the engines have written this frame's poses. */
  step(dt: number): CombatEvent[] {
    this.time += dt;
    const events: CombatEvent[] = [];
    const list = [...this.fighters.values()];
    for (const f of list) {
      f.capsules = this.colliders.build(f.agent.actor.worldMatrices as THREE.Matrix4[]);
      if (f.downTime > 0) {
        f.downTime -= dt;
        if (f.downTime <= 0) f.health = f.maxHealth;
      }
    }

    const armed = list.filter((f) => f.sword?.ready && f.sword.swordVisible);
    type Seg = { g: THREE.Vector3; t: THREE.Vector3; pg: THREE.Vector3; pt: THREE.Vector3; vg: THREE.Vector3; vt: THREE.Vector3 };
    const seg = new Map<Fighter, Seg>();
    for (const f of armed) {
      const g = new THREE.Vector3(), t = new THREE.Vector3();
      f.sword!.bladeSegment(g, t);
      const prev = this.prevBlade.get(f.id);
      // Ignore huge jumps (teleports, first frame) — treat as no sweep.
      const swept = prev && prev.t.distanceTo(t) < 1.5;
      seg.set(f, {
        g, t, pg: swept ? prev.g.clone() : g.clone(), pt: swept ? prev.t.clone() : t.clone(),
        vg: f.sword!.gripVelocity(), vt: f.sword!.tipVelocity(),
      });
    }
    for (const id of [...this.prevBlade.keys()]) if (!armed.some((f) => f.id === id)) this.prevBlade.delete(id);
    /** Blade segment `u` of the way from last frame's pose to this one. */
    const at = (sg: Seg, u: number) => ({
      g: sg.pg.clone().lerp(sg.g, u), t: sg.pt.clone().lerp(sg.t, u),
    });
    const SUB = 4;
    const velAt = (s: { vg: THREE.Vector3; vt: THREE.Vector3 }, u: number) =>
      s.vg.clone().lerp(s.vt, u);

    // --- blade vs blade -------------------------------------------------
    const c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
    for (let i = 0; i < armed.length; i++) for (let j = i + 1; j < armed.length; j++) {
      const A = armed[i], B = armed[j];
      const sa = seg.get(A)!, sb = seg.get(B)!;
      const minD = 2 * BLADE_RADIUS;
      // Swept test: first sub-step where the blades touch.
      let contact: { s: number; t: number; dist: number; k: number; a: ReturnType<typeof at>; b: ReturnType<typeof at> } | null = null;
      for (let k = 1; k <= SUB && !contact; k++) {
        const a = at(sa, k / SUB), b = at(sb, k / SUB);
        const r = closestSegSeg(a.g, a.t, b.g, b.t, c1, c2);
        if (r.dist2 <= minD * minD) contact = { s: r.s, t: r.t, dist: Math.sqrt(r.dist2), k, a, b };
      }
      if (!contact) continue;
      const { s, t, dist, k } = contact;
      const n = dist > 1e-5 ? c1.clone().sub(c2).divideScalar(dist)
        : new THREE.Vector3().crossVectors(contact.a.t.clone().sub(contact.a.g), contact.b.t.clone().sub(contact.b.g)).normalize();
      if (k < SUB) {
        // Blades would have passed through each other this frame: stop them
        // where they met.
        A.sword!.pushTip(contact.a.t.clone().sub(sa.t).multiplyScalar(0.85));
        B.sword!.pushTip(contact.b.t.clone().sub(sb.t).multiplyScalar(0.85));
      }
      const va = velAt(sa, s), vb = velAt(sb, t);
      const vn = va.clone().sub(vb).dot(n);
      // Separate, then exchange momentum along the contact normal.
      const depth = minD - dist;
      const la = Math.max(s, 0.3), lb = Math.max(t, 0.3);
      A.sword!.pushTip(n.clone().multiplyScalar(depth * 0.5 / la));
      B.sword!.pushTip(n.clone().multiplyScalar(-depth * 0.5 / lb));
      if (vn < 0) {
        const j = -(1 + 0.35) * vn * 0.5;
        A.sword!.impulseTip(n.clone().multiplyScalar(j / la));
        B.sword!.impulseTip(n.clone().multiplyScalar(-j / lb));
        // A heavy bind jars the hands a little.
        A.sword!.impulseGrip(n.clone().multiplyScalar(j * 0.15));
        B.sword!.impulseGrip(n.clone().multiplyScalar(-j * 0.15));
      }
      const key = `p:${A.id}:${B.id}`;
      const speed = Math.abs(vn);
      if (speed > 1.2 && this.ready(key, PARRY_COOLDOWN)) {
        events.push({ kind: "parry", a: A, b: B, point: c1.clone().lerp(c2, 0.5), normal: n, speed });
      }
    }

    // --- blade vs body ---------------------------------------------------
    for (const A of armed) {
      const sa = seg.get(A)!;
      const bladeDir = sa.t.clone().sub(sa.g).normalize();
      let best: { T: Fighter; cap: Capsule; s: number; dist: number; pb: THREE.Vector3; pc: THREE.Vector3; k: number; tipAt: THREE.Vector3 } | null = null;
      for (let k = 1; k <= SUB && !best; k++) {
        const b = at(sa, k / SUB);
        for (const T of list) {
          if (T === A) continue;
          for (const cap of T.capsules) {
            const { s, dist2 } = closestSegSeg(b.g, b.t, cap.a, cap.b, c1, c2);
            const r = cap.r + BLADE_RADIUS;
            if (dist2 > r * r) continue;
            const dist = Math.sqrt(dist2);
            if (!best || dist - r < best.dist - (best.cap.r + BLADE_RADIUS)) {
              best = { T, cap, s, dist, pb: c1.clone(), pc: c2.clone(), k, tipAt: b.t.clone() };
            }
          }
        }
      }
      if (!best) continue;
      const { T, cap, s, dist, pb, pc } = best;
      // Swept past the body this frame: the blade stops where it bit.
      if (best.k < SUB) A.sword!.pushTip(best.tipAt.clone().sub(sa.t).multiplyScalar(0.85));
      const n = dist > 1e-5 ? pb.clone().sub(pc).divideScalar(dist)
        : new THREE.Vector3().crossVectors(bladeDir, UP).normalize();
      const v = velAt(sa, s);
      const vn = v.dot(n);
      const lever = Math.max(s, 0.3);
      // Keep the blade out of the body and bounce it off.
      A.sword!.pushTip(n.clone().multiplyScalar((cap.r + BLADE_RADIUS - dist) / lever));
      if (vn < 0) {
        const tangential = v.clone().addScaledVector(n, -vn);
        const dv = n.clone().multiplyScalar(-vn * 1.25).addScaledVector(tangential, -0.35);
        A.sword!.impulseTip(dv.divideScalar(lever));
      }
      const speed = Math.max(-vn, 0) + v.length() * 0.25;
      const key = `h:${A.id}:${T.id}`;
      const thrust = s > 0.8 && v.dot(bladeDir) > 0.6 * v.length();
      if (speed > HIT_SPEED && T.downTime <= 0 && this.ready(key, HIT_COOLDOWN)) {
        const damage = Math.round(ZONE_DAMAGE[cap.zone] * THREE.MathUtils.clamp((speed - 1.5) * 6.5, 3, 42) * (thrust ? 1.3 : 1) * (A.damageScale ?? 1));
        const dir = v.lengthSq() > 1e-6 ? v.clone().normalize() : n.clone().negate();
        T.health = Math.max(0, T.health - damage);
        T.reactor.impulse(dir, Math.min(1.2 + speed * 0.45, 5.5) * (cap.zone === "head" ? 1.3 : 1));
        events.push({ kind: "hit", attacker: A, target: T, point: pb.clone().lerp(pc, 0.5), dir, speed, damage, zone: cap.zone, thrust });
        if (T.health <= 0) { T.downTime = 3.5; events.push({ kind: "down", target: T }); }
      } else if (speed > 0.8 && this.ready(`g:${A.id}:${T.id}`, 0.25)) {
        events.push({ kind: "graze", attacker: A, target: T, point: pb, speed });
      }
    }
    for (const [f, sg] of seg) this.prevBlade.set(f.id, { g: sg.g.clone(), t: sg.t.clone() });
    return events;
  }

  private ready(key: string, cooldown: number): boolean {
    const last = this.cooldown.get(key) ?? -Infinity;
    if (this.time - last < cooldown) return false;
    this.cooldown.set(key, this.time);
    return true;
  }
}
