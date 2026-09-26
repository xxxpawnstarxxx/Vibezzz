/** Realistic skin / eye shading for the textured human character.
 *
 *  Ported from vibe-human's layered TSL skin material and adapted to the
 *  shared instanced rig: `human.glb` carries the base maps (albedo, normal,
 *  roughness) per material, and a few runtime-only detail maps add
 *
 *    - tiled micro-pore normals layered over the sculpted normal map,
 *      faded toward grazing angles to keep silhouettes clean,
 *    - subdermal "blood" tint driving a MeshSSSNodeMaterial translucency term
 *      (ears, nose and fingers glow when back-lit),
 *    - a specular/oil film (clearcoat) and a faint sheen for peach fuzz.
 *
 *  The rig assigns the instanced-skinning positionNode afterwards; everything
 *  here only sets up shading.
 */

import * as THREE from "three";
import { MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import * as TSL from "three/tsl";
import type { RigMaterialFactory } from "../engine/index.js";

// TSL's .d.ts types are weaker than its runtime node chaining (see
// SharedSkinnedMesh.ts) — use a permissive handle for the node helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = TSL as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface SkinSettings {
  /** UV tiling of the micro-pore normal map. */
  poreScale: number;
  poreStrength: number;
  /** Strength of the sculpted (wrinkle / muscle) normal map. */
  detailStrength: number;
  oiliness: number;
  roughness: number;
  subsurface: number;
}

export const DEFAULT_SKIN: SkinSettings = {
  poreScale: 30,
  poreStrength: 0.8,
  detailStrength: 1.0,
  oiliness: 0.1,
  roughness: 0.66,
  subsurface: 0.7,
};

/** Live-tweakable uniforms shared by every skin material instance. */
export interface SkinUniforms {
  poreStrength: { value: number };
  detailStrength: { value: number };
  oiliness: { value: number };
  roughness: { value: number };
  subsurface: { value: number };
}

interface DetailMaps {
  pores: THREE.Texture;
  headSubdermal: THREE.Texture;
  bodySubdermal: THREE.Texture;
  headSss: THREE.Texture;
  headSpecular: THREE.Texture;
}

async function loadDetailMaps(base: string): Promise<DetailMaps> {
  const loader = new THREE.TextureLoader();
  const load = async (file: string, repeat = false) => {
    const tex = await loader.loadAsync(`${base}${file}`);
    tex.colorSpace = /subdermal/.test(file) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.flipY = false; // glTF UV convention, same as the GLB's own maps
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  };
  const [pores, headSubdermal, bodySubdermal, headSss, headSpecular] = await Promise.all([
    load("pores.webp", true),
    load("head_subdermal.webp"),
    load("body_subdermal.webp"),
    load("head_sss.webp"),
    load("head_specular.webp"),
  ]);
  return { pores, headSubdermal, bodySubdermal, headSss, headSpecular };
}

/** Load the detail maps and return a rig material factory for `human.glb`
 *  (materials `Skin_Head`, `Skin_Body`, `Eyes`) plus its live uniforms. */
export async function createHumanMaterialFactory(
  textureBase = "/textures/human/",
  settings: SkinSettings = DEFAULT_SKIN,
): Promise<{ factory: RigMaterialFactory; uniforms: SkinUniforms }> {
  const maps = await loadDetailMaps(textureBase);
  const uniforms: SkinUniforms = {
    poreStrength: T.uniform(settings.poreStrength),
    detailStrength: T.uniform(settings.detailStrength),
    oiliness: T.uniform(settings.oiliness),
    roughness: T.uniform(settings.roughness),
    subsurface: T.uniform(settings.subsurface),
  };

  const factory: RigMaterialFactory = (source) => {
    const src = source as THREE.MeshStandardMaterial;
    if (/eye/i.test(src.name)) return eyeMaterial(src);
    const isHead = /head/i.test(src.name);
    return skinMaterial(src, {
      subdermal: isHead ? maps.headSubdermal : maps.bodySubdermal,
      pores: maps.pores,
      sss: isHead ? maps.headSss : null,
      specular: isHead ? maps.headSpecular : null,
      poreScale: settings.poreScale,
      name: isHead ? "Skin_Head" : "Skin_Body",
    }, uniforms);
  };
  return { factory, uniforms };
}

interface SkinMaps {
  subdermal: THREE.Texture;
  pores: THREE.Texture;
  sss: THREE.Texture | null;
  specular: THREE.Texture | null;
  poreScale: number;
  name: string;
}

