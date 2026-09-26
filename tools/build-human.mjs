/** Build `public/assets/human.glb` — the realistic, textured human from
 *  vibe-human re-skinned onto the Geno skeleton used by the biped network.
 *
 *  The output reuses Geno's skeleton *verbatim* (same joint names, hierarchy,
 *  rest pose and inverse bind matrices), so the neural motion-matching engine
 *  drives it exactly like `geno.glb`. Only the mesh, skin weights and
 *  materials change.
 *
 *  Pipeline:
 *    1. Read the Rigify (DEF-*) human and the Geno rig.
 *    2. Conform the human onto Geno's rest pose: scale to Geno's height, FK-
 *       rotate limbs from the human T-pose into Geno's A-pose about the
 *       human's own joints, then nudge elbows / wrists / knees / ankles /
 *       fingers onto Geno's pivots with a smooth along-bone offset.
 *    3. Remap skin weights DEF-* → Geno joints. The torso is redistributed by
 *       height along Geno's five-joint spine; split vertices are welded and
 *       weights diffused (strongest around shoulders and neck, where Geno's
 *       pivots differ most from the human's).
 *    4. Write body / head / eye primitives with embedded WebP textures, plus
 *       runtime skin detail maps under public/textures/human/.
 *
 *  Usage:  node tools/build-human.mjs [path/to/vibe-human]
 */

import * as THREE from "three";
import sharp from "sharp";
import { makeIO } from "./io.mjs";
import fs from "node:fs";
import path from "node:path";

const VIBE = process.argv[2] ?? path.resolve("../vibe-human");
const SRC_HUMAN = path.join(VIBE, "public/human5.glb");
const SRC_TEX = path.join(VIBE, "public/textures");
const GENO = "public/assets/geno.glb";
const OUT = "public/assets/human.glb";
const OUT_TEX = "public/textures/human";
const TEX_SIZE = 2048;

const io = await makeIO();
const human = await io.read(SRC_HUMAN);
const genoDoc = await io.read(GENO);

// ---------------------------------------------------------------------------
// Skeleton data
// ---------------------------------------------------------------------------

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

const hSkin = human.getRoot().listSkins()[0];
const hJointNames = hSkin.listJoints().map((j) => j.getName());
const hIbm = hSkin.getInverseBindMatrices().getArray();
/** Human bind-pose world matrix per DEF joint (mesh node is at identity). */
const hBind = new Map();
hJointNames.forEach((n, i) => hBind.set(n, new THREE.Matrix4().fromArray(hIbm, i * 16).invert()));
const hPos = (n) => {
  const m = hBind.get(n);
  if (!m) throw new Error(`human joint ${n} missing`);
  return new THREE.Vector3().setFromMatrixPosition(m);
};

const gSkin = genoDoc.getRoot().listSkins()[0];
const gJoints = gSkin.listJoints();
const gJointNames = gJoints.map((j) => j.getName());
const gIndex = new Map(gJointNames.map((n, i) => [n, i]));
const gPosMap = new Map(gJoints.map((j) => [
  j.getName(), new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(j.getWorldMatrix())),
]));
const gPos = (n) => {
  const p = gPosMap.get(n);
  if (!p) throw new Error(`geno joint ${n} missing`);
  return p.clone();
};

// Uniform body scale (human is authored ~2× life size).
const humanHeight = 3.494; // mesh bounds of human5.glb (feet at y≈0)
const genoHeight = 1.702;  // mesh bounds of geno.glb
const S = genoHeight / humanHeight;

// ---------------------------------------------------------------------------
// Conform: pose the (uniformly scaled) human into Geno's rest pose
// ---------------------------------------------------------------------------
//
// Each DEF bone gets
//   X_b  — an FK transform: world-space rotation about the bone's *own* posed
//          head (so LBS stays well-behaved, exactly like posing in a DCC), and
//   δ_b  — a translation field, linear along the bone, that nudges the posed
//          head/tail onto Geno's joint pivots where it matters (elbows,
//          wrists, knees, ankles, fingers).
// A vertex is conformed as  q = Σ w_b (X_b p + δ_b(X_b p)).
//
// The torso, clavicles, neck and head keep the human's own shape and joint
// placement — Geno's spine/shoulder pivots sit well inside its torso, and
// forcing the human onto them squashes the chest and tears the shoulders.

