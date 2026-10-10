# Feature request: giant crow boss

**Date:** 2026-10-10 · **Baseline:** `1164f66` · **Status:** Proposed; not implemented. Builds on
[FEATURE-REQUEST-camera-zones.md](FEATURE-REQUEST-camera-zones.md), which should land first.

The engine's enemies (`src/enemy-types.ts`, `src/enemy-world.ts`) are a bird, a hollow soldier and a hollow archer,
none taller than 1.4 m. Each has one body with one collider, one armor speed and at most one attack. Nothing in the
engine supports a boss yet. No enemy has parts that take different damage, a fight with stages, a health readout of its
own, or a defeat that lasts through bonfires. Nothing pushes the player steadily either: updrafts launch once.

**In short:** add a fourth species, the **crow**: a boss about 3 m tall with a 7 m wingspan that guards an **arena**.
Its bare **head** takes full hammer damage. Its plated body, wings and talons take a fifth of that and need a harder
swing. It has three attacks: a **feather fan**, a **claw dive** and a **gust** of wing beats that pushes the player.
Each attack is marked on screen while it winds up, even when the crow is off screen, and each has a counter. At half
health the crow enrages. A boss bar shows its name and health during the fight, and once defeated it stays down for
the run. The engine pieces are generic and documented: enemy hit parts, attack moments and marks, a wind force, a boss
HUD slot, and a tactics slot that chooses the crow's attacks.

## Design choices

| Choice | Why | Instead of |
| --- | --- | --- |
| A species in the enemy system | Reuses wake and sleep, hits, poses, looks, models, health, moments and editor placement | A separate boss kind and world that duplicates all of them |
| Plated parts need a harder strike *and* let a fifth of the damage through | Gives the lower damage asked for, and every plated hit sparks and clanks, so the player learns where to aim at the first hit | A damage share alone, where taps on the plates would wear the crow down silently |
| A tactics slot chooses each attack, and the engine carries it out | A game can rewrite the fight's pattern while the engine keeps flight, hits, damage and the fairness rules | A fixed pattern, or a plugin that moves the crow itself |
| The default tactics follow a rule, not chance | A fight the player can learn and plan for | Random rolls |
| An effect draws the telegraph marks | They read without sound, with the built-in sprite, and from off screen, and a game can restyle them without redrawing the crow | Telegraphs that depend on a model's animation |
| Wind as the same acceleration on every player body | Pushes the rig as a whole whatever its tuned mass, and a hammer hooked on terrain holds through the rig's joints | A force on the pot alone, which would tear the pot from the hammer |
| Every attack has a counter: block, parry or brace | The player is tested on the climbing controls they already have | Attacks that can only be dodged |

## The fight

### Arena

The crow waits at its **roost**, the position it is placed at. Its **arena** is a rectangle reaching `left`, `right`,
`below` and `above` metres from the roost, 16–60 m wide and 10–40 m tall.

- The fight **starts** when the pot's root enters the arena. The crow calls (1.4 s), the boss bar appears and the
  attacks begin.
- The fight **stops** when the root is more than 2 m outside the arena, for example after a fall. The crow flies
  back to its roost and keeps the damage it has taken, so a fall does not also undo progress.
- The crow can be hurt only during a fight, so it cannot be worn down from outside its arena.
- The crow never leaves its arena. Every point it flies to is clamped inside, inset by its own half-size, and gravity
  never pulls it.
- No two crows' arenas may overlap, and no bonfire may stand inside one. So a rest never happens mid-fight, and a
  respawn never lands the player in one.
- A bounded [camera zone](FEATURE-REQUEST-camera-zones.md) over the arena gives the player room to see the fight.
  The Workshop's **Frame arena** makes one (Stage 4).

### Lifecycle

