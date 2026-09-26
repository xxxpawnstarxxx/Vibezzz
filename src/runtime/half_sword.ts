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
  /** Bone directions (toward the child) and the elbow flexion hinge, each in
   *  the bone's own local frame — lets the IK place the elbow so it only
   *  ever bends about its anatomical hinge. */
  upperDirL: THREE.Vector3; upperHingeL: THREE.Vector3;
  foreDirL: THREE.Vector3; foreHingeL: THREE.Vector3;
  /** Hand-local axes: across the knuckles (index → pinky), wrist → knuckles,
   *  and the palm normal. */
  across: THREE.Vector3; forward: THREE.Vector3; palm: THREE.Vector3;
  /** Hand-local position of the handle centre inside a closed fist. */
  gripOffset: THREE.Vector3;
  /** Finger joints in cascade order, each with its local curl rotation axis
   *  and the curl angle at full grip. */
  fingers: { idx: number; parent: number; axis: THREE.Vector3; angle: number }[];
}

export interface RigInfo {
  boneNameToIndex: Map<string, number>;
  boneInverses: readonly THREE.Matrix4[];
  bindLocalMatrices: readonly THREE.Matrix4[];
  untrackedCascade: readonly { skelIdx: number; parentSkelIdx: number }[];
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

  const toLocal = (v: THREE.Vector3) => v.clone().applyQuaternion(handRotInv).normalize();
  const acrossL = toLocal(across), forwardL = toLocal(forward), palmL = toLocal(palm);

  // Elbow hinge: flexion brings the forearm forward from the (A-pose) bind,
  // so the flexion axis is upperArmDir × forward.
  const d1 = bp(fore).sub(bp(arm)).normalize();
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
    upperLen: bp(fore).distanceTo(bp(arm)),
    foreLen: bp(hand).distanceTo(bp(fore)),
    across: acrossL, forward: forwardL, palm: palmL,
    gripOffset: forwardL.clone().multiplyScalar(handLen * 0.8).addScaledVector(palmL, 0.028),
    fingers,
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
}

const REST_MAIN = new THREE.Vector3(0.2, -0.42, 0.28);

export class HalfSword {
  enabled = false;
  mainSide: HandSide = "Right";
  halfGrip = false;
  settings: HalfSwordSettings = { ...DEFAULT_HALF_SWORD };

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
  private wasActive = false;
  /** Last physics substep length (for velocity ↔ Verlet conversions). */
  private lastH = 1 / 240;

  constructor(private readonly rig: RigInfo) {
    this.arms = { Left: buildArm(rig, "Left"), Right: buildArm(rig, "Right") };
    const mk = (): HandState => ({ offset: new THREE.Vector3(), w: 0, curl: 0, rotW: 0 });
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
  get isTwoHanded(): boolean { return this.twoHanded; }
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
    const two = held.Left && held.Right;
    this.twoHanded = two;

    // --- mouse → hand targets (body frame) -------------------------------
    const s = this.settings.sensitivity;
    // Mirror x so "mouse right" moves the hand to the character's right.
    const d = new THREE.Vector3(c.dx * s, -c.dy * s, -c.wheel * 0.0006);
    const driven: HandSide[] = two ? [main] : ([ "Left", "Right" ] as HandSide[]).filter((h) => held[h]);
    for (const h of driven) {
      const o = this.hands[h].offset.add(d);
      // x is in the character's right direction; each hand may cross the
      // midline only a little (further crossing folds the chest mesh).
      const sideSign = h === "Right" ? 1 : -1;
      o.x = sideSign * THREE.MathUtils.clamp(o.x * sideSign, -0.28, 0.6);
      o.y = THREE.MathUtils.clamp(o.y, -0.75, 0.5);
      o.z = THREE.MathUtils.clamp(o.z, 0.1, 0.7);
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
    oh.w = ease(oh.w, offOnSword || offFree ? 1 : 0, 8);
    oh.curl = ease(oh.curl, offOnSword ? 1 : offFree ? 0.55 : 0.2, 10);
    oh.rotW = ease(oh.rotW, offOnSword ? 1 : 0, 8);

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
      target.lerp(out, this.thrustAmt);
      const aim = this.fwd.clone().addScaledVector(UP, 0.04).normalize();
      guard.lerp(aim, this.thrustAmt).normalize();
    }
    const L = SWORD.bladeLength;
    if (!this.simReady) {
      this.grip.copy(target); this.gripVel.set(0, 0, 0);
      this.tip.copy(target).addScaledVector(guard, L); this.tipPrev.copy(this.tip);
      this.simReady = true;
    }
    const omega = (two ? 24 : active ? 17 : 9) + this.thrustAmt * 10;
    const wrist = (two ? 80 : active ? 38 : 14) + this.thrustAmt * 60;
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
    }
    this.blade.copy(this.tip).sub(this.grip).normalize();
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
    for (const side of ["Left", "Right"] as HandSide[]) posOf(world[this.arms[side].arm], this.shoulder[side]);
    this.haveBody = true;
    if (!this.enabled || !this.simReady) { this.swordVisible = false; return; }

