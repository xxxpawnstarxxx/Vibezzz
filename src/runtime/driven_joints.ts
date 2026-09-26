/** Driven (corrective) joints evaluated after the network's pose — a small
 *  TypeScript take on RigLogic's twist/swing joint behaviour
 *  (OpenRigLogic: riglogic/joints/cpu/twistswing).
 *
 *  The biped network only predicts 23 joints; every other joint in the rig
 *  normally just rides along rigidly with its parent. That's fine for Geno's
 *  mannequin, but on a realistic body it shows up as candy-wrapped wrists and
 *  a neck that bends in one crease. Driven joints fix that:
 *
 *    twist   — take the driver's rotation relative to `parent` (e.g. hand vs
 *              forearm), extract the twist about the parent→driver bone axis
 *              (swing/twist decomposition, like RigLogic's
 *              separateTwistComponentByAxis*), and apply `weight` of it to
 *              the output joint (a forearm roll helper at the elbow).
 *    follow  — rotate the output joint by `weight` of the way toward its
 *              driver's rotation (e.g. Neck1 halfway between Neck and Head).
 *
 *  Setups only rotate the output joint in place; its position stays where
 *  the rig cascade put it. Outputs must not have untracked children (their
 *  cascade has already run by the time these are evaluated).
 */

import * as THREE from "three";

export type DrivenJointSpec =
  | { kind: "twist"; output: string; parent: string; driver: string; weight: number }
  | { kind: "follow"; output: string; driver: string; weight: number };

export interface DrivenJoint {
  kind: "twist" | "follow";
  out: number;
  parent: number;
  driver: number;
  weight: number;
  /** Bind-pose rotation of driver relative to parent (twist) / output (follow). */
  bindRel: THREE.Quaternion;
  /** Twist axis in the parent's local frame (twist only). */
  axis: THREE.Vector3;
}

/** Resolve specs against a skeleton. `boneInverses` are the skin's inverse
 *  bind matrices (their inverses are the bind-pose world matrices). */
export function compileDrivenJoints(
  specs: readonly DrivenJointSpec[],
  boneNameToIndex: Map<string, number>,
  boneInverses: readonly THREE.Matrix4[],
): DrivenJoint[] {
  const idx = (name: string) => {
    const i = boneNameToIndex.get(name);
    if (i === undefined) throw new Error(`driven joint: bone '${name}' not in skeleton`);
    return i;
  };
  const bindRot = (i: number) => {
    const q = new THREE.Quaternion();
    new THREE.Matrix4().copy(boneInverses[i]).invert().decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  };
  const bindPos = (i: number) => new THREE.Vector3().setFromMatrixPosition(
    new THREE.Matrix4().copy(boneInverses[i]).invert());

  return specs.map((s) => {
    const out = idx(s.output);
    const driver = idx(s.driver);
    const parent = s.kind === "twist" ? idx(s.parent) : out;
    const bindRel = bindRot(parent).invert().multiply(bindRot(driver));
    // Twist axis: parent → driver bone direction, in the parent's frame.
    const axis = bindPos(driver).sub(bindPos(parent))
      .applyQuaternion(bindRot(parent).invert());
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
    axis.normalize();
    return { kind: s.kind, out, parent, driver, weight: s.weight, bindRel, axis };
  });
}

const _qp = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qo = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _twist = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _ident = new THREE.Quaternion();

/** Twist component of `q` about unit `axis` (swing/twist decomposition). */
function twistAbout(q: THREE.Quaternion, axis: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const len = Math.hypot(out.x, out.y, out.z, out.w);
  if (len < 1e-9) return out.identity();
  out.x /= len; out.y /= len; out.z /= len; out.w /= len;
  // Shortest arc so partial slerps don't spin the long way round.
  if (out.w < 0) { out.x = -out.x; out.y = -out.y; out.z = -out.z; out.w = -out.w; }
  return out;
}

/** Evaluate driven joints in place on an agent's world matrices. */
export function evaluateDrivenJoints(world: THREE.Matrix4[], joints: readonly DrivenJoint[]): void {
  for (const j of joints) {
    world[j.parent].decompose(_pos, _qp, _scl);
    world[j.driver].decompose(_pos, _qd, _scl);
    // Current driver rotation relative to parent, minus its bind offset →
    // the delta the network applied, expressed in the parent's frame.
    _qo.copy(j.bindRel).invert();
    _delta.copy(_qp).invert().multiply(_qd).multiply(_qo);
    if (j.kind === "twist") {
      twistAbout(_delta, j.axis, _twist);
      _twist.slerp(_ident, 1 - j.weight);
      // World-space twist = parent · twist · parent⁻¹, applied on top of the
      // output joint's cascaded rotation.
      _qd.copy(_qp).invert();                   // parent⁻¹
      _twist.premultiply(_qp).multiply(_qd);    // parent · twist · parent⁻¹
      world[j.out].decompose(_pos, _qo, _scl);
      _qo.premultiply(_twist);
    } else {
      if (_delta.w < 0) _delta.set(-_delta.x, -_delta.y, -_delta.z, -_delta.w);
      _delta.slerp(_ident, 1 - j.weight);
      world[j.out].decompose(_pos, _qo, _scl);
      _qo.multiply(_delta);
    }
    world[j.out].compose(_pos, _qo, _scl);
  }
}