| Event | The crow | Its feathers and gust | Boss bar | `RunRecord.defeated` |
| --- | --- | --- | --- | --- |
| The pot's root enters the arena | Calls, then attacks | | Shows | |
| The root is more than 2 m outside the arena | Flies to its roost and keeps its damage | Removed and stopped | Hides | |
| The player's death begins | Flies to its roost | Removed and stopped | Hides | |
| A respawn, or a rest at a bonfire | At its roost, at full health | None | Hidden | Kept |
| Defeat | Plays its death clip, then is gone for the run | Removed and stopped | Hides after the death clip | Gains its ID |
| A new run: a restart or Reset | At its roost, at full health | None | Hidden | Cleared |
| A saved run resumed | Absent if defeated, otherwise at its roost at full health | None | Hidden | Restored |
| A Workshop edit to the crow | At its roost, at full health, not defeated | Removed and stopped | Hides | Loses its ID |

### Weak point and plates

Today a strike counts when the hammer head closes faster than the species' armor speed, and it deals `hammerDamage`
scaled by closing speed up to `hammerFullSpeed` (`onBeginContact` and `resolveHit` in `src/enemy-world.ts`). The crow
has **parts**, each with its own fixture. Offsets are in metres from its centre, facing right:

| Part | Air stance | Ground stance | Plated | Collides with terrain |
| --- | --- | --- | --- | --- |
| Head | circle r 0.45 at (1.65, 0.2) | circle r 0.45 at (1.55, −0.25) | no | yes |
| Body | box 2.4 × 1.4 at (0, 0) | box 2.2 × 1.8 at (0, 0.2) | yes | yes |
| Wings | box 7 × 0.6 at (−0.4, 1.1), above the body | folded: no part | yes | no, so a wingtip cannot snag a ledge |
| Talons | circle r 0.35 at (0.3, −1.05) | circle r 0.35 at (0.2, −1.05) | yes | yes |

- The **air stance** is for flight, hovering and attacking. The wings sit above the head and shield it from blows from
  above. The **ground stance** is for landing after a dive and for staggering. The head is then 0.7–1.6 m above the
  ground, where a player standing in front of it can reach.
- A bare part needs `crowArmor` and takes full damage. A plated part needs `crowPlateArmor` and takes
  `crowPlateDamage` of it, at least 1 hit point. A strike slower than a part's armor glances off, as now.
- At 1,200 hit points (`crowHealth`), about 12 full-speed head strikes win the fight. Plated strikes alone would take 60.
- **Flinch and stagger.** A head strike makes the crow flinch (0.25 s), which interrupts a telegraph. A head strike at
  `hammerFullSpeed` or faster **staggers** it. It drops straight down onto the first terrain below it in its arena
  (one ray cast), or staggers in the air where it is if there is none, and lies stunned for 3 s in the ground stance.
  It cannot be staggered again until it has finished another attack. Plated strikes never interrupt it.
- Turning or changing stance swaps the body's fixtures for the mirrored or other set. That happens a few times per
  attack, never every frame. A swap waits until the new parts' bounds are clear of terrain and of the player.

### Attacks

| Attack | Telegraph | Strike | Dodge | Counter | Punish |
| --- | --- | --- | --- | --- | --- |
| **Feather fan** | 0.9 s: hovers 10 m to the side of the pot and 5 m above, and rears back, feathers bristling. Its aim is fixed as the telegraph starts, and marks show the fan's lanes | `featherCount` (5) feathers across `featherSpread` (60°), flying straight along the marked lanes at `featherSpeed` (11 m/s). A volley hurts at most once: `featherDamage` (10) and the usual projectile push | Step into a gap. At the full hover distance the lanes are about 2.9 m apart, and the player's hurt box, about 1.9 m across them, fits between two with a metre to spare. Or take cover behind terrain | The hammer head blocks feathers, as it blocks arrows | None: the crow is out of reach |
| **Claw dive** | 1.0 s: climbs to 6 m above the pot and 3 m to its side, and screeches with its talons out. As the telegraph starts, a ring marks the point it will dive through | A straight dive at `crowDiveSpeed` (15 m/s) through the ring. If the talons touch the pot or the player's hurt box, they deal `clawDamage` (30) and knock the player `clawPush` (8 m/s) along the dive and `clawLift` (3 m/s) up, at most once per dive | Leave the ring | Meet the talons with the hammer head to **parry**: the dive ends there and the crow lands. The player takes no damage, only half of `clawPush` | It lands facing along its dive, grounded for 2.2 s with its head low |
| **Gust** | 1.1 s: level with the pot and 7 m to its side, it raises its wings as dust streams toward it | Three wing beats over 2.4 s. Wind pushes the player away horizontally, each beat peaking at `gustAcceleration` (14 m/s²). The strength holds out to half of `gustReach` (16 m), then falls linearly to a third at its end, up to 6 m above or below the crow's centre. It deals no damage: the danger is being pushed off a ledge | Stay out of reach, or behind terrain: terrain between the crow and the pot shelters it | Hook the hammer over terrain and hold on | None |

