# Ground-hold stability

## Responsible mechanism

At zero handle compliance, the old mechanism represented a rigid tool as a light
carrier, a light carriage, three shaft bodies and a head, connected in series by a
hinge, a prismatic joint and four rigid welds. Its position-to-speed controller
observed the guides, not the residual movement along that chain. A planted
oblique head couples rotation, extension and ground support; the finite iterative
solve could leave the tool moving even when the guide motor reached its requested
speed. This created a sustained loaded oscillation, contact loss and a trembling
root. The shoulder-relative cursor followed that root; its input offsets did not
change. The dead zone was not the origin.

A bounded 16-second, zero-input 45-degree ground hold reproduced this with strong
motors and high response gains on a rigid handle with little extension. At the normal 64 velocity
iterations, the final eight seconds spanned 0.03224 m in root height, with hinge
load varying by 1489.37 N m and head contact present 84.2% of the time. There were
no collision time-of-impact events; disabling continuous physics gave identical
results. Diagnostic-only 1024 iterations or 100-fold guide inertia eliminated
the oscillation. Neither intervention is shipped. A lower terrain friction, 0.8
instead of 3, also reproduced it (0.02599 m height range).

## Engine ownership and invariants

- `HammerJoint` is the Planck 1.4.2 adapter for a coupled polar drive between the
  fixed-rotation root and the actual driven tool. A fixed three-row active-set
  solve enforces lateral geometry, bounded angular/axial motor impulses and
  unilateral predictive stops together. Saturation re-solves the remaining rows;
  clipping a free solution would violate the other constraints. Motor effort
  excludes passive stop impulse. Position projection never imposes an aim angle.
- `PlayerTool` owns physical tool construction, mass/COM/inertia and the head and
  butt anchors. At zero compliance, carriage, shaft and head share one compound
  body. Positive compliance keeps four rotational spring welds. Changing between
  those topologies rebuilds and restarts the player; positive-to-positive tuning
  stays in place.
- The old carrier's translational mass and COM contribution belong to the root;
  its rotor inertia belongs to the driven tool. Component masses, uniform shaft
  distribution and parallel-axis inertia are preserved, not artificially raised.
- Physical-body ownership is distinct from visual-part projection. Launches,
  velocity changes, mass inspection and destruction visit each real body once.
  Rendering and recordings use actual head/butt points; impacts use head point
  velocity, not a compound body's COM velocity.
- Contact identity is a fixture. Terrain's inside-outline probe is that fixture's
  own centroid, cached locally for its immutable geometry and transformed at
  contact time. A compound COM or non-colliding shaft cannot disable its head.
- A shoulder marker supplies the render anchor. Aim and dead-zone semantics,
  motor gains/caps, downswing boosts, input and authored settings formats remain
  unchanged. No cursor freezing, readout smoothing or contact-aware assistance
  force hides the oscillation.

## Targeted measurements and limits

With the new rigid mechanism, the same trace at the original **64
velocity / 20 position iterations** spans **3.46e-9 m** in root height over its
final eight seconds. Hinge torque standard deviation falls from **413.45 to
0.04914 N m**; axial force standard deviation from **179.23 to 0.02273 N**. Head
contact is continuous. Total player/tool mass remains **26.68 kg**; the rig uses
three rather than eight dynamic bodies, and two rather than seven joints.

The same targeted trace also exercised a head resting outside rock while its
non-colliding shaft and compound COM were inside, and a positive-frequency
compliant handle. These are headless physics measurements, not browser visual
review or proof over all settings, terrain and input sequences. No full
verification suite, build, deployment or representative-large-level scenario was
run as part of this investigation.

Reproduce only with approval for this runtime check:

```bash
node --max-old-space-size=512 scripts/trace-ground-hold.mjs \
  --project /path/to/project.json --output /path/to/trace.json
# --scenario overlap checks compound-fixture contact identity; --scenario air
# isolates loading. --iterations 1024 is diagnostic only, never a runtime fix.
```

The diagnostic is finite (3840 steps), creates no HTTP listener and does not write
project content. Trace files contain the supplied tuning and physics state; save
them outside authored project folders.

## Capacity review

Growth axes are concurrent game instances and active effects within an instance.
Each instance owns its `Simulation` and `World`; a fixed physics step is the
single-threaded mutation boundary. There is no shared service, global lock,
provider or fleet-wide accounting added. The drive performs at most 15 small
active-set candidates per velocity iteration; matrix storage and rig work are
constant and independent of total level population. Fixture probes retain local
centroids in a weak cache, not a second geometry authority. Existing catch-up
admission (`maxFrameSteps`) and fixed iteration budgets are unchanged. Capacity
is added by independent game instances; no cross-instance migration is introduced.
This is a source-reviewed capacity boundary, not a measured throughput claim.