const hp = (n) => hPos(n).multiplyScalar(S); // scaled human joint position

/** Rotation taking frame (a1, a2) onto (b1, b2): primary axes match exactly,
 *  secondary axes match as closely as possible. */
function frameRotation(a1, a2, b1, b2) {
  const basis = (p, s) => {
    const x = p.clone().normalize();
    const z = new THREE.Vector3().crossVectors(x, s).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const A = basis(a1, a2), B = basis(b1, b2);
  return B.multiply(A.transpose());
}
const minimalRotation = (a, b) => new THREE.Matrix4().makeRotationFromQuaternion(
  new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize()));

/** Conform record per DEF bone. */
const C = new Map();
const IDENT = { X: new THREE.Matrix4(), R: new THREE.Matrix4(), seg: null };

/** Pose bone `name` (head/tail in scaled human space) with world rotation R,
 *  child of `parent` (whose X places this bone's head). `target` = [head, tail]
 *  in Geno space the posed segment should land on (tail may be null → the
 *  head offset is applied rigidly). */
function poseBone(name, head, tail, R, parent, target) {
  const X0 = parent ? C.get(parent).X : new THREE.Matrix4();
  const h = head.clone().applyMatrix4(X0);
  const X = new THREE.Matrix4().makeTranslation(h.x, h.y, h.z)
    .multiply(R)
    .multiply(new THREE.Matrix4().makeTranslation(-head.x, -head.y, -head.z));
  let seg = null;
  if (target) {
    const a = head.clone().applyMatrix4(X);
    const b = tail ? tail.clone().applyMatrix4(X) : null;
    const Da = target[0].clone().sub(a);
    const Db = b && target[1] ? target[1].clone().sub(b) : Da.clone();
    seg = { a, b: b ?? a.clone(), Da, Db };
  }
  C.set(name, { X, R, seg });
}
/** Share another bone's record (palms follow the hand, etc.). */
const alias = (name, of) => C.set(name, C.get(of));

// Torso, clavicles, neck, head, face: unchanged.
for (const n of hJointNames) C.set(n, IDENT);

const FINGERS = [
  ["thumb", "Thumb"], ["f_index", "Index"], ["f_middle", "Middle"], ["f_ring", "Ring"], ["f_pinky", "Pinky"],
];