These rules apply to every attack:

- **Ready attacks.** Before each choice, the engine works out which attacks are ready. An attack is ready when its
  hover point, on the crow's side of the pot or else the other side, lies inside the arena with a clear path:
  - for the dive, three rays: its line and two lines offset by the body's half-height;
  - for the fan, its middle feather (`HazardWorld.reaches`), and the projectile pool must have room for the whole
    volley;
  - for the gust, a ray from the hover point to the pot.

  With no attack ready, the crow hovers at the top centre of its arena for 1 s and tries again.
- **Flight.** The crow flies at up to 9 m/s, accelerating at 12 m/s². It repositions for at least 1.2 s and at most
  4 s. If it has not reached its hover point by then, it attacks from where it is when the path is clear, and
  otherwise chooses again.
- **Contact.** During a dive, physical contact between the crow and the player's bodies, hammer head included, is
  disabled in pre-solve and resolved by rule: one claw hit or one parry per dive. A parry counts whenever the hammer
  head meets the talons, even within the 0.25 s cooldown between hits. At other times the crow collides normally, but
  it stops steering for 0.5 s whenever it touches the player, so a touch never pushes harder than the bump that
  goes with it (`bumpDamage`, `bumpSpeed`, `bumpLift`).
- **Wind.** `Simulation` applies a gust before `world.step`, after the liquids push (`src/simulation.ts:586`). Each
  step it tests the pot's root against the gust's box, ray-casts once from the crow to the root to check for
  shelter, and applies a mass-scaled impulse to every player body with `changePlayerVelocity` (`src/player.ts:139`).
  The pot grips flat rock with about 11.4 m/s² of friction (√(`potFriction` × `rockFriction`) × g). So within
  8 m, each beat slides the pot even on rock unless the hammer is hooked. Wood (9.3 m/s²), metal (6.6) and ice (2.1)
  give way sooner, and rubber (16.1) holds: footing a level designer can choose on purpose. A player caught in the air
  gains about 5.6 m/s per beat.

### Choosing an attack

The tactics slot (Stage 3) chooses each attack from the ready ones. The default chooses by rule, not chance, so the
player can learn the fight:

1. If the pot is more than 9 m from the crow or higher than it, and the fan is ready: **feather fan**.
2. Otherwise, a **claw dive**, if it is ready and the last attack was not a dive.
3. Otherwise, a **gust**, if it is ready.
4. Otherwise, the first ready attack among the fan, the dive and the gust.

A gust often pushes the player more than 9 m away, so a fan tends to follow it, and a dive follows once the player
comes close again.

### Enraged

At half health the crow calls again: for 1.4 s, hits still do damage but never make it flinch. For the rest of the
fight it is enraged. Grounded recovery takes 1.6 s and repositioning at least 0.8 s, and the default tactics:

- shorten telegraphs to 0.8 times their length;
- add a second volley 0.35 s after the first, its lanes offset by half a gap, so the player has to block it or take
  cover;
- lead every second gust straight into a claw dive: the wind pushes the player while the ring marks the dive.

### Defeat

