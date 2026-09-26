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

## Half Sword mode

Press **H** (or tick **Half Sword → enabled**) to fight Half Sword-style. The network keeps doing the footwork, and your mouse takes over the hands:

| Input | Effect |
| --- | --- |
| Hold **RMB** + move mouse | Right hand (sword hand) follows the mouse |
| Hold **LMB** + move mouse | Left hand follows the mouse |
| Hold **both** | Two-handed grip: the off hand closes on the handle, and the blade is steadier and faster to steer |
| **G** while two-handed | Half-sword grip: the off hand moves to the middle of the blade and the blade levels forward along the thrust line |
| **Space** | Thrust: drive the point straight out along the centreline |
| **Wheel** | Reach in / out |
| **X** | Swap the sword to the other hand |
| **Q / E** | Turn. The fighter keeps its own heading, so orbiting the camera with MMB doesn't turn it |
| **WASD** | Step and move |

**Where your hands go decides the cut.** The blade points from a pivot low in your torso out through your hands, and it leans into the direction the hands are moving:

- Hands high: the blade chambers above your head.
- Hands high to one side: a diagonal chamber.
- Hands low and forward: the point is on line.

Sweep from high-right to low-left for a diagonal, from low to high for a rising cut, or across for a horizontal. Hold Space to thrust. Taking hold of the sword brings it up to a middle guard.

The sword is simulated, not animated (`src/runtime/half_sword.ts`):

- The grip chases the hand target through a damped spring, so the weapon lags and carries momentum.
- The tip is a Verlet particle held at blade length, pulled by gravity and a wrist spring toward the guard. Fast hand movement whips the blade through a cut.
- **Arms without contortion** (fixed in v6, from four separate causes):
  - The arm now rotates about the mesh's real shoulder joint. The network's upper-arm joint sits about 7 cm inside Geno's torso, so the converter records the realistic body's actual pivot (`meshPivot`), and `src/runtime/arm_pivots.ts` rotates every arm about it each frame.
  - The two-bone IK searches elbow swivel × grip roll for the least forearm twist and wrist bend. It keeps the elbow below the shoulder, outside the torso, and stable from frame to frame, and the elbow only flexes about its real hinge.
  - The forearm twist helper is re-derived after the IK moves the arm; before, it kept a stale pose, which was the "tentacle" forearm.
  - The shoulder blade lifts and moves forward with high and cross-body reaches.
- **Skinning** is dual-quaternion for the realistic human (linear blend skinning for Geno), which keeps volume through elbow, shoulder and wrist rotation.
- The gripping hand rotates to follow the blade, and the fingers curl into a fist around the handle.
- An idle sword hand sags back to a low guard.

### Combat and the sparring dummy

Turning Half Sword mode on also spawns a **sparring dummy** in front of you. You can add more with **Half Sword → Sparring dummy → Spawn dummy**. The dummy uses the same simulated sword as you, so its cuts carry the same momentum. It follows a simple cycle:

- keeps its distance and circles you
- winds up and strikes with eight attacks: diagonal cuts from either side, overhead, rising cuts from either side, horizontal, a thrust, and a half-sword thrust
- strings cuts into combos (each cut flows into a natural follow-up) and sometimes feints (it shows one cut, then throws another)
- reads a fast incoming blade and puts its sword in the way
- staggers back when hit
- goes down when its health runs out, then recovers

You can tune its aggression, block skill and hit power, or turn "fights back" off to get a passive target.

**Collision** (`src/runtime/combat.ts`):

- Each biped has capsules for the head, neck, torso, arms and legs, rebuilt every frame from the pose sent to the GPU.
- Blades are tested against other blades and against bodies. The tests sweep from the previous frame, so a fast cut can't pass through. The blade stops where it bit, then bounces or deflects.
- Blade-on-blade contact exchanges momentum, which gives you parries and binds.
- Damage depends on the blade's speed at the contact point and where it hit: head > neck > torso > legs > arms. Tip-first contacts moving along the blade count as thrusts.
- A hit target flinches: a spring bends the spine and neck away from the blow, then wobbles back.

**Feedback:**

- hit-stop (a brief near-freeze) on impact, and camera shake when you're involved
- spark streaks and a flash on parries; droplets that splash and stay on the floor on body hits
- faint trails on fast swings, measured in time rather than frames
- damage numbers (HEAD / NECK / THRUST), health bars, a red vignette when you're hit, a "down" banner
- synthesized sound (Web Audio): steel clang, body impact, swing whoosh

Body language comes from the network's styles: a wide `LegsApart` fencing stance, a `DragLeftLeg` limp when badly hurt, and `HandsBetweenLegs` when down.

The pointer is locked while you hold a button (**Esc** releases it). Add `?nolock` to the URL to keep the cursor free.

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

## Version badge

The number in the top middle of the page (for example `v6`) is `buildNumber` in `package.json`. Vite injects it at build time, so bump it with each release.

## Tools

- `tools/build-human.mjs` builds the human asset (see above).
- `tools/preview/preview.html` is served by the dev server. It shows the converted rig next to Geno with test poses: `?pose=1`, `?cross=1.4`, `?shrug=-0.4`, `?twist=1.6&driven=1`, and `?solo=1`.
- `tools/preview/arms.html` and `tools/preview/arms_gpu.html` are an arm-pose test bench. They run the real Half Sword arm code on a grid of 15 hand targets and grips. `arms_gpu.html` renders through the game's own skinning shader: `?dqs=0|1`, `?view=front|side|frontR|frontL`, `?cases=…`, `?zoom=…`, `?debug=1` (prints wrist twist).
- `tools/preview/shot.mjs` and `tools/preview/walk.mjs` take headless screenshots. `walk.mjs` drives the real app over WebGPU on SwiftShader.

## Attribution & license

This is a derivative work of AI4AnimationPy through ai4anim-webgpu. [`NOTICE`](./NOTICE) has the full attribution and third-party asset credits, and [`LICENSE`](./LICENSE) has the terms (CC BY-NC 4.0, non-commercial use only). This project is not affiliated with or endorsed by Meta, Epic Games, NVIDIA, or the original authors.
