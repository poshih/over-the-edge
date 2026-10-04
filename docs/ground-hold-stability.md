# Ground-hold stability

A hammer planted at an angle couples the shoulder hinge's rotation, the slider's
extension and the ground's support. This note explains how the player's drive and
tool keep such a hold still, and the invariants that changes to them must keep.

## Why the drive is coupled

A rigid tool was once a chain: a light carrier on the shoulder hinge, a light
carriage on the slider, three shaft bodies and the head, joined in series by a
hinge, a prismatic joint and four rigid welds. The motors drove those light guide
bodies, and the position-to-speed controller watched them, not the movement left
along the chain. Planck's finite iterative solve could leave the tool moving after
the guide motors reached their requested speeds. With strong motors and high
response gains, a hammer held at 45 degrees with no input then oscillated under
load, lost contact with the ground and shook the root; the cursor, which follows
the root, shook with it. Far more solver iterations or much heavier guide bodies
removed the oscillation in diagnostics; the engine uses neither.

The coupled drive below holds the same pose still to within nanometres, with the
head in continuous contact, at the normal 64 velocity and 20 position iterations.
A rigid player has three dynamic bodies and two joints instead of eight and seven,
with the same total mass.

## Mechanism and invariants

- `HammerJoint` (`src/hammer-joint.ts`) is the Planck 1.4.2 adapter for a coupled
  polar drive between the fixed-rotation root and the driven tool itself. One
  three-row active-set solve enforces the lateral geometry, the bounded angular and
  axial motor impulses and the unilateral, predictive slide stops together. A
  saturated row re-solves the others; clipping a free solution would break the
  other constraints. Motor effort excludes passive stop impulse. Position
  projection never imposes an aim angle.
- `PlayerTool` (`src/player-tool.ts`) owns the tool's construction, its mass,
  centre of mass and inertia, and its head and butt anchors. At zero handle
  compliance the carriage, the shaft and the head share one compound body;
  positive compliance joins a carriage, three shaft segments and the head with four
  rotational spring welds. Switching between the two rebuilds and restarts the
  player; retuning a compliant handle stays in place.
- The hinge component's translational mass and centre-of-mass contribution belong
  to the root, and its rotor inertia to the driven tool. Component masses, the
  shaft's even mass distribution and parallel-axis inertia are kept, never raised
  to stabilize the solve.
- Physical bodies are distinct from the visual parts drawn for them. Launches,
  velocity changes, mass inspection and destruction visit each real body once.
  Rendering and recordings use the actual head and butt points, and impacts use
  the head point's velocity, not a compound body's centre-of-mass velocity.
- A contact belongs to a fixture. Terrain's inside-outline probe uses that
  fixture's own centroid, cached locally for its immutable geometry and transformed
  when the contact is made, so neither a compound centre of mass nor a
  non-colliding shaft inside rock can disable the head.
- A shoulder marker supplies the render anchor for the hinge. Nothing hides
  motion: there is no cursor freezing, readout smoothing or contact-aware
  assistance force.

## Performance

Each game instance owns its `Simulation` and `World`, and the fixed physics step is
the only point that mutates them. Per velocity iteration the drive tries at most 15
small active-set candidates, with constant storage, so its cost does not depend on
the level. Terrain probes keep fixture centroids in a weak cache rather than a
second copy of the geometry. The catch-up limit (`maxFrameSteps`) and the fixed
solver iteration counts are unchanged by the drive.