At 0 health the crow plays its death clip and falls within its arena, and an `enemy-defeat` moment is published as
for any enemy. It stays defeated for the run, as [Lifecycle](#lifecycle) sets out. Its ID joins a new
`RunRecord.defeated` list (`src/game.ts`), which saved runs keep (`RUN_KEYS` in `src/saved-run.ts`).

## Stage 1: hit parts (engine-wide)

1. In `ENEMY_SPECS`, a species' `collider` becomes `parts`: a list for each stance the species has, where each part
   is `{ name, shape, plated, terrain }`. Every existing species gets one stance with a single bare `body` part, its
   current collider, which collides with terrain. Their play does not change.
2. `EnemyWorld` still creates one body per enemy (`createCollider`), now with a fixture for each part, each tagged
   with its part. It then sets the body's mass explicitly, and does so again after every swap and every live change
   to a species' mass. The mass is therefore the species' setting in every stance. Today a live change updates only
   the first fixture (`src/enemy-world.ts:187`).
3. A strike reads the struck fixture's part. Obstacle and inside-terrain checks use the touching part's centre rather
   than the body's. `SPECIES_TUNING` gains `plateArmor` and `plateDamage` for species with plated parts.
4. `enemy-hit` and `enemy-defeat` gain `part` and `plated`, so a plated killing blow sparks too.
5. The Workshop check for an enemy starting inside terrain tests every part of its starting stance.

## Stage 2: the crow in play

1. **Species.** Add `crow` to `ENEMY_SPECIES`, labelled "Giant crow", 8 m wide and 3 m tall, with the parts above.
   It flies with gravity off, like the bird, and is steered rather than moved by root motion (`rootMotion` false).
2. **Level data.** `EnemyObject` becomes a union by species. `PatrolEnemyObject`, for the three existing species, is
   unchanged. The crow's is:

   ```ts
   interface CrowObject extends Readonly<Point> { // (x, y): the roost
     readonly kind: 'enemy';
     readonly id: string;
     readonly species: 'crow';
     readonly name: string;  // The boss bar's title, a display name (src/display-name.ts).
     readonly facing: EnemyFacing;
     readonly arena: { readonly left: number; readonly right: number; readonly below: number; readonly above: number };
   }
   ```

   A level may have up to 8 crows. Validation enforces the arena's size, the level's coordinate limit, no overlapping
   arenas and no bonfire inside one. Bump `LEVEL_SCHEMA_VERSION` (12 at the baseline; bump it once if camera zones
   ship in the same release) and regenerate the generated levels. The crow's entry in `src/phantom-course.ts`
   includes its arena.
3. **Waking.** A crow wakes when the player's root comes within 4 m of its arena and sleeps when the root is more
   than 12 m outside it. Its wake proxy (`wakeBounds`) is the arena widened by 4 m. The wake and sleep tests
   (`wakeEnemy` and `driveActive`) measure distance to the arena rather than to the crow. Crows are
   exempt from the fall defeat (`ENEMY_BEHAVIOR.fallenDistance`), since they cannot leave their arenas.
4. **Behaviour.** The crow's state machine, hover points, ready checks and steering go in their own module,
   `src/crow.ts`, which `EnemyWorld` calls for crows. `enemy-world.ts` keeps the shared lifecycle: records, bodies,
   waking and sleeping, hits, bumps, defeat and poses. Timings live in an exported `CROW_BEHAVIOR`, next to
   `ENEMY_BEHAVIOR`.
5. **Resets.** `EnemyWorld` distinguishes three resets: a new run, which clears `defeated`; an encounter reset, at a
   respawn or a rest, which keeps it; and restoring a saved run. Each follows [Lifecycle](#lifecycle).
6. **Phases and poses.** `EnemyPhase` gains `call`, `rear`, `volley`, `raise`, `gust` and `stagger`. The crow also
   uses `patrol` (roosting or repositioning), `windup`, `dive`, `recover`, `hurt` and `dead`. `EnemyPose` gains
   `aimX` and `aimY`, the point the current attack aims at (the dive's ring, the fan's centre line or the gust's
   direction), and `enraged`.
7. **Feathers.** Add a third projectile kind, `'feather'` (`PROJECTILE_KINDS`, `src/hazards.ts`). Feathers fly
   straight with a 30 m range from the shared pool of `SHOOTER.projectiles` (256). They hurt as projectiles do:
   `HurtSource` `'projectile'`, with the crow's ID. Each volley carries a token that lets it hurt at most once,
   whatever `hurtInvulnerability` is set to. `HazardWorld` gains two calls: one reserves room for a whole volley,
   since `launch` skips shots silently when the pool is full; the other removes one owner's projectiles in flight.
8. **Settings.** Add a **Crow** group to the game settings (`Tuning` in `src/config.ts`, `TUNING_FIELDS` in
   `src/game-settings.ts`). Health applies at reset; the rest apply live:

   | Setting | Default | Proposed range | Meaning |
   | --- | --- | --- | --- |
   | `crowHealth` | 1200 | 100–10,000, step 50 | Hit points |
   | `crowMass` | 60 kg | 10–200 | Heavy enough that hammer strikes barely move it |
   | `crowArmor` | 2.5 m/s | 0.8–10 | Strike speed its bare head needs |
   | `crowPlateArmor` | 4.5 m/s | 0.8–10 | Strike speed its plated parts need |
   | `crowPlateDamage` | 20% | 0–100% | Share of a strike's damage the plates let through |
   | `crowDiveSpeed` | 15 m/s | 5–30 | |
   | `clawDamage` | 30 | 0–100 | |
   | `clawPush`, `clawLift` | 8 m/s, 3 m/s | 0–20 | |
   | `featherCount` | 5 | 1–9, whole | Feathers per volley |
   | `featherSpread` | 60° | 0–120° | |
   | `featherSpeed` | 11 m/s | 3–30 | |
   | `featherDamage` | 10 | 0–100 | |
   | `gustAcceleration` | 14 m/s² | 0–40 | A beat's peak |
   | `gustReach` | 16 m | 4–32 | |

   Bump `GAME_SETTINGS_SCHEMA_VERSION` (21), the Workshop's `SNAPSHOT_VERSION` (13), `PROJECT_SCHEMA_VERSION` (23),
   `CONTENT_SCHEMA_VERSION` (22) and `PHANTOM_COURSE_FORMAT` (12), and update the example projects.

## Stage 3: presentation and extension points

Every choice the fight makes for the player and everything it shows or plays goes through a plugin point, with the
engine's version as the default:

| Point | Change | Engine default |
| --- | --- | --- |
| `enemies.crow-tactics` (`CROW_TACTICS`), new slot | A `CrowTacticsFactory`, below | `DEFAULT_CROW_TACTICS`: the rule under [Choosing an attack](#choosing-an-attack) |
| `hud.boss` (`HUD.boss`), new slot | A `HudReadoutFactory`. `HudFrame.boss` is `{ id, name, current, max }` during a fight and `null` otherwise. The HUD calls this readout's `update` only during a fight, and once after it ends | A wide bar centred at the bottom of the screen, with the name above it, a notch at half health and the health meter's draining chunk |
| `effects.attacks` (`EFFECTS.attacks`), new slot | A `MomentEffectFactory` that reads `enemy-attack` moments, with the frame's enemy poses and view (`SceneFrame`) | The dive's ring, the fan's lanes, the gust's gathering dust and its streaks. For an attack that winds up off screen, a marker at the edge of the view points at the attacker. Pooled instanced batches, active only from an attack's moment until it ends |
| `looks.projectile` | `ProjectilePose.kind` can be `'feather'` | A dark quill along its flight |
| `looks.enemies` | Poses gain `aimX`, `aimY` and `enraged`; the crow has its own clip roles | `EnemyView` draws the crow's built-in pixel art with the usual windup, hurt and death effects, tilted nose-down in the ground stance. A crow model plays its clips through the enemy-model look |
| `effects.strikes` | `enemy-hit` and `enemy-defeat` gain `part` and `plated` | Sparks for a plated hit; the current burst for a bare one |
| `effects.enemy-health` | None | No bar over a crow, since the boss bar shows its health |
| `audio.output` | New cues and moments | Plays the project's clips for the new cues |
| `game.observers` | New moments | None |

**Tactics.** The engine calls `next` only between attacks, and only when at least one attack is ready. A plan that
breaks the rules in the comments below is refused as `invalid-contribution`. The tactics choose the attack; the engine
keeps flight, hover points, hits, damage and the shortest telegraphs, so every plan stays fair and readable.

```ts
interface CrowTactics {
  // The crow is ready for its next attack. Write the choice into `out`; allocate nothing.
  next(view: CrowTacticsView, out: CrowPlan): void;
  inspect?(): unknown;
}
// Reused and read-only.
interface CrowTacticsView {
  readonly id: string;
  readonly x: number; readonly y: number;             // The crow's centre.
  readonly playerX: number; readonly playerY: number; // The pot's root.
  readonly health: number; readonly maxHealth: number;
  readonly enraged: boolean;
  readonly previous: CrowAttack | null;               // This fight's last attack.
  readonly attacks: number;                           // Attacks this fight.
  readonly ready: Readonly<Record<CrowAttack, boolean>>;
}
interface CrowPlan {
  attack: CrowAttack;  // 'volley' | 'dive' | 'gust', and ready.
  volleys: 1 | 2;      // A fan's volleys.
  followUp: boolean;   // A gust leads straight into a dive.
  pace: number;        // Telegraph length, 0.6–1.5 times CROW_BEHAVIOR's.
}
```

- **Moments** (`MOMENT_TYPES`, `src/moments.ts`):
  - `enemy-attack`: `{ id, species, attack, stage, x, y, aimX, aimY, duration }`. `attack` is `'dive'`, `'shot'`,
    `'volley'` or `'gust'`; `stage` is `'windup'` or `'strike'`; `duration` is how long the stage lasts. Birds and
    archers publish it too, so every telegraph can have a sound and an off-screen marker.
  - `boss`: `{ id, species, state }`, where `state` is `'engaged'`, `'enraged'` or `'ended'`. A fight ends when it
    stops, at the player's death, at a Workshop edit to the crow, or at defeat, which also publishes `enemy-defeat`
    (see [Lifecycle](#lifecycle)).
- **Audio cues** (`AUDIO_CUES`, `src/audio-settings.ts`), each with a label and description:
  - `armor-hit`, for a plated hit, played instead of `enemy-hit`. On a killing blow, `enemy-defeat` plays instead.
  - `crow-call`, `crow-volley`, `crow-dive` and `crow-gust`, for the call and the three telegraphs.
- **Clip roles.** Add `call`, `rear`, `volley`, `raise`, `gust` and `stagger` to `ENEMY_CLIP_ROLES`.
  `SPECIES_CLIP_ROLES.crow` is `idle` (at its roost), `walk` (flying), `call`, `rear`, `volley`, `windup`, `dive`,
  `recover` (grounded after a dive), `raise`, `gust`, `stagger`, `hurt` and `death`. In `docs/enemy-models.md`, list
  the roles and the parts table, so modellers put the head where the head part is in each stance.
- **Built-in art.** Pixel art in two frames, wings up and wings down, sized for 8 m × 3 m. With the attack marks, it
  is enough to read every telegraph. A model shows the stances properly.
- **Docs.** Each new slot goes in the `docs/runtime-plugins.md` tables and default sections, in the
  `docs/plugins.md` point catalogue and facet list, and in the README lists. The tactics contract gets its own
  section in `docs/runtime-plugins.md`, with an example that changes the pattern. The moments, cues and settings go
  in `docs/runtime-plugins.md#gameplay-moments`, `docs/projects.md` and a README **Crow** section under **Enemies**.
  Saved runs' `defeated` list goes in `docs/release-plugins.md#saved-runs`.

## Stage 4: authoring

1. **Palette.** Add **Crow** under enemies. It places a crow named "Giant crow" with a 30 m × 17 m arena: 15 m to
   the left and right, 14 m below and 3 m above.
2. **Inspector and overlay.** The inspector edits the name, the facing and the arena's four extents. The arena draws
   as a dashed rectangle with edge handles. The selected crow also shows its parts, its hover distances and the
   gust's reach. Edits are Workshop History commands.
3. **Frame arena.** This adds a bounded camera zone over the arena, or refits the zone that already covers it. The
   zone is the arena grown by 1 m on every side, so it stays active out to 2 m, where the fight stops. Its zoom is
   the one that shows the whole zone at 16:9, `max(height, width × 9/16) / 8.5`, capped at ×2. Beyond that, the
   camera follows the player within the bounds. It is one History command.
4. **Level checks.** Validation already refuses overlapping arenas and bonfires inside them. As a problem: a crow
   starting inside terrain (the existing check, now with parts). As suggestions: an arena that no bounded camera
   zone covers, and an arena with no bonfire within 40 m of it.
5. **Showcase.** Add a thirteenth station to `scripts/showcase/generate.ts`: a crow arena after a bonfire, with a
   framed zone. Then regenerate the showcase.

## Performance

- A level without a crow does no new per-frame work. The crow's code, the wind step, the boss readout and the
  attack marks run only while a crow is awake, a fight is on or an attack is under way.
- A crow is one body with at most four fixtures, swapped only when it turns or changes stance. Ready checks and
  tactics run only between attacks: a few ray casts for each attack and side. Steering runs every step.
- A volley is at most twice `featherCount` feathers (10 by default), reserved in the existing pool. A gust costs one
  box test and one ray cast per step.
- The boss bar writes to the page only when the health or name changes. The attack marks' batches each upload a
  single update range while they show.
- Test on the largest generated level (`npm run generate:streaming`) with a crow arena framed at ×2: check frame time,
  draw calls and triangles in the rendering diagnostics.

## Acceptance

- In a play-test with the built-in sprite and no sound, each attack can be recognised from its marks and telegraph
  alone, then dodged, blocked, parried or braced against as the table says. Head strikes visibly hurt and stagger
  the crow. Plated strikes spark and barely move the bar.
- On a portrait phone with the default rig, a ×2 zone shows about 12.6 m × 22.4 m, so the crow is often partly off
  screen. Edge markers still announce every attack that winds up out of view.
- A volley hurts at most once, even with `hurtInvulnerability` at 0.
- Each lifecycle row holds: fights start and stop at the arena, deaths and rests heal the crow, and a defeat lasts
  through deaths, rests and a reloaded saved run until a new run.
- The existing species play exactly as before.
- A plugin can replace every new point, and the docs show how.
- A level without a crow does no new per-frame work.
- Validation, per the project's practice: type-checking (`npm run build`), code review, and a Workshop play-test of
  the showcase arena on a desktop and on a portrait phone.

## Open questions

- Should a stopped fight heal the crow? This design keeps its damage.
- Every number here (health, damage, speeds and timings) is a starting point for play-tests.
- Should a defeat be able to open the way onward, for example by moving a platform? A follow-up could give the crow
  a list of `TriggerAction`s, run once at defeat by the trigger executor.
- Should different crows in one game follow different tactics? Content could then choose tactics by ID, through a
  `kinds` point, instead of the game's single slot.
- The pot can come to rest on the crow, and touching it bumps the player. Play-tests should confirm that riding it
  is never worth it.

## Out of scope

- The behaviour of the other species stays the engine's, tuned by settings. The crow's tactics slot is the first
  point that chooses enemy behaviour.
- Boss music. A game's `AUDIO` output can change tracks on the `boss` moment; a default track change could follow.
- Camera shake, intro cut-scenes, and a camera that follows the crow. The camera zone covers the arena, and the edge
  markers cover what it cannot show.

## Context

A downstream game wants a large flying boss that tests the climbing controls: projectiles to block, a dive to read
and punish, and wind to brace against. The new engine pieces are generic: hit parts, attack moments and marks, the
wind force, the tactics slot and the boss readout can all serve later bosses.