for (const [s, Side] of [["L", "Left"], ["R", "Right"]]) {
  // ---- Legs: hip → knee → ankle → ball.
  {
    const hip = hp(`DEF-thigh.${s}`), knee = hp(`DEF-thigh.${s}.001`);
    const ankle = hp(`DEF-foot.${s}`), ball = hp(`DEF-toe.${s}`);
    const gHip = gPos(`${Side}UpLeg`), gKnee = gPos(`${Side}Leg`);
    const gAnkle = gPos(`${Side}Foot`), gBall = gPos(`${Side}ToeBase`);
    const Rt = minimalRotation(knee.clone().sub(hip), gKnee.clone().sub(gHip));
    poseBone(`DEF-thigh.${s}`, hip, knee, Rt, null, [gHip, gKnee]);
    const Rs = minimalRotation(ankle.clone().sub(knee).applyMatrix4(Rt), gAnkle.clone().sub(gKnee)).multiply(Rt);
    poseBone(`DEF-thigh.${s}.001`, knee, ankle, Rs, `DEF-thigh.${s}`, [gKnee, gAnkle]);
    const Rf = minimalRotation(ball.clone().sub(ankle).applyMatrix4(Rs), gBall.clone().sub(gAnkle)).multiply(Rs);
    poseBone(`DEF-foot.${s}`, ankle, ball, Rf, `DEF-thigh.${s}.001`, [gAnkle, gBall]);
    poseBone(`DEF-toe.${s}`, ball, null, Rf, `DEF-foot.${s}`, [gBall, null]);
  }

  // ---- Arms: T-pose → Geno's A-pose. The upper arm keeps the human's own
  // shoulder pivot and aims at Geno's elbow; from the elbow down every pivot
  // lands on Geno's. Forearm, hand and fingers share the palm's roll
  // (index→pinky knuckle axis) so the wrist doesn't twist.
  {
    const sh = hp(`DEF-upper_arm.${s}`), el = hp(`DEF-forearm.${s}.001`);
    const wr = hp(`DEF-hand.${s}`), kn = hp(`DEF-f_middle.01.${s}`);
    const gEl = gPos(`${Side}ForeArm`), gWr = gPos(`${Side}Hand`), gKn = gPos(`${Side}HandMiddle1`);
    const hSide = hp(`DEF-f_pinky.01.${s}`).sub(hp(`DEF-f_index.01.${s}`));
    const gSide = gPos(`${Side}HandPinky1`).sub(gPos(`${Side}HandIndex1`));

    const Ru = minimalRotation(el.clone().sub(sh), gEl.clone().sub(sh));
    poseBone(`DEF-upper_arm.${s}`, sh, el, Ru, null, [sh, gEl]);
    const Rfa = frameRotation(wr.clone().sub(el), hSide, gWr.clone().sub(gEl), gSide);
    poseBone(`DEF-forearm.${s}.001`, el, wr, Rfa, `DEF-upper_arm.${s}`, [gEl, gWr]);
    const Rh = frameRotation(kn.clone().sub(wr), hSide, gKn.clone().sub(gWr), gSide);
    poseBone(`DEF-hand.${s}`, wr, kn, Rh, `DEF-forearm.${s}.001`, [gWr, gKn]);
    for (let p = 1; p <= 4; p++) alias(`DEF-palm.0${p}.${s}`, `DEF-hand.${s}`);

    for (const [hf, gf] of FINGERS) {
      const h = [1, 2, 3].map((k) => hp(`DEF-${hf}.0${k}.${s}`));
      const g = [1, 2, 3].map((k) => gPos(`${Side}Hand${gf}${k}`));
      const r0 = frameRotation(h[1].clone().sub(h[0]), hSide, g[1].clone().sub(g[0]), gSide);
      const r1 = frameRotation(h[2].clone().sub(h[1]), hSide, g[2].clone().sub(g[1]), gSide);
      poseBone(`DEF-${hf}.01.${s}`, h[0], h[1], r0, `DEF-hand.${s}`, [g[0], g[1]]);
      poseBone(`DEF-${hf}.02.${s}`, h[1], h[2], r1, `DEF-${hf}.01.${s}`, [g[1], g[2]]);
      poseBone(`DEF-${hf}.03.${s}`, h[2], null, r1, `DEF-${hf}.02.${s}`, [g[2], null]);
    }
  }
}

