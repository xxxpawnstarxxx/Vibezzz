# Vibezzz

Neural motion-matching characters in the browser (three.js + WebGPU), with a realistic, textured human driven by the same network and rig as the original mannequin.

Vibezzz starts from [ai4anim-webgpu](https://github.com/sweriko/ai4anim-webgpu), a WebGPU port of the biped + quadruped demos from [AI4AnimationPy](https://github.com/facebookresearch/ai4animationpy). It adds pieces from the other projects in this workspace:

| From | What Vibezzz uses |
| --- | --- |
| **ai4anim-webgpu** | The base: batched WebGPU inference, instanced skinning, autopilot crowds, studio scene |
| **vibe-human** | The human body mesh, skin textures, and the layered TSL skin / eye shading |
| **OpenRigLogic** | RigLogic's twist/swing joint behaviour, ported as driven corrective joints |
| **GR00T-WholeBodyControl** | Gamepad teleop in the style of a velocity command (left stick moves, right stick sets facing) |
| **human-atlas** | Tap vs. drag handling, used to select a character by tapping it |

## The realistic human

`public/assets/human.glb` is vibe-human's Rigify character re-skinned onto Geno's skeleton. The joint names, hierarchy, rest pose and inverse bind matrices all match `geno.glb`, so the biped network animates it with no retargeting at runtime. `tools/build-human.mjs` produces it:

1. **Conform**: scale the human to Geno's height. Then FK-rotate the limbs from the human's T-pose into Geno's A-pose, rotating about the human's own joints. Finally, move elbows, wrists, knees, ankles and fingers onto Geno's pivots with a smooth offset along each bone.
2. **Re-skin**: map the `DEF-*` weights to Geno joints. The torso is spread by height over Geno's five spine joints. Split vertices are welded, and weights are diffused over the surface. Diffusion is strongest around the shoulders and neck, where Geno's pivots sit well inside the torso.
3. **Twist helper**: forearm weights fade onto Geno's otherwise unused `*ArmEnd` joints. The runtime drives those joints with part of the hand's twist.
4. **Pack**: body, head and eye primitives, with embedded WebP albedo, normal and roughness maps (2.9 MB). Extra skin detail maps are written to `public/textures/human/`.

At runtime the engine merges the three primitives into one geometry with groups. All agents still draw as a single instanced mesh, with one draw call per material. `src/render/skin.ts` builds the skin as a `MeshSSSNodeMaterial` with these layers:

- tiled micro-pore normals on top of the sculpted normal map, faded out at grazing angles
- a subdermal "blood" tint that drives translucency
- an oily clearcoat film and a faint sheen

The eyes use a glossy clearcoat material. An HDR environment adds image-based fill light.

To rebuild the human, keep vibe-human checked out next to this repo and run:

```bash
npm run build:human     # node tools/build-human.mjs ../vibe-human
```

## Driven joints

The network predicts 23 joints. Every other joint normally rides rigidly on its parent. `src/runtime/driven_joints.ts` evaluates RigLogic-style behaviours after the pose is computed:

- **twist**: splits the hand's roll relative to the forearm into a swing and a twist, and applies part of the twist to a forearm helper joint, which stops the wrist from candy-wrapping
- **follow**: moves `Neck1` halfway toward the head, so the neck bends over two joints instead of one crease

## Run

```bash
npm install
npm run dev
```

You need a browser with WebGPU. Add `?character=geno` to the URL to switch back to the mannequin, or use the **Biped** picker in the panel.

### Controls

| | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move | WASD | Left stick |
| Facing (biped) | LMB drag | Right stick |
| Sprint | Shift | RT |
| Style (biped) | Q / E | LB / RB |
| Dog gait | Alt walk · Ctrl trot · Shift canter | LT walk · RT canter |
| Dog sit / stand / lie | R / T / V | A / B / X |
| Switch character | Tab, or tap a character | Y |
| Orbit camera | MMB drag | — |

The **Look** panel adjusts exposure, environment light, and the skin settings: pores, detail normal, oiliness, roughness and subsurface.

## Tools

- `tools/build-human.mjs` builds the human asset (see above).
- `tools/preview/preview.html` is served by the dev server. It shows the converted rig next to Geno with test poses: `?pose=1`, `?cross=1.4`, `?shrug=-0.4`, `?twist=1.6&driven=1`, and `?solo=1`.
- `tools/preview/shot.mjs` and `tools/preview/walk.mjs` take headless screenshots. `walk.mjs` drives the real app over WebGPU on SwiftShader.

## Attribution & license

This is a derivative work of AI4AnimationPy through ai4anim-webgpu. [`NOTICE`](./NOTICE) has the full attribution and third-party asset credits, and [`LICENSE`](./LICENSE) has the terms (CC BY-NC 4.0, non-commercial use only). This project is not affiliated with or endorsed by Meta, Epic Games, NVIDIA, or the original authors.
