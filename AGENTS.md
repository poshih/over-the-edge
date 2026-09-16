# Project requirements

- Performance is a feature requirement. Do not ship knowingly unoptimized
  shortcuts. Reuse geometry/materials, update changed objects incrementally,
  and keep per-frame work proportional to active effects rather than level size.
  Exercise representative large levels before declaring new features complete.
- Keep gameplay and editor code separate. Runtime modules must not import
  editor modules. Maintain distinct editor and game-only entry points, and
  enforce that the playable release contains no editor modules or editor assets.
- Authored level data is shared by physics and rendering. Temporary gameplay
  effects must not mutate the authored level or its saved/exported definition.
