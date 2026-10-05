# Project requirements

- Performance is a feature requirement. Do not ship knowingly unoptimized
  shortcuts. Reuse geometry/materials, update changed objects incrementally,
  and keep per-frame work proportional to active effects rather than level size.
  Exercise representative large levels before declaring new features complete.
- Keep gameplay and editor code separate. Runtime modules must not import
  editor modules. Maintain distinct editor and game-only entry points, and
  enforce that the playable release contains no editor modules or editor assets.
- Build for downstream games to customize without forking the engine. Whatever a
  player sees, hears or plays by is either project content or a typed extension
  point for the game's own code, with the engine's own look and behaviour as the
  default implementation of that same contract, replaceable piece by piece: a
  game swaps the health readout without redrawing the rest of the HUD. A feature
  is complete only with its extension point and the docs saying how to use it.
  Put each extension point where its code runs, in a facet of the plugins a
  game lists in its `GAME_PLUGINS` manifest, each with up to four facets:
  `kinds` for code that content selects by ID, validated identically in Node
  and every game; `runtime` for what play shows, sounds and does, in the
  Workshop, studio previews and releases; `release` for release-only services;
  and `workshop` for authoring tools. Each environment has one SDK
  (`src/plugins/kinds-sdk.ts`, `runtime-sdk.ts` and `release-sdk.ts`;
  `src/editor/workshop-sdk.ts`), and the kernel (`src/plugins/kernel.ts`,
  `docs/plugins.md`) composes its points. Keep contracts small, typed,
  validated where they load with `PluginError`, free of engine internals and
  globals, and with no per-frame cost unless active. Engine code, docs and
  commits never name a downstream game.
- Authored level data is shared by physics and rendering. Temporary gameplay
  effects must not mutate the authored level or its saved/exported definition.
- Level design: never place small colliders (1.5 m or less on their longest side,
  about the pot's size) within 1.2 m of each other, touching included; the pot and
  hammer head wedge between them. Dress levels with decorations, which never
  collide, not with terrain props. Only a library set piece's own parts, designed
  and tested together, may sit closer.
- Level callouts such as "D7" name squares of the Workshop's level board
  (`src/level-board.ts`): 10 m squares whose rows count up from y = 0 (row 7 spans
  y 60-70 m, row 0 lies just below it) and whose columns are lettered A, B, ...
  rightward from column A, the 10 m band, on multiples of 10 m, holding the
  level's leftmost terrain point.
- Everything that collides is drawn centred on the obstacle line (`OBSTACLE_LINE`,
  z = 0, in `src/obstacle-line.ts`), where the 2D physics plays out, so collision
  looks right in perspective: terrain meshes reach half their depth each side of
  it, a GLB mesh colliding as its slice there, and the pot and enemies stand on it.
  Keep new collider visuals on it.
  Characters and enemies draw in the actors pass, over the course, so colliders
  never hide them. Decorations on or in front of the line draw over the actors.
  A 3D character's arms (`ARM_LAYER`) then draw over its body, jar and head,
  sharing one depth with the hammer so the hands hold it; keep new arm visuals on
  that layer. Marks that ignore depth draw over the arms and under the hammer.
  Decorations never collide and may sit at any depth, but a prop standing on a
  collider stays within that collider's depth.
- Always do what is best for the project: choose the cleanest correct design,
  never a hack or workaround. Do not maintain backward compatibility: no
  migrations, legacy readers, compatibility shims or deprecated fields. Saved
  data need not be retained, and downstream games remake their assets when a
  format or convention changes, so do not constrain designs around them.