function skinMaterial(src: THREE.MeshStandardMaterial, m: SkinMaps, uniforms: SkinUniforms): MeshStandardNodeMaterial {
  const u = uniforms as unknown as Record<keyof SkinUniforms, Node>;
  const baseUv: Node = T.uv();
  const one = T.float(1.0);

  const albedo: Node = src.map ? T.texture(src.map, baseUv).rgb : T.vec3(0.72, 0.5, 0.4);
  const subdermal: Node = T.texture(m.subdermal, baseUv).rgb;
  const specular: Node = m.specular ? T.texture(m.specular, baseUv).r : T.float(0.35);
  const bloodTint: Node = subdermal.mul(T.vec3(1.18, 0.46, 0.34));

  // Layered tangent-space normal: sculpted detail + tiled micro pores.
  const neutral: Node = T.vec3(0.5, 0.5, 1.0);
  const detailTex: Node = src.normalMap
    ? T.mix(neutral, T.texture(src.normalMap, baseUv).rgb, u.detailStrength)
    : neutral;
  const poreTex: Node = T.mix(neutral, T.texture(m.pores, baseUv.mul(m.poreScale)).rgb, u.poreStrength);
  const detailN: Node = detailTex.mul(2.0).sub(1.0);
  const poreN: Node = poreTex.mul(2.0).sub(1.0);
  const layered: Node = T.normalize(T.vec3(
    detailN.xy.mul(0.88).add(poreN.xy.mul(0.6)),
    detailN.z.mul(poreN.z).add(0.2),
  )).mul(0.5).add(0.5);

  // Fade the normal map toward neutral at grazing angles — avoids sparkly
  // silhouettes on a moving character.
  const NdotV: Node = T.clamp(T.dot(T.normalView, T.positionViewDirection), 0.0, 1.0);
  const grazing: Node = T.smoothstep(0.0, 0.65, NdotV);
  const fadedN: Node = T.mix(neutral, layered, grazing);
  const fadedPores: Node = T.mix(neutral, poreTex, grazing);

  // Subtle rim scatter toward the blood tint.
  const rim: Node = T.pow(one.sub(NdotV), 2.25);
  const scatter: Node = T.smoothstep(0.05, 0.9, rim).mul(u.subsurface);
  const color: Node = T.mix(albedo, bloodTint, scatter.mul(0.12));

  // Roughness: authored map (head) or constant, pulled down by oily areas.
  const roughTex: Node = src.roughnessMap ? T.texture(src.roughnessMap, baseUv).g : T.float(0.62);
  const roughness: Node = T.clamp(
    roughTex.mul(0.58).add(u.roughness.mul(0.48)).sub(specular.mul(u.oiliness.mul(0.06).add(0.035))),
    0.42, 0.92);

  const thickness: Node = m.sss ? T.smoothstep(0.3, 0.9, T.texture(m.sss, baseUv).r) : T.float(0.35);

  const mat = new MeshSSSNodeMaterial();
  const mx = mat as unknown as Record<string, unknown>;
  mat.name = `TSL_${m.name}`;
  mx.colorNode = color;
  mx.normalNode = T.normalMap(fadedN);
  mx.roughnessNode = roughness;
  mx.specularIntensityNode = T.clamp(specular.mul(0.32).add(u.oiliness.mul(0.08).add(0.16)), 0.12, 0.42);
  mx.specularColorNode = T.mix(T.vec3(0.96, 0.72, 0.58), T.vec3(0.99, 0.9, 0.84), T.clamp(specular.mul(0.9), 0.0, 1.0));
  mx.clearcoatNode = T.clamp(specular.mul(0.12).add(u.oiliness.mul(0.18)), 0.0, 0.16);
  mx.clearcoatRoughnessNode = T.clamp(roughness.mul(0.7).add(u.oiliness.oneMinus().mul(0.08).add(0.12)), 0.36, 0.72);
  mx.clearcoatNormalNode = T.normalMap(fadedPores, T.vec2(0.24, 0.24));
  mx.sheenNode = T.vec3(1.0, 0.5, 0.4).mul(u.subsurface.mul(0.03).add(0.008));
  mx.sheenRoughnessNode = T.float(0.96);
  // Translucency (MeshSSSNodeMaterial): thin areas pass tinted light through.
  mx.thicknessColorNode = bloodTint.mul(thickness.mul(0.28));
  mx.thicknessDistortionNode = T.float(0.08);
  mx.thicknessAmbientNode = T.float(0.0);
  mx.thicknessAttenuationNode = T.float(0.1);
  mx.thicknessPowerNode = T.float(2.8);
  mx.thicknessScaleNode = u.subsurface.mul(2.4);

  mat.metalness = 0;
  mat.ior = 1.4;
  mat.sheen = 0.02;
  mat.clearcoat = 0.02;
  return mat as unknown as MeshStandardNodeMaterial;
}

function eyeMaterial(src: THREE.MeshStandardMaterial): MeshStandardNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial();
  const mx = mat as unknown as Record<string, unknown>;
  mat.name = "TSL_Eye";
  if (src.map) mx.colorNode = T.texture(src.map, T.uv()).rgb;
  mx.roughnessNode = T.float(0.03);
  mx.clearcoatNode = T.float(1.0);
  mx.clearcoatRoughnessNode = T.float(0.02);
  mat.metalness = 0;
  mat.ior = 1.376;
  mat.specularIntensity = 1.0;
  mat.clearcoat = 1.0;
  mat.envMapIntensity = 1.6;
  return mat as unknown as MeshStandardNodeMaterial;
}