/** Conform one point for bone `name` (input in scaled human space). */
const _t = new THREE.Vector3(), _ab = new THREE.Vector3();
function conformPoint(name, p, out) {
  const c = C.get(name);
  out.copy(p).applyMatrix4(c.X);
  if (c.seg) {
    const { a, b, Da, Db } = c.seg;
    _ab.subVectors(b, a);
    const len2 = _ab.lengthSq();
    const t = len2 > 1e-12 ? THREE.MathUtils.clamp(_t.subVectors(out, a).dot(_ab) / len2, 0, 1) : 0;
    out.x += Da.x + (Db.x - Da.x) * t;
    out.y += Da.y + (Db.y - Da.y) * t;
    out.z += Da.z + (Db.z - Da.z) * t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DEF → Geno weight mapping
// ---------------------------------------------------------------------------

const TORSO = new Set(["DEF-spine", "DEF-spine.001", "DEF-spine.002", "DEF-spine.003",
  "DEF-pelvis.L", "DEF-pelvis.R", "DEF-breast.L", "DEF-breast.R"]);
const TORSO_G = ["Hips", "Spine", "Spine1", "Spine2", "Spine3"];
const TORSO_Y = TORSO_G.map((n) => gPos(n).y);
const FACE = /^DEF-(ear|teeth|nose|eye|lid|tongue|jaw|chin|lip|brow|cheek|forehead|temple)|^DEF-spine\.006$/;

function mapJoint(n) {
  if (n === "DEF-spine.004") return "Neck";
  if (n === "DEF-spine.005") return "Neck1";
  if (FACE.test(n)) return "Head";
  let m;
  if ((m = n.match(/^DEF-(thigh|foot|toe|shoulder|upper_arm|forearm|hand|palm\.\d+)\.([LR])(\.001)?$/))) {
    const Side = m[2] === "L" ? "Left" : "Right";
    const part = m[1];
    if (part === "thigh") return m[3] ? `${Side}Leg` : `${Side}UpLeg`;
    if (part === "foot") return `${Side}Foot`;
    if (part === "toe") return `${Side}ToeBase`;
    if (part === "shoulder") return `${Side}Shoulder`;
    if (part === "upper_arm") return `${Side}Arm`;
    if (part === "forearm") return `${Side}ForeArm`;
    return `${Side}Hand`;
  }
  if ((m = n.match(/^DEF-(thumb|f_index|f_middle|f_ring|f_pinky)\.0(\d)\.([LR])$/))) {
    const gf = FINGERS.find(([h]) => h === m[1])[1];
    return `${m[3] === "L" ? "Left" : "Right"}Hand${gf}${m[2]}`;
  }
  throw new Error(`unmapped human joint ${n}`);
}

/** Forearm roll: Geno's `*ArmEnd` joints sit at the elbow under the forearm
 *  and are unused by Geno's own mesh. The runtime drives them with a share
 *  of the hand's twist (see src/runtime/driven_joints.ts), so forearm
 *  weights fade onto them from elbow (0) to wrist (1). */
const TWIST_SPLIT = new Map(["Left", "Right"].map((Side) => [`${Side}ForeArm`, {
  helper: `${Side}ArmEnd`, a: gPos(`${Side}ForeArm`), b: gPos(`${Side}Hand`),
}]));
function twistShare(split, q) {
  const ab = split.b.clone().sub(split.a);
  const t = THREE.MathUtils.clamp(q.clone().sub(split.a).dot(ab) / ab.lengthSq(), 0, 1);
  return THREE.MathUtils.smoothstep(t, 0.0, 1.0);
}

/** Split a torso weight across Geno's spine by the conformed vertex height.
 *  Piecewise-linear between segment midpoints, so weights are continuous
 *  (a vertex at the middle of a spine segment belongs 100% to that bone). */
const TORSO_TOP = gPos("Neck").y;
const TORSO_MID = TORSO_Y.map((y, i) => 0.5 * (y + (TORSO_Y[i + 1] ?? TORSO_TOP)));
function torsoSplit(y, w, out) {
  const add = (n, v) => out.set(n, (out.get(n) ?? 0) + v);
  if (y <= TORSO_MID[0]) { add(TORSO_G[0], w); return; }
  for (let i = 0; i < TORSO_MID.length - 1; i++) {
    if (y < TORSO_MID[i + 1]) {
      const t = (y - TORSO_MID[i]) / (TORSO_MID[i + 1] - TORSO_MID[i]);
      add(TORSO_G[i], w * (1 - t));
      add(TORSO_G[i + 1], w * t);
      return;
    }
  }
  add(TORSO_G[TORSO_G.length - 1], w);
}

// ---------------------------------------------------------------------------
// Conform + re-skin primitives
// ---------------------------------------------------------------------------

function readAttr(prim, name) {
  const a = prim.getAttribute(name);
  return a ? { arr: a.getArray(), size: a.getElementSize(), count: a.getCount(), norm: a.getNormalized(), comp: a.getComponentType() } : null;
}

/** Returns attribute arrays in Geno bind space with Geno joint indices. */
function convertPrimitive(prim, opts = {}) {
  const pos = prim.getAttribute("POSITION");
  const n = pos.getCount();
  const nrm = prim.getAttribute("NORMAL");
  const tan = prim.getAttribute("TANGENT");
  const uv = prim.getAttribute("TEXCOORD_0");
  const J = prim.getAttribute("JOINTS_0");
  const W = prim.getAttribute("WEIGHTS_0");

  const outPos = new Float32Array(n * 3);
  const outNrm = new Float32Array(n * 3);
  const outTan = new Float32Array(n * 4);
  const outUv = new Float32Array(n * 2);
  const outJ = new Uint16Array(n * 4);
  const outW = new Float32Array(n * 4);
  const weightMaps = []; // per-vertex Map<genoJoint, weight>, packed later

  const p = new THREE.Vector3(), q = new THREE.Vector3(), nn = new THREE.Vector3(), tt = new THREE.Vector3();
  const r = new THREE.Vector3();
  const blendR = new THREE.Matrix4();
  const normalMat = new THREE.Matrix3();
  const tmp = [], jt = [], wt = [];

  // Human influences per vertex. `neutral_bone` is a Rigify placeholder (two
  // stray toe vertices) — such vertices borrow a neighbour's influences.
  const infl = [];
  for (let i = 0; i < n; i++) {
    if (opts.rigidJoint) { infl.push([[opts.rigidJoint, 1]]); continue; }
    J.getElement(i, jt); W.getElement(i, wt);
    const list = [];
    for (let k = 0; k < 4; k++) {
      if (wt[k] > 0 && hJointNames[jt[k]] !== "neutral_bone") list.push([hJointNames[jt[k]], wt[k]]);
    }
    infl.push(list);
  }
  const srcIdx = prim.getIndices().getArray();
  for (let pass = 0; pass < 4; pass++) {
    for (let t = 0; t < srcIdx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = srcIdx[t + k];
        if (infl[v].length) continue;
        const nb = [srcIdx[t + (k + 1) % 3], srcIdx[t + (k + 2) % 3]].find((u) => infl[u].length);
        if (nb !== undefined) infl[v] = infl[nb];
      }
    }
  }

  for (let i = 0; i < n; i++) {
    pos.getElement(i, tmp); p.fromArray(tmp);
    if (opts.preMatrix) p.applyMatrix4(opts.preMatrix);

    const influences = infl[i];
    const wsum = influences.reduce((a, [, w]) => a + w, 0) || 1;

    // Conform (LBS over FK transforms + pivot offsets).
    p.multiplyScalar(S);
    q.set(0, 0, 0);
    blendR.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (const [name, w] of influences) {
      const c = C.get(name);
      if (!c) throw new Error(`no conform record for ${name}`);
      conformPoint(name, p, r).multiplyScalar(w / wsum);
      q.add(r);
      for (let e = 0; e < 16; e++) blendR.elements[e] += c.R.elements[e] * (w / wsum);
    }
    q.toArray(outPos, i * 3);

    normalMat.setFromMatrix4(blendR);
    if (nrm) {
      nrm.getElement(i, tmp); nn.fromArray(tmp);
      if (opts.preNormal) nn.applyMatrix3(opts.preNormal);
      nn.applyMatrix3(normalMat).normalize();
      nn.toArray(outNrm, i * 3);
    }
    if (tan) {
      tan.getElement(i, tmp); tt.set(tmp[0], tmp[1], tmp[2]);
      const handed = tmp[3] ?? 1;
      if (opts.preMatrix) tt.transformDirection(opts.preMatrix);
      tt.applyMatrix3(normalMat);
      // Re-orthogonalise against the new normal.
      tt.sub(nn.clone().multiplyScalar(nn.dot(tt))).normalize();
      outTan.set([tt.x, tt.y, tt.z, handed], i * 4);
    } else {
      outTan.set([1, 0, 0, 1], i * 4);
    }
    if (uv) { uv.getElement(i, tmp); outUv[i * 2] = tmp[0]; outUv[i * 2 + 1] = tmp[1]; }

    // Geno influences.
    const acc = new Map();
    for (const [name, w] of influences) {
      if (TORSO.has(name)) torsoSplit(q.y, w / wsum, acc);
      else {
        const g = mapJoint(name);
        const split = TWIST_SPLIT.get(g);
        if (split) {
          const sh = twistShare(split, q);
          acc.set(g, (acc.get(g) ?? 0) + (w / wsum) * (1 - sh));
          acc.set(split.helper, (acc.get(split.helper) ?? 0) + (w / wsum) * sh);
        } else {
          acc.set(g, (acc.get(g) ?? 0) + w / wsum);
        }
      }
    }
    weightMaps.push(acc);
  }

  const idx = prim.getIndices().getArray();
  return { outPos, outNrm, outTan, outUv, outJ, outW, weightMaps, idx: new Uint32Array(idx) };
}

/** Weld split vertices (UV seams and the head/body neck seam) by position
 *  and diffuse weights over the surface. The source weights have hard
 *  borders around the clavicles and deltoids; Geno's shoulder and neck
 *  pivots sit much further inside the torso than the human's, so those
 *  borders crease visibly once the network rotates them. Diffusion is
 *  strongest around shoulders/neck and light elsewhere. */
const SMOOTH_STRONG = new Set(["LeftShoulder", "RightShoulder", "LeftArm", "RightArm",
  "Spine2", "Spine3", "Neck", "Neck1"]);
const NO_SMOOTH = /Hand|Head/;
function smoothWeights(parts, iterations = 60, alpha = 0.5, base = 0.12) {
  // Spatial hash weld (1.5 mm tolerance) — the head/body seam vertices are
  // not bit-identical in the source.
  const TOL = 0.0015, CELL = 0.002;
  const cells = new Map();
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const members = []; // group → [[part, vertex], …]
  const reps = [];    // group → representative position
  for (const part of parts) {
    part.group = new Int32Array(part.outPos.length / 3);
    for (let i = 0; i < part.group.length; i++) {
      const x = part.outPos[i * 3], y = part.outPos[i * 3 + 1], z = part.outPos[i * 3 + 2];
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
      let g = -1;
      for (let dx = -1; dx <= 1 && g < 0; dx++) for (let dy = -1; dy <= 1 && g < 0; dy++) for (let dz = -1; dz <= 1 && g < 0; dz++) {
        for (const cand of cells.get(cellKey(cx + dx, cy + dy, cz + dz)) ?? []) {
          const r = reps[cand];
          if (Math.hypot(r[0] - x, r[1] - y, r[2] - z) < TOL) { g = cand; break; }
        }
      }
      if (g < 0) {
        g = members.length; members.push([]); reps.push([x, y, z]);
        const k = cellKey(cx, cy, cz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(g);
      }
      part.group[i] = g;
      members[g].push([part, i]);
    }
  }
  // Snap welded vertices together; where the head meets the body, also
  // average normals so the seam shades continuously.
  for (const ms of members) {
    if (ms.length < 2) continue;
    const avg = [0, 0, 0], nrm = [0, 0, 0];
    for (const [part, i] of ms) for (let k = 0; k < 3; k++) {
      avg[k] += part.outPos[i * 3 + k] / ms.length;
      nrm[k] += part.outNrm[i * 3 + k];
    }
    const crossPart = ms.some(([part]) => part !== ms[0][0]);
    const nl = Math.hypot(...nrm) || 1;
    for (const [part, i] of ms) for (let k = 0; k < 3; k++) {
      part.outPos[i * 3 + k] = avg[k];
      if (crossPart) part.outNrm[i * 3 + k] = nrm[k] / nl;
    }
  }
  const G = members.length;
  const nbrs = Array.from({ length: G }, () => new Set());
  for (const part of parts) {
    const I = part.idx, grp = part.group;
    for (let t = 0; t < I.length; t += 3) {
      const a = grp[I[t]], b = grp[I[t + 1]], c = grp[I[t + 2]];
      nbrs[a].add(b); nbrs[a].add(c); nbrs[b].add(a); nbrs[b].add(c); nbrs[c].add(a); nbrs[c].add(b);
    }
  }
  // Initial per-group weights: average of the welded members.
  let W = members.map((ms) => {
    const m = new Map();
    for (const [part, i] of ms) for (const [j, w] of part.weightMaps[i]) m.set(j, (m.get(j) ?? 0) + w / ms.length);
    return m;
  });
  const strength = W.map((m) => {
    const joints = [...m.keys()];
    if (joints.every((j) => NO_SMOOTH.test(j))) return 0;
    return joints.some((j) => SMOOTH_STRONG.has(j)) ? 1 : base;
  });
  for (let it = 0; it < iterations; it++) {
    W = W.map((m, g) => {
      const s = strength[g] * alpha;
      if (s === 0 || nbrs[g].size === 0) return m;
      const out = new Map();
      for (const [j, w] of m) out.set(j, w * (1 - s));
      const k = s / nbrs[g].size;
      for (const nb of nbrs[g]) for (const [j, w] of W[nb]) out.set(j, (out.get(j) ?? 0) + w * k);
      return out;
    });
  }
  for (let g = 0; g < G; g++) for (const [part, i] of members[g]) part.weightMaps[i] = W[g];
}

/** Keep the four strongest Geno influences per vertex, normalized. */
function packWeights(part) {
  part.weightMaps.forEach((acc, i) => {
    const top = [...acc.entries()].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tsum = top.reduce((a, [, w]) => a + w, 0);
    for (let k = 0; k < 4; k++) {
      if (k < top.length) {
        const gi = gIndex.get(top[k][0]);
        if (gi === undefined) throw new Error(`geno joint ${top[k][0]} missing`);
        part.outJ[i * 4 + k] = gi;
        part.outW[i * 4 + k] = top[k][1] / tsum;
      } else {
        part.outJ[i * 4 + k] = 0;
        part.outW[i * 4 + k] = 0;
      }
    }
  });
}

const hMesh = human.getRoot().listMeshes().find((m) => m.getName() === "Plane.002");
const [bodyPrim, headPrim] = hMesh.listPrimitives();
const body = convertPrimitive(bodyPrim);
const head = convertPrimitive(headPrim);
smoothWeights([body, head]);
packWeights(body);
packWeights(head);

const eyeParts = [];
for (const node of human.getRoot().listNodes()) {
  if (!/^Eye_[LR]$/.test(node.getName())) continue;
  const world = new THREE.Matrix4().fromArray(node.getWorldMatrix());
  const preNormal = new THREE.Matrix3().getNormalMatrix(world);
  eyeParts.push(convertPrimitive(node.getMesh().listPrimitives()[0], {
    preMatrix: world, preNormal, rigidJoint: "DEF-spine.006",
  }));
}
function concat(parts) {
  const cat = (key, Ctor) => {
    const total = parts.reduce((a, p) => a + p[key].length, 0);
    const out = new Ctor(total);
    let o = 0;
    for (const p of parts) { out.set(p[key], o); o += p[key].length; }
    return out;
  };
  const res = {
    outPos: cat("outPos", Float32Array), outNrm: cat("outNrm", Float32Array),
    outTan: cat("outTan", Float32Array), outUv: cat("outUv", Float32Array),
    outJ: cat("outJ", Uint16Array), outW: cat("outW", Float32Array),
  };
  const idx = [];
  let base = 0;
  for (const p of parts) { for (const i of p.idx) idx.push(i + base); base += p.outPos.length / 3; }
  res.idx = new Uint32Array(idx);
  return res;
}
eyeParts.forEach(packWeights);
const eyes = concat(eyeParts);

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT_TEX, { recursive: true });
async function webp(src, size, opts = {}) {
  let img = sharp(src).resize(size, size, { fit: "fill" });
  if (opts.roughnessToMR) {
    // glTF metallicRoughness: G = roughness, B = metalness (0).
    const { data, info } = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
    const rgb = Buffer.alloc(info.width * info.height * 3);
    for (let i = 0; i < info.width * info.height; i++) {
      rgb[i * 3] = 255; rgb[i * 3 + 1] = data[i * info.channels]; rgb[i * 3 + 2] = 0;
    }
    img = sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } });
  }
  return img.webp({ quality: opts.quality ?? 88, effort: 5 }).toBuffer();
}

