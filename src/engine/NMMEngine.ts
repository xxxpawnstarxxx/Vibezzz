/** NMMEngine — top-level neural motion-matching runtime.
 *
 *  One engine owns:
 *    - The model bundle (weights + metadata)
 *    - A batched WebGPU inference pipeline sized for `maxAgents`
 *    - A single shared instanced SkinnedMesh that renders every active
 *      agent in one draw call (see `SharedSkinnedMesh.ts`)
 *    - A shared StorageBuffer holding per-instance bone matrices
 *    - A fleet of `NMMAgent`s — up to `maxAgents` of them
 *
 *  Scene integration:
 *    scene.add(engine.mesh);        // add the shared mesh once
 *    engine.createAgent({ position, facing, style });  // allocate a slot
 *
 *  Per frame the game calls `engine.update(dt)`. This:
 *    1. Advances every agent's control series (cheap).
 *    2. If the prediction cadence has elapsed, packs every active agent's
 *       input into the batched xRaw buffer and dispatches one batched
 *       inference (non-blocking). When it completes, each agent receives
 *       its output slice.
 *    3. Advances every agent's animation (sample/blend/FK/IK) and writes
 *       its bone matrices into its slice of the shared storage buffer.
 *
 *  The inference dispatch is non-blocking: `update()` returns synchronously
 *  every frame.
 */

import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Bundle } from "../model/bundle.js";
import type { ModelKind } from "../model/bundle.js";
import { Inference } from "../inference/Inference.js";
import type { WeightPrecision } from "../inference/Inference.js";
import { NMMAgent } from "./NMMAgent.js";
import type { NMMAgentOptions } from "./NMMAgent.js";
import { createSharedSkinnedRig } from "./SharedSkinnedMesh.js";
import type { SharedSkinnedRig, RigMaterialFactory } from "./SharedSkinnedMesh.js";

export interface NMMEngineOptions {
  renderer: WebGPURenderer;
  /** Path where `<kind>.json` + `<kind>.bin` live (trailing slash optional). */
  bundleBaseUrl: string;
  /** URL of a GLB whose SkinnedMesh provides the shared rig (geometry,
   *  materials, skeleton, bind matrices). Multi-primitive meshes (e.g. body /
   *  head / eyes with separate materials) are merged into one grouped
   *  geometry so every agent still renders in a single instanced mesh. */
  characterGlbUrl: string;
  /** Optional per-material shading override (see `RigMaterialFactory`). */
  materialFactory?: RigMaterialFactory;
  /** Maximum simultaneous characters. Storage buffers are sized for this. */
  maxAgents: number;
  /** Which bundle to load. Default `biped`. */
  bundleKind?: ModelKind;
  /** Override denoiser iterations (default: from bundle meta). */
  iterations?: number;
  /** Weight precision. fp16 halves the bundle + ~1.5-2× matmul. Default fp16. */
  precision?: WeightPrecision;
}

export class NMMEngine {
  readonly renderer: WebGPURenderer;
  readonly bundle: Bundle;
  readonly inference: Inference;
  readonly maxAgents: number;
  readonly rig: SharedSkinnedRig;

  private readonly agents: NMMAgent[] = [];
  private readonly slots: (NMMAgent | null)[];

  private totalTime = 0;
  private lastPredictTime = -1;
  private predictionPending = false;

  // Last measured latencies (ms).
  lastComputeMs = 0;
  lastReadbackMs = 0;
  lastPredictBatchSize = 0;

  static async load(opts: NMMEngineOptions): Promise<NMMEngine> {
    const base = opts.bundleBaseUrl.endsWith("/")
      ? opts.bundleBaseUrl : opts.bundleBaseUrl + "/";
    const [bundle, templateMesh] = await Promise.all([
      Bundle.load(base, opts.bundleKind ?? "biped"),
      loadTemplateSkinnedMesh(opts.characterGlbUrl),
    ]);

    // Build the shared instanced rig from the template GLB.
    // `parent_names` is only present on bundles whose skeleton includes leaf
    // markers the GLB doesn't ship (currently just the quadruped dog).
    const parentNames = (bundle.meta.skeleton as unknown as { parent_names?: (string | null)[] })
      .parent_names;
    const rig = createSharedSkinnedRig(
      templateMesh, opts.maxAgents, bundle.meta.skeleton.bone_names, parentNames,
      opts.materialFactory,
    );

    const inference = await Inference.create(bundle, opts.renderer, {
      maxAgents: opts.maxAgents,
      iterations: opts.iterations,
      precision: opts.precision,
    });
    return new NMMEngine(opts.renderer, bundle, inference, rig, opts.maxAgents);
  }

