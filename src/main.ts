/** Demo driver for the NMMEngine — mixed biped + quadruped scene.
 *
 *  Two engines run in parallel, each with its own instanced SkinnedMesh.
 *  One agent at a time is the "player": WASD-driven, camera follows. Other
 *  agents run on autopilot brains. Tab (or the on-screen Switch button)
 *  cycles which agent is the player.
 *
 *  Controls:
 *    Biped player     — WASD move, Shift sprint, LMB-drag facing, Q/E style
 *    Quadruped player — WASD move, Alt/Ctrl/Shift gait, R/T/V sit/stand/lie
 *    Debug layers     — 1..5 toggles
 *    Tab              — cycle player through alive agents
 */
import * as THREE from "three";
import { NMMEngine } from "./engine/index.js";
import type { NMMAgent, DrivenJointSpec } from "./engine/index.js";
import { makeScene, loadEnvironment } from "./render/scene.js";
import { createHumanMaterialFactory, DEFAULT_SKIN } from "./render/skin.js";
import type { SkinUniforms } from "./render/skin.js";
import { Input } from "./input.js";
import { Touch } from "./touch.js";
import { GamepadInput, PAD } from "./gamepad.js";
import { HalfSword } from "./runtime/half_sword.js";
import { HalfSwordInput } from "./half_sword_input.js";
import { createSword, setSwordBlood } from "./render/sword.js";
import { LooseSword } from "./runtime/loose_items.js";
import { GrabController } from "./runtime/grab.js";
import type { GrabEvent, GrabWorld } from "./runtime/grab.js";
import type { HandSide } from "./runtime/half_sword.js";
import type { DummyWorld } from "./runtime/dummy_ai.js";
import { EnemyDirector, RANKS, WAVES } from "./runtime/director.js";
import type { Rank } from "./runtime/director.js";
import { freshLimbs } from "./runtime/combat.js";
import type { Region } from "./runtime/combat.js";
import { BodyColliders, CombatSystem, HitReactor } from "./runtime/combat.js";
import type { CombatEvent, Fighter } from "./runtime/combat.js";
import { DummyAI } from "./runtime/dummy_ai.js";
import type { DummySettings } from "./runtime/dummy_ai.js";
import { BladeTrail, CombatFx, Wounds } from "./render/combat_fx.js";
import { Sfx } from "./audio/sfx.js";
import { Debug } from "./render/debug.js";
import { UI } from "./render/ui.js";
import type { DirectionalLightParams, LookParams } from "./render/ui.js";
import { StudioLights, DEFAULT_BULB, DEFAULT_TRANSFORMS } from "./render/studiolights.js";
import * as V from "./math/vec3.js";
import { isQuadruped } from "./model/bundle.js";
import type { ModelKind } from "./model/bundle.js";
import type { Vec3 } from "./math/vec3.js";
import { BipedBrain, QuadrupedBrain } from "./runtime/autopilot.js";
import type { Brain } from "./runtime/autopilot.js";