const tex = {
  headColor: await webp(path.join(SRC_TEX, "colorfinal4k.jpg"), TEX_SIZE),
  headNormal: await webp(path.join(SRC_TEX, "wrinklenormalhd.webp"), TEX_SIZE, { quality: 92 }),
  headMR: await webp(path.join(SRC_TEX, "roughnessv5.png"), 1024, { roughnessToMR: true }),
  bodyColor: await webp(path.join(SRC_TEX, "body/albedo.png"), 2048),
  bodyNormal: await webp(path.join(SRC_TEX, "body/normal.png"), 2048, { quality: 92 }),
  eyes: await webp(path.join(SRC_TEX, "eyes.png"), 1024),
};

// Runtime-only skin detail maps (sampled by the SSS skin shader).
const detail = [
  ["poremap2k.webp", "pores.webp", 2048],
  ["subdermal.png", "head_subdermal.webp", 1024],
  ["body/subdermal.png", "body_subdermal.webp", 1024],
  ["sss.png", "head_sss.webp", 1024],
  ["specular.png", "head_specular.webp", 1024],
];
for (const [src, dst, size] of detail) {
  fs.writeFileSync(path.join(OUT_TEX, dst), await webp(path.join(SRC_TEX, src), size));
}

// ---------------------------------------------------------------------------
// Assemble the output GLB on top of Geno's skeleton
// ---------------------------------------------------------------------------