  private constructor(
    renderer: WebGPURenderer, bundle: Bundle,
    inference: Inference, rig: SharedSkinnedRig, maxAgents: number,
  ) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.inference = inference;
    this.rig = rig;
    this.maxAgents = maxAgents;
    this.slots = new Array<NMMAgent | null>(maxAgents).fill(null);
  }

  /** The single instanced SkinnedMesh — add to your scene once. */
  get mesh(): THREE.SkinnedMesh { return this.rig.mesh; }

  /** The styles (guidance names) recognised by `NMMAgent.setStyle`. */
  get styles(): readonly string[] { return this.bundle.meta.guidances; }

  get agentCount(): number { return this.agents.length; }

  /** Create + register an agent. Allocates the next free slot on the
   *  shared rig. Throws if maxAgents is exhausted. */
  createAgent(opts: Omit<NMMAgentOptions, "skinnedMeshOverride">): NMMAgent {
    const slot = this.slots.indexOf(null);
    if (slot < 0) {
      throw new Error(`NMMEngine: maxAgents (${this.maxAgents}) exhausted`);
    }
    const agent = new NMMAgent(this.bundle, this.rig, opts);
    agent.slot = slot;
    this.slots[slot] = agent;
    this.agents.push(agent);
    // Grow the mesh's instance count as agents come online.
    (this.rig.mesh as unknown as { count: number }).count = this.agents.length;
    return agent;
  }

  /** Unregister an agent and free its slot. */
  removeAgent(agent: NMMAgent): void {
    const i = this.agents.indexOf(agent);
    if (i < 0) return;
    this.agents.splice(i, 1);
    if (agent.slot >= 0) this.slots[agent.slot] = null;
    agent.slot = -1;
    (this.rig.mesh as unknown as { count: number }).count = this.agents.length;
  }

  /** One frame. Call on the animation loop before rendering. */
  update(dt: number): void {
    this.totalTime += dt;

    for (const a of this.agents) a.updateControl(dt);

    const predictionDt = 1 / this.bundle.meta.control.prediction_fps;
    const timeSinceLast = this.lastPredictTime < 0
      ? Number.POSITIVE_INFINITY : this.totalTime - this.lastPredictTime;
    if (!this.predictionPending && this.agents.length > 0 && timeSinceLast >= predictionDt) {
      this.lastPredictTime = this.totalTime;
      void this.runBatchedInference();
    }

    for (const a of this.agents) {
      a.animate(dt, this.totalTime);
      a.writeBoneMatricesToRig(this.rig.boneMatricesArray);
    }
    // Mark the shared bone buffer as dirty so the WebGPU backend re-uploads.
    this.rig.boneMatricesAttr.needsUpdate = true;
  }

  private async runBatchedInference(): Promise<void> {
    this.predictionPending = true;
    try {
      const xRaw = this.inference.xRawArray;
      const inStride = this.inference.inputStride;
      for (const a of this.agents) a.writeInputTo(xRaw, inStride);

      this.lastPredictBatchSize = this.agents.length;
      // Only compute for the currently-active slots — kernels early-return for
      // the rest via Three's dispatch-count machinery.
      const { output, computeMs, readbackMs } = await this.inference.run(this.agents.length);
      this.lastComputeMs = computeMs;
      this.lastReadbackMs = readbackMs;

      const stride = this.inference.outputStride;
      for (const a of this.agents) {
        const s = a.slot * stride;
        a.onPrediction(output.subarray(s, s + stride), this.totalTime);
      }
    } finally {
      this.predictionPending = false;
    }
  }

  dispose(): void {
    this.agents.length = 0;
    this.slots.fill(null);
  }
}

/** Load a GLB and return its SkinnedMesh. When the character is split into
 *  several skinned primitives sharing one skeleton (GLTFLoader emits one
 *  SkinnedMesh per primitive), they're merged into a single geometry with
 *  one group per source material. */
async function loadTemplateSkinnedMesh(url: string): Promise<THREE.SkinnedMesh> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const parts: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((obj) => {
    const sm = obj as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && (parts.length === 0 || sm.skeleton === parts[0].skeleton)) {
      parts.push(sm);
    }
  });
  if (parts.length === 0) {
    throw new Error(`NMMEngine: no SkinnedMesh in ${url}`);
  }
  let skinnedMesh = parts[0];
  if (parts.length > 1) {
    const geometry = mergeGeometries(parts.map((p) => p.geometry), true);
    if (!geometry) {
      throw new Error(`NMMEngine: skinned primitives in ${url} have mismatched attributes`);
    }
    const merged = new THREE.SkinnedMesh(
      geometry, parts.map((p) => p.material as THREE.Material));
    merged.name = parts[0].parent?.name || parts[0].name;
    // Stand in for the first part in the scene graph so the rig can still
    // walk up to the template root, then bind with the shared skeleton.
    parts[0].parent!.add(merged);
    for (const p of parts) p.removeFromParent();
    merged.bind(parts[0].skeleton, parts[0].bindMatrix);
    skinnedMesh = merged;
  }
  // Ensure the template's skeleton world matrices reflect its bind pose —
  // the Actor / rig snapshot rely on this at construction time.
  skinnedMesh.updateMatrixWorld(true);
  return skinnedMesh;
}
