/** Half Sword–style hand control for the biped player.
 *
 *  The network keeps driving locomotion (legs, hips, spine, head). On top of
 *  that the player's arms are taken over by the mouse, the way Half Sword
 *  plays: hold RMB to move the right hand, LMB to move the left hand, both
 *  for a two-handed grip. The sword is a simulated body rather than an
 *  animation:
 *
 *    - the grip point chases the mouse-driven hand target through a damped
 *      spring (the weapon has weight; fast body turns drag it along),
 *    - the tip is a Verlet particle held at blade length from the grip, pulled
 *      by gravity and a weak "wrist" spring toward a guard direction, so
 *      quick hand motion whips the blade through and it keeps swinging,
 *    - both hands are placed with two-bone arm IK; the grip hand's rotation
 *      follows the blade, fingers curl into a fist around the handle.
 *
 *  Two-handed grip stiffens the wrist and hand springs (more control), and
 *  the half-sword grip moves the off hand onto the middle of the blade.
 */

import * as THREE from "three";
import type { ArmPivot } from "./arm_pivots.js";

export type HandSide = "Left" | "Right";

export interface HalfSwordControls {
  /** Mouse delta this frame, pixels (x right, y down). */
  dx: number;
  dy: number;
  /** Wheel delta this frame (positive = toward the player). */
  wheel: number;
  leftHeld: boolean;
  rightHeld: boolean;
  /** Thrust held (Space): drive the point straight out along the centreline. */
  thrust?: boolean;
}

export interface HalfSwordSettings {
  /** Metres of hand travel per mouse pixel. */
  sensitivity: number;
  /** Scales gravity on the blade — higher feels heavier. */
  bladeWeight: number;
}

export const DEFAULT_HALF_SWORD: HalfSwordSettings = { sensitivity: 0.0022, bladeWeight: 1.0 };

/** Sword dimensions (metres, along the blade axis from the main grip). */
export const SWORD = {
  bladeLength: 0.95,   // grip → tip
  offHandHilt: -0.11,  // second hand on the handle, below the main hand
  halfSwordGrip: 0.42, // off hand on the blade for half-swording
};

interface ArmRig {
  side: HandSide;
  clavicle: number;
  arm: number; fore: number; hand: number;
  upperLen: number; foreLen: number;
  /** Shoulder pivot the arm mesh rotates about, in the clavicle's bind-local
   *  frame, and the arm joint's bind offset from it (world axes). */
  pivotInClavicle: THREE.Vector3;
  jointFromPivot: THREE.Vector3;
  armBindRot: THREE.Quaternion;
  /** Bone directions (toward the child) and the elbow flexion hinge, each in
   *  the bone's own local frame — lets the IK place the elbow so it only
   *  ever bends about its anatomical hinge. */
  upperDirL: THREE.Vector3; upperHingeL: THREE.Vector3;
  foreDirL: THREE.Vector3; foreHingeL: THREE.Vector3;
  /** Bind rotation of the hand relative to the forearm (neutral wrist), and
   *  the forearm axis expressed in the neutral hand's frame (twist axis). */
  handRelBind: THREE.Quaternion;
  wristTwistAxisL: THREE.Vector3;
  /** Hand-local axes: across the knuckles (index → pinky), wrist → knuckles,
   *  and the palm normal. */
  across: THREE.Vector3; forward: THREE.Vector3; palm: THREE.Vector3;
  /** Hand-local position of the handle centre inside a closed fist. */
  gripOffset: THREE.Vector3;
  /** Finger joints in cascade order, each with its local curl rotation axis
   *  and the curl angle at full grip. */
  fingers: { idx: number; parent: number; axis: THREE.Vector3; angle: number }[];
  /** Other untracked joints under the arm (e.g. the forearm twist helper),
   *  re-cascaded after the IK moves the arm so they don't keep a stale pose. */
  helpers: { idx: number; parent: number }[];
}

export interface RigInfo {
  boneNameToIndex: Map<string, number>;
  boneInverses: readonly THREE.Matrix4[];
  bindLocalMatrices: readonly THREE.Matrix4[];
  untrackedCascade: readonly { skelIdx: number; parentSkelIdx: number }[];
  /** Mesh shoulder pivots (arm_pivots.ts); arms without one pivot on the
   *  skeleton's own joint. */
  armPivots?: readonly ArmPivot[];
}

const UP = new THREE.Vector3(0, 1, 0);

function bindWorld(rig: RigInfo, i: number): THREE.Matrix4 {
  return rig.boneInverses[i].clone().invert();
}
function posOf(m: THREE.Matrix4, out = new THREE.Vector3()): THREE.Vector3 {
  return out.setFromMatrixPosition(m);
}
function rotOf(m: THREE.Matrix4, out = new THREE.Quaternion()): THREE.Quaternion {
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  m.decompose(p, out, s);
  return out;
}

/** Rotation mapping local (a1, a2) onto world (b1, b2); primary axes match
 *  exactly, secondary as closely as possible. */