const out = genoDoc; // keep Geno nodes, skin and inverse bind matrices verbatim
const root = out.getRoot();
const buffer = root.listBuffers()[0];
const webpExt = out.createExtension((await import("@gltf-transform/extensions")).EXTTextureWebP).setRequired(true);
void webpExt;

const genoMesh = root.listMeshes()[0];
for (const prim of genoMesh.listPrimitives()) { genoMesh.removePrimitive(prim); prim.dispose(); }
for (const m of root.listMaterials()) m.dispose();
genoMesh.setName("Human");
root.listNodes().find((nd) => nd.getMesh() === genoMesh).setName("Human");

// The human's shoulder (glenohumeral) pivot sits ~7 cm lateral of Geno's
// LeftArm/RightArm joint, which is buried inside Geno's torso. Record the
// mesh's real pivot (bind space) so the runtime can rotate the arm mesh about
// it (src/runtime/arm_pivots.ts) instead of collapsing the deltoid.
for (const [s, Side] of [["L", "Left"], ["R", "Right"]]) {
  const node = root.listNodes().find((nd) => nd.getName() === `${Side}Arm`);
  node.setExtras({ ...node.getExtras(), meshPivot: hp(`DEF-upper_arm.${s}`).toArray().map((v) => +v.toFixed(5)) });
}