    const main = this.mainSide, off = this.offSide;
    // Main hand: grip centred on the simulated grip point, blade along the
    // sim's blade direction.
    const mainRot = this.gripRotation(this.arms[main], this.grip);
    this.solveArm(world, this.arms[main], this.hands[main], this.grip, mainRot);

    // Off hand: on the handle / blade when two-handed, else free.
    const oh = this.hands[off];
    const along = this.halfGrip ? SWORD.halfSwordGrip : SWORD.offHandHilt;
    const offGrip = this.twoHanded || oh.rotW > 0.5
      ? this.grip.clone().addScaledVector(this.blade, along)
      : this.toWorld(oh.offset);
    const offRot = this.gripRotation(this.arms[off], offGrip);
    if (oh.w > 1e-3) this.solveArm(world, this.arms[off], oh, offGrip, offRot);
    this.curlFingers(world, this.arms[off], oh.curl);

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

  /** Hand world rotation that closes the fist around the blade axis, with the
   *  wrist kept roughly in line with the forearm. */
  private gripRotation(arm: ArmRig, gripPoint: THREE.Vector3): THREE.Quaternion {
    const foreDir = gripPoint.clone().sub(this.shoulder[arm.side]).normalize();
    const sec = foreDir.addScaledVector(this.blade, -foreDir.dot(this.blade));
    return frameRotation(arm.across.clone().negate(), arm.forward, this.blade, sec);
  }

  /** Two-bone IK (upper arm + forearm) blended with the network's arm, then
   *  the hand placed so its grip point lands on `gripPoint`. */
  private solveArm(world: THREE.Matrix4[], arm: ArmRig, hs: HandState, gripPoint: THREE.Vector3, handRot: THREE.Quaternion): void {
    // Hand bone target from the desired grip.
    const target = gripPoint.clone().sub(arm.gripOffset.clone().applyQuaternion(handRot));

    // Shoulder girdle: lifting the arm also lifts / swings the clavicle
    // (roughly a third of the elevation, like the scapulohumeral rhythm), so
    // overhead and cross-body guards don't crush the deltoid into the chest.
    {
      const ps = posOf(world[arm.clavicle]);
      const pa0 = posOf(world[arm.arm]), pf0 = posOf(world[arm.fore]);
      const want = target.clone().sub(pa0).normalize();
      const cur = pf0.sub(pa0).normalize();
      const qs = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(cur, want), 0.3 * hs.w);
      const one = new THREE.Vector3(1, 1, 1);
      for (const i of [arm.clavicle, arm.arm, arm.fore, arm.hand]) {
        const p = posOf(world[i]).sub(ps).applyQuaternion(qs).add(ps);
        world[i].compose(p, rotOf(world[i]).premultiply(qs), one);
      }
    }

    const pa = posOf(world[arm.arm]);
    const Ra = rotOf(world[arm.arm]), Rf = rotOf(world[arm.fore]), Rh = rotOf(world[arm.hand]);
    const L1 = arm.upperLen, L2 = arm.foreLen;
    const toT = target.clone().sub(pa);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    const dir = toT.normalize();
    // Elbow hint: down, a little out to the side and back — a relaxed
    // fencer's elbow. Projected off the shoulder→hand line.
    const sideSign = arm.side === "Right" ? 1 : -1;
    const pole = new THREE.Vector3().addScaledVector(UP, -1)
      .addScaledVector(this.right, 0.3 * sideSign).addScaledVector(this.fwd, -0.15);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.copy(this.fwd).addScaledVector(dir, -this.fwd.dot(dir));
    pole.normalize();
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const elbow = pa.clone().addScaledVector(dir, L1 * cosA).addScaledVector(pole, L1 * Math.sqrt(1 - cosA * cosA));
    const hand = pa.clone().addScaledVector(dir, d);

    // Absolute bone rotations: bone axis onto the solved segment, elbow
    // hinge onto the bend plane's normal (pole × dir — stable even when the
    // arm is straight). No roll is left to chance, so the elbow can't fold
    // sideways and the upper arm doesn't corkscrew.
    const hinge = new THREE.Vector3().crossVectors(pole, dir).normalize();
    const RaIK = frameRotation(arm.upperDirL, arm.upperHingeL, elbow.clone().sub(pa), hinge);
    const RfIK = frameRotation(arm.foreDirL, arm.foreHingeL, hand.clone().sub(elbow), hinge);

    const newRa = Ra.clone().slerp(RaIK, hs.w);
    const newRf = Rf.clone().slerp(RfIK, hs.w);
    const newPf = arm.upperDirL.clone().applyQuaternion(newRa).multiplyScalar(L1).add(pa);
    const newPh = arm.foreDirL.clone().applyQuaternion(newRf).multiplyScalar(L2).add(newPf);
    // The hand is carried by the forearm's change, then turned to the grip.
    const carried = newRf.clone().multiply(Rf.clone().invert()).multiply(Rh);
    const newRh = carried.slerp(handRot, hs.rotW);
    const one = new THREE.Vector3(1, 1, 1);
    world[arm.arm].compose(pa, newRa, one);
    world[arm.fore].compose(newPf, newRf, one);
    world[arm.hand].compose(newPh, newRh, one);
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
