# Over the Edge

An original browser-based physics climbing playground, inspired by the
two-motor mechanism described by Getting Over It's creator. The first version
has a small climb, dedicated practice positions, procedural 3D artwork, and a
live tuning workshop. It is not a port of the original game's assets or code.

## Run

Requires Node.js 22.12 or newer and a modern browser with WebGL2.

```sh
git clone https://github.com/poshih/over-the-edge.git
cd over-the-edge
npm ci
npm run dev
```

Open **http://localhost:5181**. The port is fixed; Vite fails explicitly if it is
occupied. Mouse/keyboard and one-finger touch controls are supported.

```sh
npm run build
npm run preview
```

The preview uses **http://localhost:4174**. Deploy `dist/` to any static host,
including Cloudflare Pages. There is no backend, account, external asset
download, or runtime network service.

The included `wrangler.toml` is an optional Cloudflare Workers configuration.
Use your own Cloudflare account and configure any custom domains there.

## Controls

| Input | Action |
| --- | --- |
| Play, or click the game canvas with a mouse | Capture the mouse |
| Play on a touchscreen | Resume touch controls without mouse capture |
| Move the captured mouse | Rotate and extend the hammer |
| Hold and drag on the canvas | Move the hammer without pointer capture |
| Lift and reposition a finger | Continue a relative touch drag without snapping the hammer |
| Esc | Release the mouse |
| R | Restart the current practice position |
| P or Space | Pause / resume |
| D | Toggle actual collision outlines and joint anchors |
| C | Recenter the camera |
| 1 / 2 / 3 / 4 | Ascent / ledge hold / ground push / vault |

Touch gain is independent of camera zoom and orientation: at the default
**Control sensitivity**, 200 CSS pixels correspond to the 2.65 m maximum reach
before reach clamping. The same swipe has the same effect in portrait and
landscape. Mouse input continues to follow the displayed scene scale. Touch
cancellation, focus loss and resizing clear pending gestures.

Compact viewports use wider reach-aware framing to keep the player and hammer
visible. On phones, the Workshop is a bottom sheet in portrait and a side panel
in landscape, with a visible game preview. Opening it pauses physics; closing
it restores the previous pause state. Play closes the compact editor and resumes.
Regular desktop Workshop use remains live.

Touch-sized controls include `+` and `-` buttons for exact single-step adjustments
to physics and appearance ranges. They respect limits and disabled settings.

Press the head against the ground and extend to raise the pot. Swing around an
edge to hook it; the contact and the two motors do the lifting. Practice buttons
explicitly reposition the mechanism and restart the attempt, rather than
introducing hidden checkpoints into the climb.

## Physics architecture

Runtime dependencies are **Planck.js** and **Three.js**. Development uses
**TypeScript** and **Vite**. Planck 1.4.2 is pinned for its Node 22-compatible
package contract and its Box2D-style joint API.

```text
Dynamic root, rotation locked
  +-- limited unpowered hinge --> pot
  +-- powered hinge --> invisible carrier
          +-- powered slider --> handle base
                  +-- three welded handle segments --> hammer head
```

There are eight dynamic bodies and seven joints. Only the hinge and slider have
motors. Arms are visual two-bone IK, never collision bodies or actuators. The pot
and hammer head collide with terrain; the shaft fixtures supply mass and
inertia but never generate contacts. Normal locomotion does not teleport bodies,
apply assistance forces, or turn off the head's collisions.

The simulation runs at a fixed **240 Hz**, with continuous collision handling,
64 velocity iterations and 20 position iterations. Time steps and solver
iterations are distinct. Rendering interpolates the previous and current
physics poses. Catch-up is bounded under overload; switching tabs discards
elapsed wall-clock time rather than advancing a huge physics step.

Mouse motion updates a virtual world-space cursor. Camera translation never
feeds back into that cursor. The cursor is limited to the head's actual maximum
reach, 2.65 m from the hinge. The slider can retract the head all the way to the
hinge, so there is no unreachable inner ring. The hinge's own orientation defines
aim even at zero reach; aiming does not normalize a zero-length hinge-to-head vector.

Free-space drag targets remain fixed until further mouse input or reach
clamping. Only a head touching terrain uses low-input-speed cursor settling,
preventing blocked targets from continuously driving the mechanism. The head
still cannot pass through solid terrain.

Motor velocity targets come from angular and axial errors with measured joint
velocity damping, speed caps, and independent force/torque limits. All angular
quantities use radians. Collision visualization uses the authored physics
geometry and fixture filters, so it does not draw the non-colliding shaft as a
terrain collider.

## Tuning

The workshop applies parameters to the existing mechanism without restarting.
Its first section, **Mass & recoil**, groups head mass, player mass and rotation
speed with sliders for total shaft mass, hinge carrier mass and slider carriage
mass. Shaft mass is divided equally among the three handle segments; guide-body
inertia scales with mass. The new defaults preserve the original 0.66 kg shaft
and 0.5 kg per guide body. All masses stay positive.

The other sections include motor strength and speed limits, response gains, damping,
contact friction, handle compliance, mouse sensitivity, and cursor settling.
Zero handle frequency means rigid weld constraints; positive frequency enables
rotational spring compliance.