const mkTex = (name, data) => out.createTexture(name).setImage(new Uint8Array(data)).setMimeType("image/webp");

function mkMaterial(name, { color, normal, mr, roughness = 0.6 }) {
  const m = out.createMaterial(name).setMetallicFactor(0).setRoughnessFactor(roughness);
  if (color) m.setBaseColorTexture(mkTex(`${name}_color`, color));
  if (normal) m.setNormalTexture(mkTex(`${name}_normal`, normal));
  if (mr) m.setMetallicRoughnessTexture(mkTex(`${name}_mr`, mr));
  return m;
}
const matBody = mkMaterial("Skin_Body", { color: tex.bodyColor, normal: tex.bodyNormal, roughness: 0.62 });
const matHead = mkMaterial("Skin_Head", { color: tex.headColor, normal: tex.headNormal, mr: tex.headMR, roughness: 1 });
const matEyes = mkMaterial("Eyes", { color: tex.eyes, roughness: 0.05 });

function addPrimitive(data, material) {
  const acc = (type, arr) => out.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = out.createPrimitive()
    .setAttribute("POSITION", acc("VEC3", data.outPos))
    .setAttribute("NORMAL", acc("VEC3", data.outNrm))
    .setAttribute("TANGENT", acc("VEC4", data.outTan))
    .setAttribute("TEXCOORD_0", acc("VEC2", data.outUv))
    .setAttribute("JOINTS_0", acc("VEC4", data.outJ))
    .setAttribute("WEIGHTS_0", acc("VEC4", data.outW))
    .setIndices(acc("SCALAR", data.idx))
    .setMaterial(material);
  genoMesh.addPrimitive(prim);
}
addPrimitive(body, matBody);
addPrimitive(head, matHead);
addPrimitive(eyes, matEyes);

// Drop anything left dangling (old material / accessors).
const { prune } = await import("@gltf-transform/functions");
// keepAttributes: every primitive must keep the same attribute set (the
// runtime merges them into one grouped geometry).
await out.transform(prune({ keepAttributes: true }));
await io.write(OUT, out);

// Report.
const bb = (arr) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]);
  }
  return `[${mn.map((v) => v.toFixed(3))}] → [${mx.map((v) => v.toFixed(3))}]`;
};
console.log("body", body.outPos.length / 3, "verts", bb(body.outPos));
console.log("head", head.outPos.length / 3, "verts", bb(head.outPos));
console.log("eyes", eyes.outPos.length / 3, "verts", bb(eyes.outPos));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