function frameRotation(a1: THREE.Vector3, a2: THREE.Vector3, b1: THREE.Vector3, b2: THREE.Vector3): THREE.Quaternion {
  const basis = (p: THREE.Vector3, s: THREE.Vector3) => {
    const x = p.clone().normalize();
    const z = new THREE.Vector3().crossVectors(x, s);
    if (z.lengthSq() < 1e-10) z.set(0, 0, 1).cross(x);
    z.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const A = basis(a1, a2), B = basis(b1, b2);
  return new THREE.Quaternion().setFromRotationMatrix(B.multiply(A.transpose()));
}

function buildArm(rig: RigInfo, side: HandSide): ArmRig {
  const idx = (n: string) => {
    const i = rig.boneNameToIndex.get(n);
    if (i === undefined) throw new Error(`half sword: bone ${n} missing`);
    return i;
  };
  const clavicle = idx(`${side}Shoulder`);
  const arm = idx(`${side}Arm`), fore = idx(`${side}ForeArm`), hand = idx(`${side}Hand`);
  const bp = (i: number) => posOf(bindWorld(rig, i));
  const handRotInv = rotOf(bindWorld(rig, hand)).invert();

  const across = bp(idx(`${side}HandPinky1`)).sub(bp(idx(`${side}HandIndex1`))).normalize();
  const fwdW = bp(idx(`${side}HandMiddle1`)).sub(bp(hand));
  const handLen = fwdW.length();
  const forward = fwdW.clone().normalize();
  // Palm side = the side the thumb sits on.
  let palm = new THREE.Vector3().crossVectors(forward, across).normalize();
  const thumb = bp(idx(`${side}HandThumb2`)).sub(bp(hand));
  if (palm.dot(thumb) < 0) palm.negate();

  // Curl direction: rotating a finger about ±across must move its tip
  // toward the palm.
  const curlSign = Math.sign(new THREE.Vector3().crossVectors(across, forward).dot(palm)) || 1;
  const fingerAxisW = across.clone().multiplyScalar(curlSign);
  const thumbDir = bp(idx(`${side}HandThumb3`)).sub(bp(idx(`${side}HandThumb1`))).normalize();
  const thumbSign = Math.sign(new THREE.Vector3().crossVectors(forward, thumbDir).dot(across)) || 1;
  const thumbAxisW = forward.clone().multiplyScalar(-thumbSign);

  const handDesc = new Set<number>([hand]);
  const fingers: ArmRig["fingers"] = [];
  for (const { skelIdx, parentSkelIdx } of rig.untrackedCascade) {
    if (!handDesc.has(parentSkelIdx)) continue;
    handDesc.add(skelIdx);
    const name = [...rig.boneNameToIndex.entries()].find(([, i]) => i === skelIdx)?.[0] ?? "";
    const m = name.match(/Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/);
    const isThumb = m?.[1] === "Thumb";
    const k = m ? Number(m[2]) : 0;
    const angle = !m ? 0 : isThumb ? [0, 0.35, 0.5, 0.5][k] : [0, 1.05, 1.35, 0.9][k];
    const jointRotInv = rotOf(bindWorld(rig, skelIdx)).invert();
    const axis = (isThumb ? thumbAxisW : fingerAxisW).clone().applyQuaternion(jointRotInv).normalize();
    fingers.push({ idx: skelIdx, parent: parentSkelIdx, axis, angle });
  }

  // Everything under the arm that the IK doesn't set directly.
  const armTree = new Set<number>([arm, fore, hand]);
  const helpers: { idx: number; parent: number }[] = [];
  const fingerSet = new Set(fingers.map((f) => f.idx));
  for (const { skelIdx, parentSkelIdx } of rig.untrackedCascade) {
    if (!armTree.has(parentSkelIdx)) continue;
    armTree.add(skelIdx);
    if (skelIdx === fore || skelIdx === hand || fingerSet.has(skelIdx)) continue;
    helpers.push({ idx: skelIdx, parent: parentSkelIdx });
  }

  const toLocal = (v: THREE.Vector3) => v.clone().applyQuaternion(handRotInv).normalize();
  const acrossL = toLocal(across), forwardL = toLocal(forward), palmL = toLocal(palm);

  // Elbow hinge: flexion brings the forearm forward from the (A-pose) bind,
  // so the flexion axis is upperArmDir × forward.
  const pivotW = (rig.armPivots?.find((a) => a.arm === arm)?.pivot ?? bp(arm)).clone();
  const d1 = bp(fore).sub(pivotW).normalize();
  const d2 = bp(hand).sub(bp(fore)).normalize();
  const hingeW = new THREE.Vector3().crossVectors(d1, new THREE.Vector3(0, 0, 1)).normalize();
  const armRotInv = rotOf(bindWorld(rig, arm)).invert();
  const foreRotInv = rotOf(bindWorld(rig, fore)).invert();
  return {
    side, clavicle, arm, fore, hand,
    upperDirL: d1.clone().applyQuaternion(armRotInv).normalize(),
    upperHingeL: hingeW.clone().applyQuaternion(armRotInv).normalize(),
    foreDirL: d2.clone().applyQuaternion(foreRotInv).normalize(),
    foreHingeL: hingeW.clone().applyQuaternion(foreRotInv).normalize(),
    handRelBind: foreRotInv.clone().multiply(rotOf(bindWorld(rig, hand))),
    wristTwistAxisL: d2.clone().applyQuaternion(rotOf(bindWorld(rig, hand)).invert()).normalize(),
    upperLen: bp(fore).distanceTo(pivotW),
    pivotInClavicle: pivotW.clone().applyMatrix4(rig.boneInverses[clavicle]),
    jointFromPivot: bp(arm).sub(pivotW),
    armBindRot: rotOf(bindWorld(rig, arm)),
    foreLen: bp(hand).distanceTo(bp(fore)),
    across: acrossL, forward: forwardL, palm: palmL,
    gripOffset: forwardL.clone().multiplyScalar(handLen * 0.8).addScaledVector(palmL, 0.028),
    fingers,
    helpers,
  };
}

interface HandState {
  /** Mouse-driven target in body frame: x right, y up (from chest), z fwd. */
  offset: THREE.Vector3;
  /** IK blend (0 = network arm swing, 1 = full control). */
  w: number;
  /** Fist amount (0 open … 1 closed on the handle). */
  curl: number;
  /** Hand rotation blend toward the grip orientation. */
  rotW: number;
  /** Last chosen elbow swivel / grip roll (radians) — keeps solutions
   *  continuous frame to frame. */
  swivel: number;
  roll: number;
}

const REST_MAIN = new THREE.Vector3(0.2, -0.42, 0.28);

export class HalfSword {
  enabled = false;
  mainSide: HandSide = "Right";
  halfGrip = false;
  settings: HalfSwordSettings = { ...DEFAULT_HALF_SWORD };

  /** Whether a sword is in hand. Unarmed, both hands are free hands. */
  armed = true;
  /** Hands whose arm is wrecked — they hang limp and can't hold anything. */
  readonly disabled: Record<HandSide, boolean> = { Left: false, Right: false };

  /** Final sword transform for the renderer (valid after apply()). */
  readonly swordPosition = new THREE.Vector3();
  readonly swordQuaternion = new THREE.Quaternion();
  swordVisible = false;

  private readonly arms: Record<HandSide, ArmRig>;
  private readonly hands: Record<HandSide, HandState>;
  private readonly spine3: number;
  private readonly hips: number;
  private readonly hipsBindRotInv: THREE.Quaternion;

  // Body frame, refreshed from the rendered pose each frame.
  private chest = new THREE.Vector3(0, 1.3, 0);
  private fwd = new THREE.Vector3(0, 0, 1);
  private right = new THREE.Vector3(-1, 0, 0);
  private shoulder: Record<HandSide, THREE.Vector3> = {
    Left: new THREE.Vector3(0.13, 1.39, 0), Right: new THREE.Vector3(-0.13, 1.39, 0),
  };
  private haveBody = false;

  // Sword simulation (world space).
  private grip = new THREE.Vector3();
  private gripVel = new THREE.Vector3();
  private tip = new THREE.Vector3();
  private tipPrev = new THREE.Vector3();
  private blade = new THREE.Vector3(0, 1, 0);
  private simReady = false;
  private twoHanded = false;
  /** 0…1 blend of the thrust extension (eases in fast, out slower). */
  private thrustAmt = 0;
  /** Seconds left of the "come to guard" lift after grabbing the sword. */
  private readyLift = 0;
  /** Per-hand world-space override (grabbing / holding something). */
  private readonly overrides: Record<HandSide, { pos: THREE.Vector3; closed: boolean } | null> = { Left: null, Right: null };
  /** Palm-centre world position per hand, from the last apply(). */
  private readonly gripPoints: Record<HandSide, THREE.Vector3> = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  private wasActive = false;
  /** Seconds left of a parry stun (hands can't drive the blade). */
  private stunTime = 0;
  /** Stuck-in-body constraint: entry point + depth of the tip inside. */
  private stuckAnchor: THREE.Vector3 | null = null;
  private stuckDepth = 0;
  private stuckAxial = 0;
  private stuckLateral = 0;
  private readonly stuckHaulV = new THREE.Vector3();
  private readonly lastGripTarget = new THREE.Vector3();
  /** Last physics substep length (for velocity ↔ Verlet conversions). */
  private lastH = 1 / 240;

  constructor(private readonly rig: RigInfo) {
    this.arms = { Left: buildArm(rig, "Left"), Right: buildArm(rig, "Right") };
    const mk = (): HandState => ({ offset: new THREE.Vector3(), w: 0, curl: 0, rotW: 0, swivel: 0, roll: 0 });
    this.hands = { Left: mk(), Right: mk() };
    this.hands.Right.offset.copy(REST_MAIN);
    this.hands.Left.offset.set(-REST_MAIN.x, REST_MAIN.y, REST_MAIN.z);
    this.spine3 = rig.boneNameToIndex.get("Spine3")!;
    this.hips = rig.boneNameToIndex.get("Hips")!;
    this.hipsBindRotInv = rotOf(bindWorld(rig, this.hips)).invert();
  }

  get offSide(): HandSide { return this.mainSide === "Right" ? "Left" : "Right"; }

  // --- read-only views for combat / AI -----------------------------------
  get ready(): boolean { return this.enabled && this.simReady && this.haveBody; }
  /** Body frame known (hands can be driven, armed or not). */
  get active(): boolean { return this.enabled && this.haveBody; }
  get isTwoHanded(): boolean { return this.twoHanded; }
  /** Mid-thrust (hands driving the point out). */
  get thrusting(): boolean { return this.thrustAmt > 0.35; }
  get chestPosition(): THREE.Vector3 { return this.chest; }
  get bodyForward(): THREE.Vector3 { return this.fwd; }
  get bodyRight(): THREE.Vector3 { return this.right; }
  /** Mutable mouse-space target of a hand (x right, y up from chest, z fwd). */
  handOffset(side: HandSide): THREE.Vector3 { return this.hands[side].offset; }
  /** Simulated tip velocity (m/s). */
  tipVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.tip).sub(this.tipPrev).divideScalar(this.lastH);
  }
  gripVelocity(out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.gripVel); }
  /** Rendered blade segment (crossguard → tip), world space. */
  bladeSegment(guard: THREE.Vector3, tip: THREE.Vector3): void {
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.swordQuaternion);
    guard.copy(this.swordPosition).addScaledVector(dir, 0.07);
    tip.copy(this.swordPosition).addScaledVector(dir, SWORD.bladeLength);
  }
  /** Pommel → crossguard segment (blunt strike surfaces). */
  hiltSegment(pommel: THREE.Vector3, guard: THREE.Vector3): void {
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.swordQuaternion);
    pommel.copy(this.swordPosition).addScaledVector(dir, -0.17);
    guard.copy(this.swordPosition).addScaledVector(dir, 0.06);
  }
  /** Parried: the hands lose control of the blade for `t` seconds. */
  stun(t: number): void { this.stunTime = Math.max(this.stunTime, t); }
  get stunned(): boolean { return this.stunTime > 0; }
  /** Pin the blade in a body at `anchor` (entry point) with `depth` of blade
   *  inside, or release (null). */
  setStuck(anchor: THREE.Vector3 | null, depth: number): void {
    if (!anchor) { this.stuckAnchor = null; return; }
    if (this.stuckAnchor) this.stuckAnchor.copy(anchor); else this.stuckAnchor = anchor.clone();
    this.stuckDepth = depth;
  }
  get isStuck(): boolean { return this.stuckAnchor !== null; }
  /** How hard the hands pull the stuck blade out along its axis (m of
   *  spring stretch) and how fast they wiggle it sideways (m/s). */
  stuckPull(): { axial: number; lateral: number } { return { axial: this.stuckAxial, lateral: this.stuckLateral }; }
  /** Horizontal pull the hands put on the stuck victim (m). */
  stuckHaul(): THREE.Vector3 { return this.stuckHaulV.clone(); }

  /** Drive a hand to a world position (grab reach / holding), or release. */
  setHandOverride(side: HandSide, pos: THREE.Vector3 | null, closed = false): void {
    if (!pos) { this.overrides[side] = null; return; }
    const o = this.overrides[side];
    if (o) { o.pos.copy(pos); o.closed = closed; } else this.overrides[side] = { pos: pos.clone(), closed };
  }
  hasOverride(side: HandSide): boolean { return this.overrides[side] !== null; }
  /** Is this hand holding the sword (main hand, or off hand on the grip)? */
  handOnSword(side: HandSide): boolean {
    if (!this.armed) return false;
    return side === this.mainSide || (this.twoHanded && !this.overrides[side]);
  }
  shoulderPosition(side: HandSide, out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.shoulder[side]); }
  armReach(side: HandSide): number { const a = this.arms[side]; return (a.upperLen + a.foreLen) * 0.95; }
  /** Where the mouse (offset) puts this hand, clamped to reach. */
  handTarget(side: HandSide, out = new THREE.Vector3()): THREE.Vector3 {
    this.toWorld(this.hands[side].offset, out);
    const sh = this.shoulder[side], r = this.armReach(side);
    const d = out.clone().sub(sh);
    if (d.length() > r) out.copy(sh).addScaledVector(d.normalize(), r);
    return out;
  }
  /** Rendered palm-centre position (last apply()). */
  handPoint(side: HandSide, out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.gripPoints[side]); }
  /** Body-frame offset → world. */
  bodyToWorld(o: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 { return this.toWorld(o, out); }

  /** Let go of the sword. Returns its transform + motion so the caller can
   *  spawn a loose sword; null when not armed. */
  dropSword(): { position: THREE.Vector3; quaternion: THREE.Quaternion; velocity: THREE.Vector3; angularVelocity: THREE.Vector3 } | null {
    if (!this.armed || !this.swordVisible) return null;
    const velocity = this.gripVel.clone();
    const tipV = this.tipVelocity();
    const angularVelocity = new THREE.Vector3().crossVectors(this.blade, tipV.sub(velocity)).divideScalar(SWORD.bladeLength);
    const out = { position: this.swordPosition.clone(), quaternion: this.swordQuaternion.clone(), velocity, angularVelocity };
    this.armed = false;
    this.simReady = false;
    this.swordVisible = false;
    return out;
  }

  /** Take up a sword in `side`'s hand. */
  pickUp(side: HandSide): void {
    this.armed = true;
    this.mainSide = side;
    this.overrides[side] = null;
    this.simReady = false;
    this.hands[side].rotW = 0;
  }

  /** Change the tip's velocity by `dv` (m/s) — contact response. */
  impulseTip(dv: THREE.Vector3): void { this.tipPrev.addScaledVector(dv, -this.lastH); }
  /** Move the tip without changing its velocity (penetration fix-up). */
  pushTip(delta: THREE.Vector3): void { this.tip.add(delta); this.tipPrev.add(delta); }
  /** Knock the grip (e.g. a heavy parry jars the hands). */
  impulseGrip(dv: THREE.Vector3): void { this.gripVel.add(dv); }

  /** Move the sword to the other hand. */
  swapHands(): void {
    const main = this.hands[this.mainSide].offset.clone();
    this.mainSide = this.offSide;
    this.hands[this.mainSide].offset.copy(main);
  }

  /** Drop simulation state (e.g. when the controlled agent changes). */
  reset(): void {
    this.simReady = false;
    this.haveBody = false;
    this.swordVisible = false;
    for (const h of Object.values(this.hands)) { h.w = 0; h.curl = 0; h.rotW = 0; }
  }

  private toWorld(o: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.chest)
      .addScaledVector(this.right, o.x)
      .addScaledVector(UP, o.y)
      .addScaledVector(this.fwd, o.z);
  }

  /** Advance input + sword physics. Call once per frame before the engine
   *  update that renders the pose. */
  update(dt: number, c: HalfSwordControls): void {
    if (!this.enabled || !this.haveBody) return;
    dt = Math.min(dt, 1 / 20);
    if (dt <= 1e-5) return;   // hit-stop freeze
    const main = this.mainSide, off = this.offSide;
    const held: Record<HandSide, boolean> = { Left: c.leftHeld, Right: c.rightHeld };
    const two = this.armed && held.Left && held.Right && !this.overrides[off] && !this.disabled[off];
    this.twoHanded = two;

    // --- mouse → hand targets (body frame) -------------------------------
    const s = this.settings.sensitivity;
    // Mirror x so "mouse right" moves the hand to the character's right.
    this.stunTime = Math.max(0, this.stunTime - dt);
    const stunned = this.stunTime > 0;
    const d = stunned ? new THREE.Vector3() : new THREE.Vector3(c.dx * s, -c.dy * s, -c.wheel * 0.0006);
    const driven: HandSide[] = two ? [main] : ([ "Left", "Right" ] as HandSide[]).filter((h) => held[h]);
    const easeU = (cur: number, target: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
    for (const h of driven) {
      const o = this.hands[h].offset.add(d);
      // x is in the character's right direction; each hand may cross the
      // midline only a little (further crossing folds the chest mesh).
      const sideSign = h === "Right" ? 1 : -1;
      o.x = sideSign * THREE.MathUtils.clamp(o.x * sideSign, -0.28, 0.6);
      o.y = THREE.MathUtils.clamp(o.y, -0.75, 0.5);
      o.z = THREE.MathUtils.clamp(o.z, 0.1, 0.7);
    }
    if (!this.armed) {
      // Bare hands: each hand follows the mouse while its button is held,
      // or the grab override; otherwise the network's arm swing.
      for (const side of ["Left", "Right"] as HandSide[]) {
        const hs = this.hands[side], ov = this.overrides[side];
        const on = (held[side] || ov !== null) && !this.disabled[side];
        hs.w = easeU(hs.w, on ? 1 : 0, 9);
        hs.curl = easeU(hs.curl, ov ? (ov.closed ? 1 : 0.35) : held[side] ? 0.55 : 0.2, 12);
        hs.rotW = easeU(hs.rotW, ov ? 0.85 : 0, 9);
      }
      this.wasActive = false;
      return;
    }
    // Two hands on the sword pull the grip toward the centreline (half-sword
    // stance even more so), so the off arm doesn't have to cross the chest.
    if (two) {
      const side = main === "Right" ? 1 : -1;
      const o = this.hands[main].offset;
      o.x += (side * (this.halfGrip ? 0.04 : 0.1) - o.x) * (1 - Math.exp(-dt * 3));
    }
    // Taking hold of the sword brings it up to a middle guard (hands at
    // chest height, forward) instead of starting a cut from the hip.
    const activeNow = held[main] || two;
    if (activeNow && !this.wasActive) this.readyLift = 0.35;
    this.wasActive = activeNow;
    if (this.readyLift > 0) {
      this.readyLift -= dt;
      const o = this.hands[main].offset;
      const k = 1 - Math.exp(-dt * 12);
      o.y += (Math.max(o.y, -0.02) - o.y) * k;
      o.z += (Math.max(o.z, 0.38) - o.z) * k;
    }
    // An idle sword hand sags back to a low guard.
    if (!held[main]) this.hands[main].offset.lerp(REST_MAIN.clone().setX(REST_MAIN.x * (main === "Right" ? 1 : -1)), 1 - Math.exp(-dt * 1.5));

    // --- IK weights / curls ----------------------------------------------
    const ease = (cur: number, target: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
    const mh = this.hands[main], oh = this.hands[off];
    mh.w = ease(mh.w, 1, 10); mh.curl = ease(mh.curl, 1, 12); mh.rotW = ease(mh.rotW, 1, 10);
    const offOnSword = two;
    const offFree = !two && held[off];
    const offOv = this.overrides[off];
    oh.w = ease(oh.w, offOnSword || offFree || offOv ? 1 : 0, 8);
    oh.curl = ease(oh.curl, offOv ? (offOv.closed ? 1 : 0.35) : offOnSword ? 1 : offFree ? 0.55 : 0.2, 10);
    oh.rotW = ease(oh.rotW, offOv ? 0.85 : offOnSword ? 1 : 0, 8);

    // --- sword simulation --------------------------------------------------
    const target = this.toWorld(mh.offset);
    // Keep the grip reachable from the shoulder.
    const arm = this.arms[main];
    const reach = (arm.upperLen + arm.foreLen) * 0.93;
    const fromSh = target.clone().sub(this.shoulder[main]);
    if (fromSh.length() > reach) target.copy(this.shoulder[main]).addScaledVector(fromSh.normalize(), reach);

    const active = held[main] || two;
    const ease2 = (cur: number, tgt: number, rate: number) => cur + (tgt - cur) * (1 - Math.exp(-dt * rate));
    this.thrustAmt = ease2(this.thrustAmt, active && c.thrust ? 1 : 0, active && c.thrust ? 14 : 7);

    // Blade aim: the blade points from a pivot low in the torso out through
    // the hands, so the hand path *is* the cut — hands high = chambered
    // (vom Tag), high to one side = diagonal chamber, low & forward = point
    // on line. Swinging the hands carries the blade through any angle.
    const pivot = this.chest.clone().addScaledVector(UP, -0.38).addScaledVector(this.fwd, -0.28);
    let guard: THREE.Vector3;
    if (two && this.halfGrip) {
      // Half-swording: blade levelled forward along the thrust line.
      guard = new THREE.Vector3().addScaledVector(this.fwd, 1).addScaledVector(UP, 0.12)
        .addScaledVector(this.right, -mh.offset.x * 0.6).normalize();
    } else if (active) {
      guard = target.clone().sub(pivot).addScaledVector(UP, 0.12).normalize();
      // Lead: the blade leans into the direction the hands are moving, so a
      // fast sweep rotates the edge into the cut instead of dragging flat.
      const v = this.gripVel.clone();
      v.addScaledVector(guard, -v.dot(guard));
      const vl = v.length();
      if (vl > 1e-3) guard.addScaledVector(v, Math.min(vl * 0.08, 0.45) / vl).normalize();
    } else {
      guard = new THREE.Vector3().addScaledVector(this.fwd, 0.85).addScaledVector(UP, -0.5).normalize();
    }
    if (this.thrustAmt > 1e-3) {
      // Thrust: hands shoot forward to full reach on the centreline, point
      // aimed straight ahead.
      const side = main === "Right" ? 1 : -1;
      const out = this.toWorld(new THREE.Vector3(side * 0.06, THREE.MathUtils.clamp(mh.offset.y, -0.25, 0.2), 0.78));
      const fromSh2 = out.clone().sub(this.shoulder[main]);
      if (fromSh2.length() > reach) out.copy(this.shoulder[main]).addScaledVector(fromSh2.normalize(), reach);
      // Point on line first, then extend: the blade aligns quickly and the
      // hands only shoot out once it's pointing — so the tip travels along
      // the blade's own axis (a stab, not a cut).
      target.lerp(out, this.thrustAmt * this.thrustAmt);
      const aim = this.fwd.clone().addScaledVector(UP, 0.04).normalize();
      guard.lerp(aim, Math.min(1, this.thrustAmt * 2.2)).normalize();
    }
    const L = SWORD.bladeLength;
    if (!this.simReady) {
      this.grip.copy(target); this.gripVel.set(0, 0, 0);
      this.tip.copy(target).addScaledVector(guard, L); this.tipPrev.copy(this.tip);
      this.simReady = true;
    }
    const stunK = stunned ? 0.35 : 1;
    const omega = ((two ? 24 : active ? 17 : 9) + this.thrustAmt * 10) * stunK;
    const wrist = ((two ? 80 : active ? 38 : 14) + this.thrustAmt * 60) * stunK;
    this.lastGripTarget.copy(target);
    const g = 9.81 * 0.4 * this.settings.bladeWeight;
    const steps = 4, h = dt / steps;
    this.lastH = h;
    const acc = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (let i = 0; i < steps; i++) {
      // Grip: critically damped spring toward the hand target.
      acc.copy(target).sub(this.grip).multiplyScalar(omega * omega).addScaledVector(this.gripVel, -2 * omega);
      this.gripVel.addScaledVector(acc, h);
      this.grip.addScaledVector(this.gripVel, h);
      // Tip: Verlet with gravity + wrist spring toward the guard direction.
      acc.set(0, -g, 0).add(tmp.copy(this.grip).addScaledVector(guard, L).sub(this.tip).multiplyScalar(wrist));
      const next = tmp.copy(this.tip).sub(this.tipPrev).multiplyScalar(0.985).add(this.tip).addScaledVector(acc, h * h);
      next.sub(this.grip).setLength(L).add(this.grip);
      if (next.y < 0.03) next.y = 0.03;
      this.tipPrev.copy(this.tip);
      this.tip.copy(next);
      if (this.stuckAnchor) this.applyStuck(h);
    }
    if (this.stuckAnchor) {
      // Pull diagnostics for the combat layer.
      const dir = this.stuckAnchor.clone().sub(this.grip).normalize();
      const want = target.clone().sub(this.grip);
      this.stuckAxial = Math.max(0, -want.dot(dir));
      const lat = this.gripVel.clone().addScaledVector(dir, -this.gripVel.dot(dir));
      this.stuckLateral = lat.length();
      this.stuckHaulV.copy(want);
    } else {
      this.stuckAxial = this.stuckLateral = 0;
      this.stuckHaulV.set(0, 0, 0);
    }
    this.blade.copy(this.tip).sub(this.grip).normalize();
  }

  /** Keep the blade through its entry point: the grip may swing around the
   *  wound (wiggle) but can't slide the blade out — extraction is decided by
   *  the combat layer via `depth`. */
  private applyStuck(h: number): void {
    const A = this.stuckAnchor!;
    const L = SWORD.bladeLength;
    const outside = Math.max(0.05, L - this.stuckDepth);
    const dir = A.clone().sub(this.grip);
    if (dir.lengthSq() < 1e-8) dir.copy(this.blade);
    dir.normalize();
    const pinned = A.clone().addScaledVector(dir, -outside);
    const corr = pinned.sub(this.grip);
    this.grip.add(corr);
    // Remove velocity along the blade (it's held by the wound).
    this.gripVel.addScaledVector(dir, -this.gripVel.dot(dir));
    this.gripVel.addScaledVector(corr, 0.2 / h);
    this.tip.copy(A).addScaledVector(dir, this.stuckDepth);
    this.tipPrev.copy(this.tip);
  }

  /** Pose override for the player's world matrices (see Actor.poseOverride). */
  apply = (world: THREE.Matrix4[]): void => {
    // Body frame from the network pose.
    posOf(world[this.spine3], this.chest);
    const hipsRot = rotOf(world[this.hips]).multiply(this.hipsBindRotInv);
    this.fwd.set(0, 0, 1).applyQuaternion(hipsRot).setY(0);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, 1);
    this.fwd.normalize();
    this.right.crossVectors(this.fwd, UP).normalize();
    for (const side of ["Left", "Right"] as HandSide[]) this.pivotOf(world, this.arms[side], this.shoulder[side]);
    this.haveBody = true;
    if (!this.enabled) { this.swordVisible = false; return; }
    if (!this.armed) {
      this.swordVisible = false;
      for (const side of ["Left", "Right"] as HandSide[]) {
        const hs = this.hands[side], arm = this.arms[side];
        const ov = this.overrides[side];
        const target = ov ? ov.pos.clone() : this.handTarget(side);
        if (this.disabled[side]) { hs.w = 0; hs.curl = 0; }
        if (hs.w > 1e-3) this.solveArm(world, arm, hs, target, this.reachRotation(arm, target), true);
        this.curlFingers(world, arm, hs.curl);
        this.recordGripPoint(world, side);
      }
      return;
    }
    if (!this.simReady) { this.swordVisible = false; return; }

    const main = this.mainSide, off = this.offSide;
    // Main hand: grip centred on the simulated grip point, blade along the
    // sim's blade direction.
    const mainRot = this.gripRotation(this.arms[main], this.grip);
    this.solveArm(world, this.arms[main], this.hands[main], this.grip, mainRot);

    // Off hand: on the handle / blade when two-handed, else free.
    const oh = this.hands[off];
    const along = this.halfGrip ? SWORD.halfSwordGrip : SWORD.offHandHilt;
    const offOv = this.overrides[off];
    if (this.disabled[off]) {
      oh.w = 0; oh.curl = 0;
    } else if (offOv) {
      const t = offOv.pos.clone();
      if (oh.w > 1e-3) this.solveArm(world, this.arms[off], oh, t, this.reachRotation(this.arms[off], t), true);
    } else {
      const offGrip = this.twoHanded || oh.rotW > 0.5
        ? this.grip.clone().addScaledVector(this.blade, along)
        : this.toWorld(oh.offset);
      const offRot = this.gripRotation(this.arms[off], offGrip);
      if (oh.w > 1e-3) this.solveArm(world, this.arms[off], oh, offGrip, offRot);
    }
    this.curlFingers(world, this.arms[off], oh.curl);
    this.recordGripPoint(world, main);
    this.recordGripPoint(world, off);

    // Sword follows the main hand's final grip.
    const arm = this.arms[main];
    const handRot = rotOf(world[arm.hand]);
    this.swordPosition.copy(arm.gripOffset).applyQuaternion(handRot).add(posOf(world[arm.hand]));
    const y = arm.across.clone().negate().applyQuaternion(handRot).normalize();
    const x = arm.forward.clone().applyQuaternion(handRot);
    x.addScaledVector(y, -x.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    this.swordQuaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.swordVisible = true;
  };

  private recordGripPoint(world: readonly THREE.Matrix4[], side: HandSide): void {
    const arm = this.arms[side];
    this.gripPoints[side].copy(arm.gripOffset).applyQuaternion(rotOf(world[arm.hand])).add(posOf(world[arm.hand]));
  }

  /** Open reaching hand: fingers along the reach, palm facing down / in. */
  private reachRotation(arm: ArmRig, target: THREE.Vector3): THREE.Quaternion {
    const dir = target.clone().sub(this.shoulder[arm.side]).normalize();
    const palmWant = UP.clone().negate().addScaledVector(this.right, arm.side === "Right" ? -0.6 : 0.6);
    palmWant.addScaledVector(dir, -palmWant.dot(dir));
    if (palmWant.lengthSq() < 1e-6) palmWant.copy(this.fwd);
    return frameRotation(arm.forward, arm.palm, dir, palmWant.normalize());
  }

  /** Where the arm mesh's shoulder pivot currently is. */
  private pivotOf(world: readonly THREE.Matrix4[], arm: ArmRig, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(arm.pivotInClavicle).applyMatrix4(world[arm.clavicle]);
  }

  /** Hand world rotation that closes the fist around the blade axis, with the
   *  wrist kept roughly in line with the forearm. */
  private gripRotation(arm: ArmRig, gripPoint: THREE.Vector3): THREE.Quaternion {
    const foreDir = gripPoint.clone().sub(this.shoulder[arm.side]).normalize();
    const sec = foreDir.addScaledVector(this.blade, -foreDir.dot(this.blade));
    return frameRotation(arm.across.clone().negate(), arm.forward, this.blade, sec);
  }

  /** Two-bone IK (upper arm + forearm) blended with the network's arm, then
   *  the hand placed so its grip point lands on `gripPoint`. */
  private solveArm(world: THREE.Matrix4[], arm: ArmRig, hs: HandState, gripPoint: THREE.Vector3, handRot0: THREE.Quaternion, reach = false): void {
    const sideSign = arm.side === "Right" ? 1 : -1;
    const lateral = this.right.clone().multiplyScalar(sideSign);
    const one = new THREE.Vector3(1, 1, 1);

    // --- shoulder girdle -------------------------------------------------
    // Elevate the clavicle when the hands go above the shoulders and protract
    // it when they reach forward / across, like a real shoulder blade. Keeps
    // the deltoid from being crushed by the upper arm alone.
    {
      const P0 = this.pivotOf(world, arm);
      const rel = gripPoint.clone().sub(P0);
      const elev = THREE.MathUtils.clamp((rel.y + 0.05) / 0.45, 0, 1) * 0.32;
      const prot = THREE.MathUtils.clamp(rel.dot(this.fwd) / 0.5, 0, 1) * 0.16
        + THREE.MathUtils.clamp(-rel.dot(lateral) / 0.35, 0, 1) * 0.14;
      const qe = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(lateral, UP).normalize(), elev * hs.w);
      const qp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(lateral, this.fwd).normalize(), prot * hs.w);
      const qs = qp.multiply(qe);
      const ps = posOf(world[arm.clavicle]);
      for (const i of [arm.clavicle, arm.arm, arm.fore, arm.hand]) {
        const p = posOf(world[i]).sub(ps).applyQuaternion(qs).add(ps);
        world[i].compose(p, rotOf(world[i]).premultiply(qs), one);
      }
    }

    // Solve from the mesh's shoulder pivot (see arm_pivots.ts).
    const pa = this.pivotOf(world, arm);
    const Ra = rotOf(world[arm.arm]), Rf = rotOf(world[arm.fore]), Rh = rotOf(world[arm.hand]);
    const L1 = arm.upperLen, L2 = arm.foreLen;
    const gripping = hs.rotW > 0.5;
    // Free roll axis: the handle when gripping the sword, the reach
    // direction for an open / grabbing hand.
    const bladeAxis = reach ? gripPoint.clone().sub(this.shoulder[arm.side]).normalize() : this.blade;

    // --- search elbow swivel × grip roll ------------------------------------
    // Elbow swivel (rotation of the bend plane about shoulder→hand) and, when
    // gripping, the fist's roll about the handle are both free. Pick the pair
    // needing the least forearm twist and wrist bend, with the elbow kept
    // below the shoulder, outside the torso, and near last frame's choice.
    const basePole = new THREE.Vector3().addScaledVector(UP, -1)
      .addScaledVector(lateral, 0.45).addScaledVector(this.fwd, 0.35);
    const chest = this.chest;
    let best: { cost: number; swivel: number; roll: number; elbow: THREE.Vector3; hand: THREE.Vector3;
      hinge: THREE.Vector3; handRot: THREE.Quaternion } | null = null;
    const qRoll = new THREE.Quaternion(), qSw = new THREE.Quaternion();
    const tmpQ = new THREE.Quaternion();
    const evaluate = (swivel: number, roll: number) => {
      const handRot = gripping ? qRoll.setFromAxisAngle(bladeAxis, roll).clone().multiply(handRot0) : handRot0.clone();
      const target = gripPoint.clone().sub(arm.gripOffset.clone().applyQuaternion(handRot));
      const toT = target.clone().sub(pa);
      const rawD = toT.length();
      const d = THREE.MathUtils.clamp(rawD, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
      const dir = toT.normalize();
      const pole = basePole.clone().addScaledVector(dir, -basePole.dot(dir));
      if (pole.lengthSq() < 1e-6) pole.copy(this.fwd).addScaledVector(dir, -this.fwd.dot(dir));
      pole.normalize().applyQuaternion(qSw.setFromAxisAngle(dir, swivel));
      const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
      const elbow = pa.clone().addScaledVector(dir, L1 * cosA).addScaledVector(pole, L1 * Math.sqrt(1 - cosA * cosA));
      const hand = pa.clone().addScaledVector(dir, d);
      const hinge = new THREE.Vector3().crossVectors(pole, dir).normalize();

      let cost = 0;
      if (gripping) {
        // Wrist: desired hand vs the hand a neutral wrist would give.
        const RfIK = frameRotation(arm.foreDirL, arm.foreHingeL, hand.clone().sub(elbow), hinge);
        const neutral = RfIK.multiply(arm.handRelBind);
        const rel = tmpQ.copy(neutral).invert().multiply(handRot);
        if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w);
        const a = arm.wristTwistAxisL;
        const tw = 2 * Math.atan2(rel.x * a.x + rel.y * a.y + rel.z * a.z, rel.w);
        const total = 2 * Math.acos(Math.min(1, rel.w));
        const swing = Math.max(0, total - Math.abs(tw));
        // Forearm pronation/supination is comfortable to ~±70°; wrist
        // flexion/deviation to ~±35°.
        cost += 1.0 * tw * tw + 3.0 * Math.max(0, Math.abs(tw) - 1.2) ** 2;
        cost += 0.6 * swing * swing + 4.0 * Math.max(0, swing - 0.6) ** 2;
        cost += 0.15 * roll * roll + 0.8 * (roll - hs.roll) ** 2;
      }
      cost += 0.35 * swivel * swivel + 1.2 * (swivel - hs.swivel) ** 2;
      // Elbow above the shoulder or tucked into the torso is contorted.
      cost += 30 * Math.max(0, elbow.y - (pa.y - 0.02)) ** 2 / 0.01;
      const out = elbow.clone().sub(chest).dot(lateral);
      cost += 30 * Math.max(0, 0.13 - out) ** 2 / 0.01;
      const behind = -elbow.clone().sub(chest).dot(this.fwd);
      cost += 20 * Math.max(0, behind - 0.05) ** 2 / 0.01;
      cost += 10 * Math.max(0, rawD - (L1 + L2)) ** 2 / 0.01;
      const dbg = (globalThis as unknown as { __armDebug?: (o: unknown) => void }).__armDebug;
      if (dbg) dbg({ side: arm.side, swivel: +swivel.toFixed(2), roll: +roll.toFixed(2), cost: +cost.toFixed(3),
        elbow: elbow.toArray().map((v) => +v.toFixed(3)), rawD: +rawD.toFixed(3), L: +(L1 + L2).toFixed(3) });
      if (!best || cost < best.cost) best = { cost, swivel, roll, elbow, hand, hinge, handRot };
    };
    const rolls = gripping ? [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9] : [0];
    for (let i = -8; i <= 8; i++) for (const r of rolls) evaluate(i * 0.2, r);
    // Refine around the best.
    const b0 = best!;
    for (const ds of [-0.1, -0.05, 0.05, 0.1]) for (const dr of gripping ? [-0.15, 0, 0.15] : [0]) evaluate(b0.swivel + ds, b0.roll + dr);
    const sol = best!;
    hs.swivel = sol.swivel;
    hs.roll = sol.roll;

    // Absolute bone rotations: bone axis onto the solved segment, elbow
    // hinge onto the bend plane's normal, so the elbow only ever flexes
    // about its anatomical axis.
    const RaIK = frameRotation(arm.upperDirL, arm.upperHingeL, sol.elbow.clone().sub(pa), sol.hinge);
    const RfIK = frameRotation(arm.foreDirL, arm.foreHingeL, sol.hand.clone().sub(sol.elbow), sol.hinge);

    const newRa = Ra.clone().slerp(RaIK, hs.w);
    const newRf = Rf.clone().slerp(RfIK, hs.w);
    const newPf = arm.upperDirL.clone().applyQuaternion(newRa).multiplyScalar(L1).add(pa);
    const newPh = arm.foreDirL.clone().applyQuaternion(newRf).multiplyScalar(L2).add(newPf);
    // The hand is carried by the forearm's change, then turned to the grip.
    const carried = newRf.clone().multiply(Rf.clone().invert()).multiply(Rh);
    const newRh = carried.slerp(sol.handRot, hs.rotW);
    // Arm joint rides the rotation about the pivot.
    const Rrel = newRa.clone().multiply(arm.armBindRot.clone().invert());
    const jointPos = arm.jointFromPivot.clone().applyQuaternion(Rrel).add(pa);
    world[arm.arm].compose(jointPos, newRa, one);
    world[arm.fore].compose(newPf, newRf, one);
    world[arm.hand].compose(newPh, newRh, one);
    for (const h of arm.helpers) {
      world[h.idx].multiplyMatrices(world[h.parent], this.rig.bindLocalMatrices[h.idx]);
    }
    this.curlFingers(world, arm, hs.curl);
  }

  /** Recompute the hand's descendants (fingers) with a fist curl. */
  private curlFingers(world: THREE.Matrix4[], arm: ArmRig, curl: number): void {
    const q = new THREE.Quaternion(), m = new THREE.Matrix4();
    for (const f of arm.fingers) {
      q.setFromAxisAngle(f.axis, f.angle * curl);
      m.makeRotationFromQuaternion(q);
      world[f.idx].multiplyMatrices(world[f.parent], this.rig.bindLocalMatrices[f.idx]).multiply(m);
    }
  }
}