declare const __APP_VERSION__: string;
{
  const el = document.getElementById("app-version");
  if (el) el.textContent = __APP_VERSION__;
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const bootEl = document.getElementById("boot") as HTMLDivElement;
const setBoot = (m: string) => { if (bootEl) { bootEl.textContent = m; bootEl.style.display = ""; } };
const hideBoot = () => { if (bootEl) bootEl.style.display = "none"; };

const MAX_AGENTS_PER_KIND = 32;

/** Biped characters. Both share Geno's skeleton, so the same network drives
 *  either; `human` is the textured vibe-human body re-skinned onto that rig
 *  by `tools/build-human.mjs`. */
const CHARACTERS = {
  human: { label: "Realistic human", glb: "/assets/human.glb" },
  geno: { label: "Geno (mannequin)", glb: "/assets/geno.glb" },
} as const;
type CharacterId = keyof typeof CHARACTERS;

/** Corrective joints layered on the network's 23-joint pose (RigLogic-style
 *  twist / follow behaviours). Forearm roll helpers only affect meshes that
 *  weight them (the realistic human); Neck1 splits head motion across the
 *  neck for both characters. */
const BIPED_DRIVEN_JOINTS: DrivenJointSpec[] = [
  { kind: "twist", output: "LeftArmEnd", parent: "LeftForeArm", driver: "LeftHand", weight: 0.8 },
  { kind: "twist", output: "RightArmEnd", parent: "RightForeArm", driver: "RightHand", weight: 0.8 },
  { kind: "follow", output: "Neck1", driver: "Head", weight: 0.5 },
];
const PLAYFIELD_RADIUS = 12;
const LOCOMOTION_SPEED = {
  walk: 0.7, pace: 1.2, trot: 2.0, canter: 4.0,
} as const;

interface AgentRecord {
  id: string;              // stable — used as the steer-dropdown key
  label: string;           // "Biped #1", "Dog #3"
  kind: ModelKind;
  agent: NMMAgent;
  brain: Brain | null;     // null iff this agent is the player (or a dummy)
  /** Sparring dummy — driven by DummyAI, never player-controlled. */
  dummy?: boolean;
}

async function boot() {
  setBoot("initializing WebGPU…");
  const { renderer, scene, camera, controls, key: shadowLight } = await makeScene(canvas);

  const directionalParams: DirectionalLightParams = {
    color: "#ffffff",
    intensity: 2.5,
    offsetX: 6, offsetY: 10, offsetZ: 4,
    castShadow: true,
  };
  const applyDirectional = (p: DirectionalLightParams) => {
    shadowLight.color.set(p.color);
    shadowLight.intensity = p.intensity;
    shadowLight.castShadow = p.castShadow;
  };
  applyDirectional(directionalParams);

  const params = new URLSearchParams(location.search);
  const precision = (params.get("precision") === "fp32" ? "fp32" : "fp16") as "fp32" | "fp16";

  const character: CharacterId = params.get("character") === "geno" ? "geno" : "human";

  setBoot("loading biped + quadruped bundles + meshes…");
  let skinUniforms: SkinUniforms | null = null;
  const bipedMaterials = character === "human"
    ? await createHumanMaterialFactory("/textures/human/")
    : null;
  if (bipedMaterials) skinUniforms = bipedMaterials.uniforms;
  const [bipedEngine, quadrupedEngine] = await Promise.all([
    NMMEngine.load({
      renderer, bundleBaseUrl: "/", characterGlbUrl: CHARACTERS[character].glb,
      maxAgents: MAX_AGENTS_PER_KIND, precision, bundleKind: "biped",
      materialFactory: bipedMaterials?.factory,
      drivenJoints: BIPED_DRIVEN_JOINTS,
      // Dual-quaternion skinning keeps volume through elbow / shoulder /
      // wrist rotations (linear blending collapses them).
      dqs: character === "human" ? 1 : 0,
    }),
    NMMEngine.load({
      renderer, bundleBaseUrl: "/", characterGlbUrl: "/assets/dog.glb",
      maxAgents: MAX_AGENTS_PER_KIND, precision, bundleKind: "quadruped",
    }),
  ]);

  scene.add(bipedEngine.mesh);
  scene.add(quadrupedEngine.mesh);

  // Half Sword mode: mouse-driven hands + a simulated sword for the biped
  // player; the network keeps doing the locomotion underneath.
  const halfSword = new HalfSword(bipedEngine.rig);
  const halfSwordInput = new HalfSwordInput(canvas);
  const sword = createSword();
  scene.add(sword);
  const hsState = { enabled: false, halfGrip: false };

  // Combat: body colliders for every biped, blade contacts, dummies, FX.
  const skelBones = bipedEngine.mesh.skeleton.bones;
  const boneParents = skelBones.map((b) => skelBones.indexOf(b.parent as THREE.Bone));
  const combat = new CombatSystem(new BodyColliders(bipedEngine.rig.boneNameToIndex));
  const fx = new CombatFx();
  scene.add(fx.group);
  const sfx = new Sfx();
  const playerTrail = new BladeTrail();
  scene.add(playerTrail.mesh);
  interface DummyRec { id: string; ai: DummyAI; sword: HalfSword; mesh: THREE.Group; trail: BladeTrail }
  const dummies = new Map<string, DummyRec>();
  const dummySettings: DummySettings = { aggression: 0.55, blockSkill: 0.55, fightsBack: true, power: 0.6 };
  let dummyCounter = 0;
  let hitStop = 0;
  const gore = { bloodRate: 1, playerDamage: 1, enemyDamage: 1 };
  const wounds = new Wounds();
  scene.add(wounds.mesh);

  // --- loose swords + grabbing ---------------------------------------------
  const items: LooseSword[] = [];
  /** Held sword mesh per fighter id (player: `sword`, dummies: their mesh). */
  const heldMesh = (f: Fighter): THREE.Group | null =>
    f.id === playerId ? sword : dummies.get(f.id)?.mesh ?? null;
  function spawnLoose(position: THREE.Vector3, quaternion: THREE.Quaternion,
    velocity = new THREE.Vector3(), angular = new THREE.Vector3(), blood = 0): LooseSword {
    const mesh = createSword();
    mesh.visible = true;
    setSwordBlood(mesh, blood);
    scene.add(mesh);
    const it = new LooseSword(mesh);
    it.position.copy(position); it.quaternion.copy(quaternion);
    it.velocity.copy(velocity); it.angularVelocity.copy(angular);
    it.cooldown = 0.6;
    it.sync();
    items.push(it);
    return it;
  }
  function dropSword(f: Fighter): LooseSword | null {
    combat.releaseStuck(f);
    const data = f.sword?.dropSword();
    if (!data) return null;
    const mesh = heldMesh(f);
    const blood = mesh ? (mesh.userData.blood as number) : 0;
    if (mesh) setSwordBlood(mesh, 0);
    return spawnLoose(data.position, data.quaternion, data.velocity, data.angularVelocity, blood);
  }
  function pickUp(f: Fighter, item: LooseSword, side: HandSide): void {
    const i = items.indexOf(item);
    if (i >= 0) items.splice(i, 1);
    scene.remove(item.mesh);
    f.sword?.pickUp(side);
    const mesh = heldMesh(f);
    if (mesh) setSwordBlood(mesh, (item.mesh.userData.blood as number) ?? 0);
  }
  function emitGrab(e: GrabEvent): void {
    if (import.meta.env.DEV) {
      const log = ((window as unknown as { __events?: unknown[] }).__events ??= []);
      log.push({ k: e.kind, who: e.who.id });
      if (log.length > 30) log.shift();
    }
    if (e.kind === "grab") { sfx.tap(); popup(e.point, "GRAB", "grab"); }
    else if (e.kind === "throw") {
      sfx.hit(5, false); fx.shake(0.02); hitStop = Math.max(hitStop, 0.06);
      popup(e.point, "THROWN", "crit");
    } else if (e.kind === "disarm") {
      sfx.clang(3); fx.shake(0.012);
      popup(e.point, e.kept ? "DISARMED — YOURS" : "DISARMED", "crit");
      banner(`${e.target.label.toUpperCase()} DISARMED`);
    } else if (e.kind === "pickup") { sfx.tap(); popup(e.point, "PICKED UP", "parry"); }
    else if (e.kind === "broke-free") { sfx.hit(2, false); popup(e.point, "BROKE FREE", "taken"); }
  }
  const grabWorld: GrabWorld = {
    get fighters() { return combat.fighters.values(); },
    items,
    dropSword,
    pickUp,
    event: emitGrab,
  };
  const dummyWorld: DummyWorld = {
    items,
    dropSword,
    pickUp: (f, it, side) => { pickUp(f, it, side); emitGrab({ kind: "pickup", who: f, point: it.position.clone() }); },
    tackled: (by, target) => {
      const dir = new THREE.Vector3(...target.agent.getPosition()).sub(new THREE.Vector3(...by.agent.getPosition())).setY(0).normalize();
      target.stagger = 1.1;
      target.push = dir.clone().multiplyScalar(2.6);
      target.reactor.impulse(dir, 4.5);
      sfx.hit(4, false); hitStop = Math.max(hitStop, 0.05);
      if (target.id === playerId) fx.shake(0.025);
      const p = new THREE.Vector3(...target.agent.getPosition()).setY(1.2);
      popup(p, "TACKLED", target.id === playerId ? "taken" : "crit");
    },
  };
  let grabber: GrabController | null = null;
  const director = new EnemyDirector();
  /** Gauntlet (wave) mode state. */
  const gauntlet = { active: false, wave: 0, phase: "idle" as "idle" | "fighting" | "cleared" | "dead" | "won", timer: 0 };
  const removeAt = new Map<string, number>();   // dead enemy id → time to remove
  let struggle = 0;
  const barsEl = document.getElementById("enemy-bars");
  const bars = new Map<string, HTMLDivElement>();
  /** Fighter heading in Half Sword mode — turned with Q / E; orbiting the
   *  camera (MMB) doesn't turn the fighter. */
  const hsHeading = new THREE.Vector3(0, 0, 1);

  // Image-based fill light — skin, eyes and the clearcoat oil film need
  // something to reflect. The visible background stays the dark studio.
  const lookParams: LookParams = {
    exposure: 1.0,
    environment: 0.45,
    poreStrength: DEFAULT_SKIN.poreStrength,
    detailStrength: DEFAULT_SKIN.detailStrength,
    oiliness: DEFAULT_SKIN.oiliness,
    roughness: DEFAULT_SKIN.roughness,
    subsurface: DEFAULT_SKIN.subsurface,
  };
  const applyLook = (p: LookParams) => {
    renderer.toneMappingExposure = p.exposure;
    scene.environmentIntensity = p.environment;
    if (skinUniforms) {
      skinUniforms.poreStrength.value = p.poreStrength;
      skinUniforms.detailStrength.value = p.detailStrength;
      skinUniforms.oiliness.value = p.oiliness;
      skinUniforms.roughness.value = p.roughness;
      skinUniforms.subsurface.value = p.subsurface;
    }
  };
  applyLook(lookParams);
  loadEnvironment(scene, "/assets/env/potsdamer_platz_1k.hdr")
    .catch((err) => console.warn("[env] HDR environment unavailable", err));

  // Studio lights — two GLB instances drawn as one InstancedMesh per source
  // mesh, each fitted with its own RectAreaLight whose pose is derived from
  // the studiolight transform + a shared bulb-relative offset/rotation.
  const studioLights = await StudioLights.load("/assets/studiolight.glb");
  scene.add(studioLights.group);
  const studioState = {
    bulb: { ...DEFAULT_BULB },
    transforms: [
      { ...DEFAULT_TRANSFORMS[0] },
      { ...DEFAULT_TRANSFORMS[1] },
    ] as [typeof DEFAULT_TRANSFORMS[0], typeof DEFAULT_TRANSFORMS[1]],
  };
  studioLights.setBulbParams(studioState.bulb);
  studioLights.setStudioTransform(0, studioState.transforms[0]);
  studioLights.setStudioTransform(1, studioState.transforms[1]);

  const agents = new Map<string, AgentRecord>();
  const spawnCounters = { biped: 0, quadruped: 0 };
  let playerId: string | null = null;
  let debug: Debug | null = null;
  let lastPlayerKind: ModelKind | null = null;

  const touch = new Touch({ onSwitch: () => cyclePlayer() });
  const gamepad = new GamepadInput();
  const input = new Input(canvas, touch, gamepad);

  // Tap / click a character to take control of it. Taps are told apart from
  // drags (LMB facing, orbit, pinch) by travel + duration, the same way
  // human-atlas separates selection taps from rotation drags.
  let tapStart: { x: number; y: number; t: number; id: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    tapStart = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  });
  canvas.addEventListener("pointerup", (e) => {
    const s = tapStart;
    tapStart = null;
    if (!s || s.id !== e.pointerId || halfSword.enabled) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6 || e.timeStamp - s.t > 350) return;
    const hit = pickAgent(e.clientX, e.clientY);
    if (hit && hit !== playerId) {
      setPlayer(hit);
    }
  });
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  /** Ray vs. an upright capsule per agent (cheap stand-in for picking the
   *  instanced, GPU-skinned mesh). Returns the nearest hit's id. */
  function pickAgent(clientX: number, clientY: number): string | null {
    const rect = canvas.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    const { origin, direction } = _ray.ray;
    let best: string | null = null, bestT = Infinity;
    for (const r of agents.values()) {
      if (r.dummy) continue;
      const [px, py, pz] = r.agent.getPosition();
      const height = r.kind === "biped" ? 1.8 : 0.8;
      const radius = r.kind === "biped" ? 0.35 : 0.45;
      // Closest approach between the ray and the capsule's vertical axis.
      const a = new THREE.Vector3(px, py + radius, pz);
      const axis = new THREE.Vector3(0, Math.max(0, height - 2 * radius), 0);
      const w0 = origin.clone().sub(a);
      const b = direction.dot(axis), c = axis.dot(axis);
      const d = direction.dot(w0), e2 = axis.dot(w0);
      const denom = c - b * b;
      let t = denom > 1e-9 ? (b * e2 - c * d) / denom : -d;
      const sAxis = c > 0 ? THREE.MathUtils.clamp((e2 + b * t) / c, 0, 1) : 0;
      const onAxis = a.clone().addScaledVector(axis, sAxis);
      t = Math.max(0, onAxis.clone().sub(origin).dot(direction));
      const dist = origin.clone().addScaledVector(direction, t).distanceTo(onAxis);
      if (dist < radius && t < bestT) { bestT = t; best = r.id; }
    }
    return best;
  }

  // WASD keycap hint — clicking a key behaves like holding the matching
  // keyboard key (writes into input.keys). The canvas is a sibling, so
  // clicks don't bubble to its LMB-facing handler. setPointerCapture keeps
  // the press alive if the user drags off the key before releasing.
  const wasdKeys = ["w", "a", "s", "d"] as const;
  const wasdEls: Record<string, HTMLElement | null> = {};
  for (const k of wasdKeys) {
    const el = document.querySelector<HTMLElement>(`#wasd-hint [data-k='${k}']`);
    wasdEls[k] = el;
    if (!el) continue;
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      input.keys.add(k);
      el.classList.add("pressed");
    });
    const release = () => { input.keys.delete(k); el.classList.remove("pressed"); };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }
  window.addEventListener("keydown", (e) => {
    wasdEls[e.key.toLowerCase()]?.classList.add("pressed");
  });
  window.addEventListener("keyup", (e) => {
    wasdEls[e.key.toLowerCase()]?.classList.remove("pressed");
  });

  // Credit button + popup. Toggle on click; close on outside click or Esc.
  const creditBtn = document.getElementById("credit-btn");
  const creditPopup = document.getElementById("credit-popup");
  if (creditBtn && creditPopup) {
    creditBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      creditPopup.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (creditPopup.classList.contains("hidden")) return;
      const t = e.target;
      if (t instanceof Node && (creditPopup.contains(t) || creditBtn.contains(t))) return;
      creditPopup.classList.add("hidden");
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") creditPopup.classList.add("hidden");
    });
  }

  // --- Camera follow ----------------------------------------------------
  const initialCameraPos = camera.position.clone();
  const initialTarget = controls.target.clone();
  function cameraFollow() {
    const player = playerId ? agents.get(playerId) : null;
    if (!player) return;
    const target = player.agent.getPosition();
    const headY = player.kind === "biped" ? 1.2 : 0.5;
    const desired = new THREE.Vector3(target[0], target[1] + headY, target[2]);
    const prev = controls.target;
    const dx = desired.x - prev.x, dy = desired.y - prev.y, dz = desired.z - prev.z;
    prev.x += dx; prev.y += dy; prev.z += dz;
    camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    controls.update();
    // Re-anchor the directional rig so its tight shadow box stays around the
    // player. Offset is authored via the tweakpane directional folder.
    shadowLight.position.set(
      target[0] + directionalParams.offsetX,
      target[1] + directionalParams.offsetY,
      target[2] + directionalParams.offsetZ);
    shadowLight.target.position.set(target[0], target[1], target[2]);
    shadowLight.target.updateMatrixWorld();
  }

  function rosterOptions() {
    return Array.from(agents.values()).filter((r) => !r.dummy).map((r) => ({ id: r.id, label: r.label }));
  }

  function contactLabelsFor(kind: ModelKind): [string, string, string, string] {
    // Bundle has skeleton.contact_labels; not in bundle types' common base so cast.
    const engine = kind === "biped" ? bipedEngine : quadrupedEngine;
    const labels = (engine.bundle.meta.skeleton as unknown as { contact_labels: string[] })
      .contact_labels;
    return [labels[0], labels[1], labels[2], labels[3]];
  }

  /** Canonical default style for a kind — what the player should spawn with
   *  so its motion is predictable, not randomized. */
  function defaultStyleFor(kind: ModelKind): string {
    const engine = kind === "biped" ? bipedEngine : quadrupedEngine;
    const styles = engine.styles;
    // Biped's "Neutral" is the plain locomotion style. Quadruped guidance is
    // speed-driven so any starting value is overwritten in updateControl —
    // pick the first guidance to keep things deterministic.
    if (kind === "biped" && styles.includes("Neutral")) return "Neutral";
    return styles[0];
  }

  // --- UI ---------------------------------------------------------------
  const ui = new UI({
    renderer,
    onSpawnBiped: () => spawn("biped"),
    onSpawnDog: () => spawn("quadruped"),
    onClearAll: () => clearAll(),
    onSteerChange: (id) => setPlayer(id === "none" ? null : id),
    onStyleChange: (style) => {
      const player = playerId ? agents.get(playerId) : null;
      if (player) player.agent.setStyle(style);
    },
    onResetCamera: () => {
      const player = playerId ? agents.get(playerId) : null;
      const base = player ? player.agent.getPosition() : [0, 0, 0];
      camera.position.set(
        base[0] + initialCameraPos.x,
        base[1] + initialCameraPos.y,
        base[2] + initialCameraPos.z);
      controls.target.set(
        base[0] + initialTarget.x,
        base[1] + initialTarget.y,
        base[2] + initialTarget.z);
      controls.update();
    },
    studio: {
      bulb: studioState.bulb,
      transforms: studioState.transforms,
      onBulbChange: (p) => studioLights.setBulbParams(p),
      onTransformChange: (idx, t) => studioLights.setStudioTransform(idx, t),
    },
    directional: {
      params: directionalParams,
      onChange: (p) => applyDirectional(p),
    },
    character: {
      current: character,
      options: Object.fromEntries(
        Object.entries(CHARACTERS).map(([id, c]) => [c.label, id])),
      onChange: (id) => {
        const url = new URL(location.href);
        url.searchParams.set("character", id);
        location.href = url.toString();
      },
    },
    halfSword: {
      state: hsState,
      settings: halfSword.settings,
      onToggle: (on) => { if (on !== halfSword.enabled) setHalfSword(on); },
      onSwapHands: () => halfSword.swapHands(),
      dummy: dummySettings,
      onSpawnDummy: () => spawnDummy(),
      onGauntlet: () => (gauntlet.active ? stopGauntlet() : startGauntlet()),
      gore,
    },
    look: {
      params: lookParams,
      skin: character === "human",
      onChange: (p) => applyLook(p),
    },
  });

  // --- Debug-layer keyboard shortcuts ----------------------------------
  // Listen on window — canvas focus isn't reliable when overlay UIs eat clicks.
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"
      || t.tagName === "SELECT" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (!debug) return;
    if (k === "1") { debug.toggle("simulation"); ui.syncDebugStates(); }
    else if (k === "2") { debug.toggle("rootControl"); ui.syncDebugStates(); }
    else if (k === "3") { debug.toggle("prevSeq"); ui.syncDebugStates(); }
    else if (k === "4") { debug.toggle("curSeq"); ui.syncDebugStates(); }
    else if (k === "5") { debug.toggle("guidance"); ui.syncDebugStates(); }
    else if (k === "tab") { e.preventDefault(); cyclePlayer(); }
  });

  // --- Spawn / clear ---------------------------------------------------
  function spawnPosition(): { pos: Vec3; facing: Vec3 } {
    // Bias the first few spawns close to origin, spread the rest farther out.
    const count = agents.size;
    const radius = Math.min(PLAYFIELD_RADIUS, 1.5 + count * 0.6);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    return {
      pos: [Math.cos(a) * r, 0, Math.sin(a) * r],
      facing: [-Math.cos(a), 0, -Math.sin(a)],
    };
  }

  function spawn(kind: ModelKind): void {
    const engine = kind === "biped" ? bipedEngine : quadrupedEngine;
    if (engine.agentCount >= MAX_AGENTS_PER_KIND) {
      console.warn(`[spawn] ${kind} at cap (${MAX_AGENTS_PER_KIND}) — ignoring`);
      return;
    }
    const { pos, facing } = spawnPosition();

    // Pick a starting style. The first agent (the soon-to-be player) gets
    // the canonical default — "Neutral" for biped, otherwise the bundle's
    // first guidance — so the controlled character is in a known, stable
    // state. Subsequent NPC spawns randomize for crowd variety; the
    // autopilot brain re-rolls their style every 8–30s anyway.
    let style: string;
    const willBecomePlayer = playerId === null;
    if (kind === "biped") {
      if (willBecomePlayer) {
        style = defaultStyleFor(kind);
      } else {
        const styles = engine.styles.filter((s) => s !== "Idle");
        style = styles.length > 0
          ? styles[Math.floor(Math.random() * styles.length)]
          : engine.styles[0];
      }
    } else {
      style = defaultStyleFor(kind);
    }

    const agent = engine.createAgent({ position: pos, facing, style });

    const counter = kind === "biped"
      ? ++spawnCounters.biped : ++spawnCounters.quadruped;
    const id = `${kind}-${counter}`;
    const label = kind === "biped" ? `Biped #${counter}` : `Dog #${counter}`;

    // Autopilot brain by default — becomes the player only if nothing else is.
    const brain = makeBrain(kind, agent);

    const record: AgentRecord = { id, label, kind, agent, brain };
    agents.set(id, record);
    if (kind === "biped") addFighter(id, label, agent);

    // Refresh UI dropdown.
    const opts = rosterOptions();
    ui.rebuildSteerDropdown(opts, playerId ?? id);

    if (playerId === null) setPlayer(id);
  }

  function makeBrain(kind: ModelKind, agent: NMMAgent): Brain {
    const seed = ((Math.random() * 2 ** 31) | 0) >>> 0;
    if (kind === "biped") {
      const styles = (agent as unknown as { bundle: { meta: { guidances: string[] } } })
        .bundle?.meta?.guidances ?? bipedEngine.styles;
      return new BipedBrain({
        agent, seed,
        movementStyles: styles.filter((s) => s !== "Idle"),
        playfieldRadius: PLAYFIELD_RADIUS,
      });
    }
    const meta = quadrupedEngine.bundle.meta;
    if (!isQuadruped(meta)) throw new Error("quadruped engine has non-quadruped bundle");
    return new QuadrupedBrain({
      agent, seed,
      speeds: { ...meta.control.locomotion_modes },
      playfieldRadius: PLAYFIELD_RADIUS,
    });
  }

  function clearAll(): void {
    for (const r of agents.values()) {
      const engine = r.kind === "biped" ? bipedEngine : quadrupedEngine;
      engine.removeAgent(r.agent);
      combat.remove(r.id);
    }
    stopGauntlet();
    for (const b of bars.values()) b.remove();
    bars.clear();
    for (const d of dummies.values()) { scene.remove(d.mesh, d.trail.mesh); }
    dummies.clear();
    for (const it of items) scene.remove(it.mesh);
    items.length = 0;
    wounds.clear();
    agents.clear();
    setPlayer(null);
    ui.rebuildSteerDropdown([]);
  }

  function setPlayer(id: string | null): void {
    const prev = playerId ? agents.get(playerId) : null;
    const next = id ? agents.get(id) : null;
    if (prev && prev.id !== next?.id) prev.brain = makeBrain(prev.kind, prev.agent);
    if (next) next.brain = null;
    playerId = next?.id ?? null;
    attachHalfSword();

    // Retarget debug overlays to the new player's actor (or dispose if none).
    if (debug) { debug.dispose(); debug = null; }
    if (next) {
      debug = new Debug(scene, next.agent.actor);
      ui.linkDebug(debug);
    }

    // Update contact labels if kind changed.
    const newKind = next?.kind ?? null;
    if (newKind !== lastPlayerKind) {
      if (newKind) ui.rebuildContactsFolder(contactLabelsFor(newKind));
      else ui.rebuildContactsFolder(["c0", "c1", "c2", "c3"]);
      lastPlayerKind = newKind;
    }

    // Drives CSS that hides the right (facing) joystick when controlling a
    // quadruped, since it has no facing input.
    document.documentElement.classList.toggle("player-quadruped", newKind === "quadruped");

    // Rebuild the gait/style blade to suit the new player kind: dropdown for
    // biped, readonly text for quadruped (speed-driven), em-dash for none.
    const styles = next
      ? (next.kind === "biped" ? bipedEngine.styles : quadrupedEngine.styles)
      : [];
    ui.rebuildGaitControl(newKind, styles, next?.agent.style);

    ui.state.steer = playerId ?? "none";
    ui.state.steerKind = newKind;
    ui.pane.refresh();
  }

  function cyclePlayer(): void {
    const ids = Array.from(agents.values()).filter((r) => !r.dummy).map((r) => r.id);
    if (ids.length === 0) return;
    const cur = playerId ? ids.indexOf(playerId) : -1;
    const next = ids[(cur + 1) % ids.length];
    setPlayer(next);
  }

  // --- Half Sword --------------------------------------------------------
  const hudHint = document.getElementById("hs-hint");

  /** Player sword follows the current biped player; re-hook overrides. */
  function attachHalfSword(): void {
    grabber?.releaseAll(grabWorld);
    halfSword.reset();
    refreshOverrides();
    const me = playerId ? combat.fighters.get(playerId) : null;
    if (me) me.team = "player";
    grabber = me ? new GrabController(me, halfSword, bipedEngine.rig.boneNameToIndex) : null;
  }

  /** Per-biped pose override: hit-reaction flinch first (it moves the whole
   *  upper body), then the sword arms (IK reads the flinched chest). */
  function refreshOverrides(): void {
    for (const f of combat.fighters.values()) {
      const dummy = dummies.get(f.id);
      f.sword = dummy ? dummy.sword
        : f.id === playerId && halfSword.enabled ? halfSword : null;
      const sw = f.sword;
      f.agent.actor.poseOverride = (w) => { f.reactor.apply(w); sw?.apply(w); };
    }
  }

  function addFighter(id: string, label: string, agent: NMMAgent): Fighter {
    const f: Fighter = {
      id, label, agent, sword: null, health: 100, maxHealth: 100, downTime: 0, capsules: [],
      limbs: freshLimbs(), push: new THREE.Vector3(),
      reactor: new HitReactor(boneParents, bipedEngine.rig.boneNameToIndex),
    };
    combat.add(f);
    refreshOverrides();
    return f;
  }

  /** Spawn a sword-wielding sparring dummy in front of the player. */
  function spawnDummy(rank?: Rank, at?: Vec3): void {
    if (bipedEngine.agentCount >= MAX_AGENTS_PER_KIND) return;
    const player = playerId ? agents.get(playerId) : null;
    const base = player ? player.agent.getPosition() : [0, 0, 0];
    const dir = player ? hsHeading.clone() : new THREE.Vector3(0, 0, 1);
    const n = dummies.size;
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((n % 2 ? 1 : -1) * Math.ceil(n / 2) * 1.6);
    const pos: Vec3 = at ?? [base[0] + dir.x * 2.0 + side.x, 0, base[2] + dir.z * 2.0 + side.z];
    const face: Vec3 = [base[0] - pos[0], 0, base[2] - pos[2]];
    const fl = Math.hypot(face[0], face[2]) || 1;
    const agent = bipedEngine.createAgent({ position: pos, facing: [face[0] / fl, 0, face[2] / fl], style: "Neutral" });
    const id = `dummy-${++dummyCounter}`;
    const label = rank ? `${rank.name}` : `Dummy #${dummyCounter}`;
    agents.set(id, { id, label, kind: "biped", agent, brain: null, dummy: true });
    const sword = new HalfSword(bipedEngine.rig);
    const fighter = addFighter(id, label, agent);
    fighter.team = "enemy";
    if (rank) { fighter.health = fighter.maxHealth = rank.health; }
    const ai = new DummyAI(fighter, sword);
    // Gauntlet enemies get their rank's own settings; sparring dummies share
    // the panel's live settings.
    ai.settings = rank ? { ...rank.settings } : dummySettings;
    ai.grabber = new GrabController(fighter, sword, bipedEngine.rig.boneNameToIndex);
    ai.grabWorld = grabWorld;
    if (rank?.name === "Baron") fighter.damageScale = 1.2;
    const mesh = createSword();
    const trail = new BladeTrail(new THREE.Color(1.0, 0.88, 0.8));
    scene.add(mesh, trail.mesh);
    dummies.set(id, { id, ai, sword, mesh, trail });
    refreshOverrides();
  }

  /** Remove an enemy completely (gauntlet corpses, restarts). */
  function removeEnemy(id: string): void {
    const d = dummies.get(id);
    const f = combat.fighters.get(id);
    const r = agents.get(id);
    if (f) {
      if (f.sword?.armed) dropSword(f);
      d?.ai.grabber?.releaseAll(grabWorld);
      combat.releaseStuck(f);
      wounds.clear(() => f.agent.actor.worldMatrices);
      combat.remove(id);
    }
    if (r) bipedEngine.removeAgent(r.agent);
    if (d) scene.remove(d.mesh, d.trail.mesh);
    dummies.delete(id);
    agents.delete(id);
    removeAt.delete(id);
    bars.get(id)?.remove();
    bars.delete(id);
  }

  function clearEnemies(): void {
    for (const id of [...dummies.keys()]) removeEnemy(id);
    for (const it of items) scene.remove(it.mesh);
    items.length = 0;
  }

  function spawnWave(index: number): void {
    const wave = WAVES[index];
    const player = playerId ? agents.get(playerId) : null;
    const [px, , pz] = player ? player.agent.getPosition() : [0, 0, 0];
    director.maxAttackers = wave.maxAttackers;
    const n = wave.ranks.length;
    const baseYaw = Math.atan2(hsHeading.x, hsHeading.z);
    wave.ranks.forEach((ri, i) => {
      const yaw = baseYaw + (n === 1 ? 0 : (i - (n - 1) / 2) * 0.9);
      spawnDummy(RANKS[ri], [px + Math.sin(yaw) * 4.2, 0, pz + Math.cos(yaw) * 4.2]);
    });
    gauntlet.wave = index;
    gauntlet.phase = "fighting";
    const boss = wave.ranks.includes(RANKS.length - 1);
    banner(boss ? "THE BARON" : `WAVE ${index + 1}`);
    updateWaveLabel();
  }

  function startGauntlet(): void {
    if (!halfSword.enabled) setHalfSword(true);
    clearEnemies();
    const me = playerId ? combat.fighters.get(playerId) : null;
    if (me) { me.health = me.maxHealth; me.limbs = freshLimbs(); me.downTime = 0; me.dead = false; }
    if (!halfSword.armed && me) {
      // Start armed.
      const it = spawnLoose(halfSword.handPoint(halfSword.mainSide), new THREE.Quaternion());
      pickUp(me, it, halfSword.mainSide);
    }
    gauntlet.active = true;
    spawnWave(0);
  }

  function stopGauntlet(): void {
    gauntlet.active = false;
    gauntlet.phase = "idle";
    updateWaveLabel();
  }

  function updateWaveLabel(): void {
    const el = document.getElementById("wave-label");
    if (!el) return;
    el.textContent = gauntlet.active ? `Gauntlet · wave ${gauntlet.wave + 1} / ${WAVES.length}` : "";
  }

  /** Per-frame gauntlet rules: corpses stay down, waves advance. */
  function updateGauntlet(dt: number): void {
    const now = performance.now() / 1000;
    for (const [id, t] of removeAt) if (now > t) removeEnemy(id);
    if (!gauntlet.active) return;
    const me = playerId ? combat.fighters.get(playerId) : null;
    // Any enemy at 0 health is dead in the gauntlet (however it got there).
    for (const [id, d] of dummies) {
      const f = combat.fighters.get(id);
      if (!f || f.dead || f.health > 0) continue;
      f.dead = true;
      f.downTime = Math.max(f.downTime, 1);
      if (f.sword?.armed) dropSword(f);
      d.ai.grabber?.releaseAll(grabWorld);
      removeAt.set(id, performance.now() / 1000 + 6);
    }
    if (gauntlet.phase === "fighting") {
      if (me && me.downTime > 0) {
        gauntlet.phase = "dead";
        me.dead = true;
        banner("YOU DIED — press R to retry");
        return;
      }
      const alive = [...dummies.keys()].filter((id) => !combat.fighters.get(id)?.dead);
      if (alive.length === 0) {
        gauntlet.phase = gauntlet.wave >= WAVES.length - 1 ? "won" : "cleared";
        gauntlet.timer = 4;
        banner(gauntlet.phase === "won" ? "GAUNTLET COMPLETE — THE BARON FALLS" : `WAVE ${gauntlet.wave + 1} CLEARED`);
        if (me) { me.health = Math.min(me.maxHealth, me.health + 45); me.limbs = freshLimbs(); }
      }
    } else if (gauntlet.phase === "cleared") {
      gauntlet.timer -= dt;
      if (gauntlet.timer <= 0) spawnWave(gauntlet.wave + 1);
    }
  }

  /** Grabbed? Pull away (WASD) or shake the mouse to break the grip. */
  function updateStruggle(dt: number, mouseSpeed: number): void {
    const me = playerId ? combat.fighters.get(playerId) : null;
    const el = document.getElementById("grabbed-hint");
    if (!me || (me.grabbedBy ?? 0) <= 0) { struggle = 0; el?.classList.remove("show"); return; }
    const moving = ["w", "a", "s", "d"].some((k) => input.keys.has(k));
    struggle += dt * ((moving ? 1.4 : 0.35) + Math.min(mouseSpeed / 900, 1.6));
    el?.classList.add("show");
    if (el) (el.querySelector(".fill") as HTMLElement).style.width = `${Math.min(100, struggle / 1.3 * 100)}%`;
    if (struggle > 1.3) { me.breakFree = true; struggle = 0; }
  }

  function updateEnemyBars(): void {
    if (!barsEl) return;
    for (const [id, d] of dummies) {
      const f = combat.fighters.get(id);
      if (!f) continue;
      let el = bars.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "enemy-bar";
        el.innerHTML = `<div class="name"></div><div class="track"><div class="fill"></div></div>`;
        barsEl.appendChild(el);
        bars.set(id, el);
      }
      const head = new THREE.Vector3().setFromMatrixPosition(f.agent.actor.worldMatrices[bipedEngine.rig.boneNameToIndex.get("Head")!] ?? new THREE.Matrix4());
      const v = head.add(new THREE.Vector3(0, 0.38, 0)).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && !f.dead;
      el.style.display = visible ? "" : "none";
      if (!visible) continue;
      el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
      (el.querySelector(".fill") as HTMLElement).style.width = `${(f.health / f.maxHealth) * 100}%`;
      const tag = d.ai.orders.canAttack ? "⚔ " : "";
      (el.querySelector(".name") as HTMLElement).textContent = `${tag}${f.label}${d.ai.berserk ? " · BERSERK" : ""}${!d.sword.armed ? " · unarmed" : ""}`;
    }
  }

  // --- combat feedback -----------------------------------------------------
  const hud = {
    root: document.getElementById("combat-hud"),
    you: document.getElementById("hp-you"),
    foe: document.getElementById("hp-foe"),
    foeLabel: document.getElementById("hp-foe-label"),
    vignette: document.getElementById("hit-vignette"),
    banner: document.getElementById("combat-banner"),
    popups: document.getElementById("dmg-layer"),
  };
  let bannerTimer = 0;

  function popup(point: THREE.Vector3, text: string, cls: string): void {
    if (!hud.popups) return;
    const v = point.clone().project(camera);
    if (v.z > 1) return;
    const el = document.createElement("div");
    el.className = `dmg ${cls}`;
    el.textContent = text;
    el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    hud.popups.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  function banner(text: string): void {
    if (!hud.banner) return;
    hud.banner.textContent = text;
    hud.banner.classList.remove("show");
    void hud.banner.offsetWidth;   // restart the CSS animation
    hud.banner.classList.add("show");
    bannerTimer = 2;
  }

  const combatStats = { hits: 0, parries: 0, grazes: 0, flats: 0, stuck: 0, unstuck: 0, damageDealt: 0, damageTaken: 0 };
  function handleCombatEvents(events: CombatEvent[]): void {
    for (const e of events) {
      if (import.meta.env.DEV) {
        const log = ((window as unknown as { __events?: unknown[] }).__events ??= []);
        if (e.kind === "hit" || e.kind === "flat") log.push({ k: e.kind, by: e.attacker.id, speed: +e.speed.toFixed(2), dmg: e.damage,
          ch: e.kind === "hit" ? e.channel : "flat", edge: e.kind === "hit" ? +e.edge.toFixed(2) : undefined });
        else if (e.kind !== "graze") log.push({ k: e.kind });
        if (log.length > 30) log.shift();
      }
      if (e.kind === "hit") {
        combatStats.hits++;
        if (e.attacker.id === playerId) combatStats.damageDealt += e.damage;
        if (e.target.id === playerId) combatStats.damageTaken += e.damage;
      } else if (e.kind === "parry") combatStats.parries++;
      else if (e.kind === "graze") combatStats.grazes++;
      else if (e.kind === "flat") combatStats.flats++;
      else if (e.kind === "stuck") combatStats.stuck++;
      else if (e.kind === "unstuck") combatStats.unstuck++;
      if (e.kind === "hit") {
        const involvesPlayer = e.attacker.id === playerId || e.target.id === playerId;
        const bleeds = e.channel !== "blunt";
        if (bleeds) fx.impactAt(e.point, e.dir, e.speed);
        sfx.hit(bleeds ? e.speed : e.speed * 0.6, e.thrust);
        hitStop = Math.max(hitStop, 0.045 + e.damage * 0.0025);
        if (involvesPlayer) fx.shake(0.008 + e.damage * 0.0009);
        if (bleeds && gore.bloodRate > 0) {
          const T = e.target;
          const n = e.point.clone().sub(new THREE.Vector3().setFromMatrixPosition(T.agent.actor.worldMatrices[e.bone])).normalize();
          wounds.add(() => T.agent.actor.worldMatrices, e.bone, e.point, n, e.thrust ? 0.018 : 0.012 + Math.min(e.damage, 30) * 0.0008, e.dir);
          const m = heldMesh(e.attacker);
          if (m) setSwordBlood(m, (m.userData.blood as number) + 0.12 * gore.bloodRate);
        }
        const label = e.module === "fist" ? "PUNCH" : e.module === "hilt" ? "POMMEL" : e.thrust ? "THRUST" : e.zone === "head" ? "HEAD" : e.zone === "neck" ? "NECK" : "";
        popup(e.point, `${label ? label + " " : ""}${e.damage}`, e.target.id === playerId ? "taken" : e.zone === "head" || e.zone === "neck" ? "crit" : "");
        if (e.target.id === playerId && hud.vignette) {
          hud.vignette.classList.remove("flash");
          void hud.vignette.offsetWidth;
          hud.vignette.classList.add("flash");
        }
      } else if (e.kind === "parry") {
        const involvesPlayer = e.a.id === playerId || e.b.id === playerId;
        fx.sparksAt(e.point, e.normal, e.speed);
        sfx.clang(e.speed);
        hitStop = Math.max(hitStop, 0.03 + Math.min(e.speed, 8) * 0.004);
        if (involvesPlayer) fx.shake(0.006 + e.speed * 0.0015);
        if (e.speed > 3.5) popup(e.point, "PARRY", "parry");
      } else if (e.kind === "graze") {
        sfx.tap();
      } else if (e.kind === "flat") {
        // Flat of the blade: edge not aligned with the swing — blunt only.
        sfx.hit(e.speed * 0.5, false);
        popup(e.point, `FLAT ${e.damage}`, "flat");
        if (e.attacker.id === playerId || e.target.id === playerId) fx.shake(0.006);
      } else if (e.kind === "stuck") {
        sfx.hit(6, true); hitStop = Math.max(hitStop, 0.08);
        fx.impactAt(e.stuck.point, new THREE.Vector3(0, 0.3, 0), 3);
        popup(e.stuck.point, "STUCK — PULL IT OUT", "crit");
      } else if (e.kind === "unstuck") {
        fx.impactAt(e.stuck.point, new THREE.Vector3(0, 0.5, 0), e.torn ? 9 : 5);
        sfx.hit(e.torn ? 5 : 3, true);
        popup(e.stuck.point, e.torn ? "TORN FREE" : "PULLED FREE", e.torn ? "crit" : "parry");
      } else if (e.kind === "wrecked") {
        const names: Record<Region, string> = { head: "HEAD", neck: "NECK", body: "BODY", armL: "LEFT ARM", armR: "RIGHT ARM", legL: "LEFT LEG", legR: "RIGHT LEG" };
        banner(`${e.target.id === playerId ? "YOUR" : e.target.label.toUpperCase() + "'S"} ${names[e.region]} WRECKED`);
        fx.impactAt(e.point, new THREE.Vector3(0, 0.4, 0), 8);
        sfx.hit(7, false);
      } else if (e.kind === "parried") {
        popup(e.point, e.defender.id === playerId ? "PARRIED — RIPOSTE!" : "PARRIED", e.attacker.id === playerId ? "taken" : "parry");
      } else if (e.kind === "down" && gauntlet.active && e.target.team === "enemy") {
        e.target.dead = true;
        if (e.target.sword?.armed) dropSword(e.target);
        dummies.get(e.target.id)?.ai.grabber?.releaseAll(grabWorld);
        removeAt.set(e.target.id, performance.now() / 1000 + 6);
        banner(`${e.target.label.toUpperCase()} SLAIN`);
      } else if (e.kind === "down") {
        banner(e.target.id === playerId ? "YOU ARE DOWN" : `${e.target.label.toUpperCase()} DOWN`);
      }
    }
  }

  function updateHud(): void {
    if (!hud.root) return;
    const me = playerId ? combat.fighters.get(playerId) : null;
    if (hud.you) hud.you.style.width = `${me ? (me.health / me.maxHealth) * 100 : 0}%`;
    // Show the nearest dummy.
    let foe: Fighter | null = null, best = Infinity;
    const pp = me?.agent.getPosition();
    for (const d of dummies.values()) {
      const f = combat.fighters.get(d.id);
      if (!f) continue;
      const q = f.agent.getPosition();
      const dist = pp ? Math.hypot(q[0] - pp[0], q[2] - pp[2]) : 0;
      if (dist < best) { best = dist; foe = f; }
    }
    hud.root.classList.toggle("has-foe", foe !== null);
    if (foe && hud.foe) hud.foe.style.width = `${(foe.health / foe.maxHealth) * 100}%`;
    if (foe && hud.foeLabel) {
      const d = dummies.get(foe.id);
      const wrecked = foe.limbs ? (Object.entries(foe.limbs) as [Region, number][]).filter(([, v]) => v <= 0).map(([k]) => k) : [];
      const state = foe.downTime > 0 ? "down" : d ? d.ai.currentState : "";
      hud.foeLabel.textContent = `${foe.label} · ${state}${wrecked.length ? " · wrecked: " + wrecked.join(", ") : ""}${d && !d.sword.armed ? " · disarmed" : ""}`;
    }
  }

  function setHalfSword(on: boolean): void {
    halfSword.enabled = on;
    halfSwordInput.enabled = on;
    hsState.enabled = on;
    controls.enableZoom = !on;   // wheel = reach in Half Sword mode
    if (!on) halfSwordInput.release();
    document.documentElement.classList.toggle("half-sword", on);
    // The controls hint fades back after a few seconds (hover to read).
    hudHint?.classList.remove("dim");
    if (on) setTimeout(() => { if (halfSword.enabled) hudHint?.classList.add("dim"); }, 7000);
    if (on) {
      // Over-the-shoulder camera behind the fighter.
      const player = playerId ? agents.get(playerId) : null;
      if (player?.kind === "biped") {
        const [px, py, pz] = player.agent.getPosition();
        const f = new THREE.Vector3();
        camera.getWorldDirection(f).setY(0).normalize();
        hsHeading.copy(f);
        controls.target.set(px, py + 1.2, pz);
        // Over the right shoulder so the opponent isn't hidden behind you.
        const rx = -f.z, rz = f.x;   // character right = fwd × up
        camera.position.set(px - f.x * 2.9 + rx * 0.9, py + 1.95, pz - f.z * 2.9 + rz * 0.9);
        controls.update();
      }
    }
    if (!on) grabber?.releaseAll(grabWorld);
    attachHalfSword();
    if (on && items.length === 0) {
      // A couple of spare swords on the floor to pick up / fight over.
      const player = playerId ? agents.get(playerId) : null;
      const [px, , pz] = player ? player.agent.getPosition() : [0, 0, 0];
      const r = new THREE.Vector3(-hsHeading.z, 0, hsHeading.x);
      for (const sgn of [-1, 1]) {
        const p = new THREE.Vector3(px, 0.03, pz).addScaledVector(r, sgn * 1.4).addScaledVector(hsHeading, 0.6);
        const yaw = Math.random() * Math.PI * 2;
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
          new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)).cross(new THREE.Vector3(0, 1, 0)).normalize(),
          new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)),
          new THREE.Vector3(0, 1, 0)));
        const it = spawnLoose(p, q);
        it.cooldown = 0;
      }
    }
    // A wide, grounded stance suits fencing; restore the walk when leaving.
    const pl = playerId ? agents.get(playerId) : null;
    if (pl?.kind === "biped") pl.agent.setStyle(on ? "LegsApart" : "Neutral");
    if (on && dummies.size === 0) spawnDummy();
    ui.pane.refresh();
  }

  function updateHalfSword(dt: number): void {
    const controls_ = halfSwordInput.consume();
    updateStruggle(dt, Math.hypot(controls_.dx, controls_.dy) / Math.max(dt, 1e-3));
    const me = playerId ? combat.fighters.get(playerId) : null;
    if (me && me.downTime > 0) {
      controls_.leftHeld = controls_.rightHeld = controls_.thrust = false;
      controls_.dx = controls_.dy = 0;
      if (me.agent.style !== "HandsBetweenLegs") me.agent.setStyle("HandsBetweenLegs");
    } else if (me && halfSword.enabled && me.agent.style === "HandsBetweenLegs") {
      me.agent.setStyle("LegsApart");
    }
    const player = playerId ? agents.get(playerId) : null;
    if (!halfSword.enabled || player?.kind !== "biped") return;
    // Turning (Half Sword style): mouse with no button held while the
    // pointer is locked; Z / C on the keyboard. Q / E are the grab keys.
    const mouseTurn = halfSwordInput.locked && !controls_.leftHeld && !controls_.rightHeld ? controls_.dx * 0.0035 : 0;
    const turn = ((input.keys.has("c") ? 1 : 0) - (input.keys.has("z") ? 1 : 0)) * 1.8 * dt + mouseTurn;
    if (turn !== 0) {
      const yaw = -turn;
      hsHeading.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const off = camera.position.clone().sub(controls.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      camera.position.copy(controls.target).add(off);
      controls.update();
    }
    halfSword.halfGrip = hsState.halfGrip;
    // Wrecked arms hang limp; a wrecked sword arm drops the sword.
    if (me) {
      halfSword.disabled.Left = (me.limbs?.armL ?? 1) <= 0;
      halfSword.disabled.Right = (me.limbs?.armR ?? 1) <= 0;
      if (halfSword.armed && halfSword.disabled[halfSword.mainSide]) dropSword(me);
    }
    // Stunned (parried) or down: no hand control.
    if (me && ((me.stagger ?? 0) > 0)) { controls_.dx = controls_.dy = 0; }
    halfSword.update(dt, controls_);
    grabber?.update(dt, {
      grab: { Left: input.keys.has("q"), Right: input.keys.has("e") },
      aim: { Left: controls_.leftHeld, Right: controls_.rightHeld },
    }, grabWorld);
    if (hudHint) {
      const two = controls_.leftHeld && controls_.rightHeld;
      hudHint.dataset.grip = two ? (halfSword.halfGrip ? "half-sword" : "two-handed")
        : controls_.leftHeld || controls_.rightHeld ? "one hand" : "relaxed";
      const hand = (s: HandSide) => {
        const g = grabber?.status(s);
        if (g) return g;
        if (halfSword.disabled[s]) return "limp";
        if (halfSword.armed && halfSword.mainSide === s) return `sword (${hudHint.dataset.grip})`;
        if (halfSword.armed && halfSword.isTwoHanded) return "on the sword";
        return "free";
      };
      hudHint.querySelector(".grip")!.textContent = `L: ${hand("Left")}   ·   R: ${hand("Right")}`;
    }
  }

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"
      || t.tagName === "SELECT" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === "h") setHalfSword(!halfSword.enabled);
    else if (k === "r" && gauntlet.active && gauntlet.phase === "dead") startGauntlet();
    else if (halfSword.enabled && k === "x" && halfSword.armed) halfSword.swapHands();
    else if (halfSword.enabled && k === "f") {
      const me = playerId ? combat.fighters.get(playerId) : null;
      if (me && halfSword.armed) { dropSword(me); sfx.tap(); }
    }
    else if (halfSword.enabled && k === "g") { hsState.halfGrip = !hsState.halfGrip; ui.pane.refresh(); }
  });

  // --- Input routing ---------------------------------------------------
  const _camFwd = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _UP = new THREE.Vector3(0, 1, 0);
  function cameraBasis(): { fwd: Vec3; right: Vec3 } {
    camera.getWorldDirection(_camFwd);
    _camFwd.y = 0;
    if (_camFwd.lengthSq() < 1e-6) _camFwd.set(0, 0, 1);
    _camFwd.normalize();
    _camRight.crossVectors(_camFwd, _UP).normalize();
    return { fwd: [_camFwd.x, 0, _camFwd.z], right: [_camRight.x, 0, _camRight.z] };
  }

  function drivePlayer() {
    gamepad.poll();
    if (gamepad.consume(PAD.Y)) cyclePlayer();
    // Read facing once and mirror it onto the right joystick — so the
    // stick animates along with LMB-drag on the canvas, not just direct
    // touches. fz uses up-positive screen axis; flip back to screen-down
    // for the joystick's pixel-space visualization.
    const [fx, fz] = input.getFacingDelta();
    touch.visualizeRight(fx, -fz, input.facingMouseDown);

    const player = playerId ? agents.get(playerId) : null;
    if (!player) return;
    const [mx, mz] = input.getMovementVector();
    const { fwd, right } = cameraBasis();

    if (player.kind === "biped") {
      const meF = combat.fighters.get(player.id);
      const legWrecked = (meF?.limbs?.legL ?? 1) <= 0 || (meF?.limbs?.legR ?? 1) <= 0;
      const staggered = (meF?.stagger ?? 0) > 0 || (meF?.downTime ?? 0) > 0;
      const SPEED = (input.isSprint() ? 2.0 : 1.0) * (legWrecked ? 0.5 : 1) * (staggered ? 0 : 1);
      const rawVel: Vec3 = [
        (mz * fwd[0] + mx * right[0]) * SPEED, 0,
        (mz * fwd[2] + mx * right[2]) * SPEED,
      ];
      const vel = V.clampMagnitude(rawVel, Math.max(SPEED, 1e-6));
      if (meF?.push) { vel[0] += meF.push.x; vel[2] += meF.push.z; }
      const facing: Vec3 = halfSword.enabled
        // Half Sword: the fighter squares up to where the camera looks.
        ? [hsHeading.x, 0, hsHeading.z]
        : [fz * fwd[0] + fx * right[0], 0, fz * fwd[2] + fx * right[2]];
      player.agent.setGoal(vel, facing);
      const prevStyle = input.consumeStylePrev(), nextStyle = input.consumeStyleNext();
      if (!halfSword.enabled) {
        if (prevStyle) cycleStyle(player, -1);
        if (nextStyle) cycleStyle(player, +1);
      }
    } else {
      const moveLen = Math.hypot(mx, mz);
      const moveDir: Vec3 = moveLen > 1e-5
        ? [(mz * fwd[0] + mx * right[0]) / moveLen, 0, (mz * fwd[2] + mx * right[2]) / moveLen]
        : [0, 0, 0];
      const targetSpeed = moveLen < 0.05 ? 0 : LOCOMOTION_SPEED[input.getQuadrupedGait()];
      const vel: Vec3 = [moveDir[0] * targetSpeed, 0, moveDir[2] * targetSpeed];
      player.agent.setGoal(vel, moveDir);
      player.agent.setAction(input.getQuadrupedAction());
    }
  }

  function cycleStyle(player: AgentRecord, delta: number) {
    const engine = player.kind === "biped" ? bipedEngine : quadrupedEngine;
    const styles = engine.styles.slice().sort();
    if (styles.length === 0) return;
    const cur = styles.indexOf(player.agent.style);
    const idx = ((cur + delta) % styles.length + styles.length) % styles.length;
    player.agent.setStyle(styles[idx]);
  }

  // Default scene: one biped (auto-promoted to player by setPlayer inside
  // spawn) plus one quadruped wandering on autopilot. Mobile users tap
  // "Switch Character" to flip control between them; desktop has Tab + the
  // Steer dropdown.
  spawn("biped");
  spawn("quadruped");

  // Dev-only handle for automated screenshots / console poking.
  if (import.meta.env.DEV) {
    (window as unknown as { __vibezzz: unknown }).__vibezzz = {
      camera, controls, agents, get playerId() { return playerId; },
      combat, combatStats, dummies, items, get grabber() { return grabber; }, halfSword, hsHeading, dropSword, gauntlet, startGauntlet, director,
    };
  }

  // --- Main loop --------------------------------------------------------
  hideBoot();
  const timer = new THREE.Timer();
  timer.connect(document);
  let totalTime = 0;
  let lastPaneRefresh = -1;
  let lastReadbackBiped = 0, lastReadbackQuad = 0;
  let lastTsResolve = 0;
  const PANE_REFRESH_DT = 1 / 15;

  function loop() {
    timer.update();
    const realDt = Math.min(timer.getDelta(), 0.1);
    // Hit-stop: a few frames of near-frozen simulation sell the impact.
    if (hitStop > 0) hitStop -= realDt;
    const dt = hitStop > 0 ? realDt * 0.06 : realDt;
    totalTime += dt;

    // Autopilot brains drive non-player agents; WASD drives the player.
    for (const r of agents.values()) {
      if (r.brain) r.brain.update(dt, totalTime);
    }
    drivePlayer();
    updateHalfSword(dt);
    const me = playerId ? combat.fighters.get(playerId) ?? null : null;
    combat.playerId = playerId;
    combat.playerDamageRate = gore.playerDamage;
    combat.npcDamageRate = gore.enemyDamage;
    fx.bloodRate = gore.bloodRate;
    director.update(dt, [...dummies.values()].map((d) => ({
      id: d.id, ai: d.ai,
      position: () => agents.get(d.id)!.agent.getPosition(),
      alive: () => { const f = combat.fighters.get(d.id); return !!f && !f.dead && f.downTime <= 0; },
    })), me ? me.agent.getPosition() : null);
    for (const d of dummies.values()) d.ai.update(dt, me, dummyWorld);
    updateGauntlet(dt);
    for (const it of items) { it.step(dt); it.sync(); }
    for (const f of combat.fighters.values()) f.reactor.update(dt);

    bipedEngine.update(dt);
    quadrupedEngine.update(dt);
    handleCombatEvents(combat.step(dt));

    fx.removeShake(camera);
    cameraFollow();
    fx.addShake(camera, realDt);
    fx.update(realDt);

    // Sword meshes + trails follow the simulated grips.
    const g = new THREE.Vector3(), tp = new THREE.Vector3();
    const showSword = (mesh: THREE.Group, hs: HalfSword, trail: BladeTrail, key: string) => {
      mesh.visible = hs.enabled && hs.swordVisible;
      if (!mesh.visible) { trail.push(g, tp, 0, false, realDt); return; }
      mesh.position.copy(hs.swordPosition);
      mesh.quaternion.copy(hs.swordQuaternion);
      hs.bladeSegment(g, tp);
      const speed = hs.tipVelocity().length();
      trail.push(g, tp, speed, true, realDt);
      sfx.whoosh(key, speed);
    };
    showSword(sword, halfSword, playerTrail, "player");
    for (const d of dummies.values()) showSword(d.mesh, d.sword, d.trail, d.id);
    wounds.mesh.visible = gore.bloodRate > 0;
    wounds.update();
    updateEnemyBars();
    updateHud();
    if (bannerTimer > 0) bannerTimer -= realDt;
    renderer.render(scene, camera);
    ui.tickStats();

    // Infer latency — take whichever engine just finished.
    if (bipedEngine.lastReadbackMs !== lastReadbackBiped) {
      lastReadbackBiped = bipedEngine.lastReadbackMs;
      ui.tickInference(bipedEngine.lastComputeMs + bipedEngine.lastReadbackMs);
    }
    if (quadrupedEngine.lastReadbackMs !== lastReadbackQuad) {
      lastReadbackQuad = quadrupedEngine.lastReadbackMs;
      ui.tickInference(quadrupedEngine.lastComputeMs + quadrupedEngine.lastReadbackMs);
    }

    // Debug overlays follow the player.
    const player = playerId ? agents.get(playerId) : null;
    if (debug && player) {
      const d = player.agent.debugState;
      debug.updateSimulation(d.simulation);
      debug.updateRootControl(d.rootControl);
      if (d.current) debug.updateCurSeq(d.current);
      if (d.previous) debug.updatePrevSeq(d.previous);
      debug.updateGuidance(d.guidance);

      if (!ui.isTouch && totalTime - lastPaneRefresh >= PANE_REFRESH_DT) {
        lastPaneRefresh = totalTime;
        ui.state.timescale = d.timescale;
        ui.state.synchronization = d.synchronization;
        ui.state.blend = d.blend;
        ui.state.prevT = Math.min(Math.max(d.prevT, 0), 0.5);
        ui.state.curT = Math.min(Math.max(d.curT, 0), 0.5);
        ui.state.gaitState = d.guidanceState;
        // Mirror the agent's user-picked style into the dropdown — keeps the
        // panel in sync if Q/E cycled it. Quadruped doesn't bind to this.
        ui.state.playerStyle = player.agent.style;
        const vel = player.agent.getVelocity();
        ui.state.speed = Math.hypot(vel[0], vel[2]);
        for (let i = 0; i < 4; i++) ui.state.contacts[i] = d.contacts[i];
        ui.pane.refresh();
      }
    }

    if (totalTime - lastTsResolve > 1.0) {
      lastTsResolve = totalTime;
      renderer.resolveTimestampsAsync("render").catch(() => {});
      renderer.resolveTimestampsAsync("compute").catch(() => {});
    }
    requestAnimationFrame(loop);
  }
  loop();
}

boot().catch((err) => {
  console.error(err);
  setBoot(`error: ${err instanceof Error ? err.message : String(err)}`);
});