Ground and every obstacle share a **3.0** rough-rock friction coefficient.
The hammer defaults to **2.5**. Planck mixes the two as `sqrt(3.0 * 2.5)`,
giving a contact coefficient of about **2.74**. This is ordinary contact
friction, not a sticky constraint: the head must still press against a surface
to hold. The pot's own friction coefficient remains **0.45**.

In **Workshop / Physics / Saved tuning**, enter a **Tuning name** and choose
**Save tuning** (or press Enter). Each save creates a separate timestamped
snapshot of every Workshop physics setting. Reusing a name keeps both versions
rather than overwriting the earlier experiment. Choose an entry in **Past tuning**,
then **Load tuning** to apply it. Selecting an entry alone does not change the
game. History survives reloads; loading remains manual.

Snapshots are stored independently in this browser's localStorage, on this site,
so saves from different tabs do not overwrite one shared record. Nothing is
uploaded. The previous single-slot v2 save appears as **Previous saved tuning
(v2)**. If v2 is absent, a v1 save is available instead, with its original fixed
tool masses supplied when loaded. Loading never rewrites either old record;
saving the loaded settings under a name creates a new v3 snapshot. An invalid
v2 record never causes v1 to be loaded instead. Unreadable saves are marked and
retained, while other valid snapshots remain available.

These are tuning presets, not saved body trajectories. Height and peak readouts
describe the current attempt.

Saved profiles preserve their stored hammer friction. Use **Defaults** to
return to the rough hammer preset.

The practice positions make the important behaviors easy to revisit: resting
on a ledge, smooth ground pushes, launches, and vaulting a low block. The
controller and artwork are a prototype, not a claim of matching the original
game's exact tuning.

## Custom visuals

Open **Workshop / Appearance**, choose a **Body part**, and select a **GLB model**.
Parts can be replaced independently: pot, torso/neck, character head, each upper
arm, forearm, elbow and hand, the full hammer shaft, and the hammer head. Parts
without an import keep their procedural visual. Invisible physics guide bodies
do not need models.

Imports are **cosmetic only**. They attach to the existing physics and visual-IK
anchors; they do not replace colliders, change mass, or create new rigid bodies.
Use the collision overlay to compare the visual with the actual contact shape.
Collider authoring and whole-character animation retargeting are not included.

### Arm IK direction

In **Workshop / Appearance / Arm IK direction**, adjust **Left elbow direction**
and **Right elbow direction** independently. Each angle swivels that elbow's
bend plane around the shoulder-to-hand line: **0** preserves the original pose,
**+/-90** turns it in depth, and **+/-180** reverses the bend. The **Flip left
elbow** and **Flip right elbow** buttons make a half-turn immediately.

The preview works with both procedural arms and imported arm parts. Hands keep
their existing hammer grip points; these controls do not alter physics, reach,
colliders, mass, or motor tuning. A fully extended arm has no sideways elbow
bend to rotate.

**Save arm IK** stores both directions on this device and restores them on
reload. **Reset arm IK** previews the original directions; save afterward to
keep the reset. Arm directions use a separate localStorage record, leaving
model files, model alignment, and named physics presets unchanged. Invalid
saved settings are reported and retained rather than silently rewritten.

### Model files

Use a self-contained **binary glTF 2.0 (`.glb`)** with embedded textures:

- Maximum file size: 20 MiB; maximum 128 meshes and 250,000 triangles per part.
- PNG, JPEG, WebP or AVIF textures, at most 4096 pixels on either edge.
- Export without Draco/Meshopt geometry or KTX2 texture compression.
- External resource URLs/files are rejected. Imported lights, cameras, line
  helpers and animations are not applied.

Each model is uniformly fitted to the original visual's bounds. **Visual
scale**, rotation in degrees, and local offsets preview immediately.
**Save alignment** preserves those adjustments; **Reset fit** previews the
original fit. **Use default** removes only the selected part's saved replacement.
For arm pieces, length should run along local Y; the shaft runs along local X.
Use the rotation controls if the export uses a different orientation.

A custom shaft is drawn as one straight mesh spanning the physical handle's
endpoints. The underlying three-segment shaft and its mass/compliance remain in
the physics simulation.

Files are saved locally in IndexedDB when imported, and saved appearances restore
on reload. Nothing is uploaded to the server. This storage belongs to the current
browser and site address; it is separate from physics presets and is not bundled
into `dist/` or shared with other players. Original files on your computer are
never modified.

## Runtime inspection

```sh
npm run verify
```

This builds the app and exercises browser gameplay with Playwright. If Chromium
is not installed for Playwright, install it with `npx playwright install chromium`
and rerun. Runtime artifacts are written to the ignored `artifacts/` directory.
There is no unit-test suite.

The browser exposes the read-only `window.gettingOver.snapshot()` and
`window.gettingOver.project({ x, y })` diagnostics for observing actual physics,
motor effort, camera state, and world-to-screen coordinates. They do not expose
commands that bypass the game's input or motor mechanism.
`window.gettingOver.appearance()` reports imported parts, saved/draft alignment,
loading errors, current rendering anchors and world transforms, and the arm IK
settings and save state.

## Contributing

Issues and pull requests are welcome. Include steps to reproduce gameplay
problems, and run `npm run verify` before submitting code changes.

## License

The project source and included procedural artwork are available under the
[MIT License](LICENSE). Dependencies retain their own licenses. Models imported
through the Workshop are not included in this repository and retain their
original licenses.

This is an independent project, not affiliated with or endorsed by the creators
of Getting Over It.
