# Feature request: load every game-release asset from a CDN through the game's own authentication

**Date:** 2026-09-28 · **Baseline:** `95b9551` · **Status:** requested, not started.

A game with paid or account-bound content needs every asset of its release to reach only the players its own backend
allows, such as signed-in accounts with the right entitlement. Games identify players in different ways, so the engine
must not implement identity. Instead a game build splits into a public shell and private content, the release loads
that content only through access the game grants, and it verifies everything it loads. Each game plugs its own
identity provider, backend and CDN into that one seam. The editor build is out of scope.

## What exists today (source-audited at `95b9551`)

- A game build is one public bundle. The level, settings, theme, HUD, enemy art, arm IK, audio settings and character
  profile metadata are embedded in its JavaScript. PNGs, GLBs (character, appearance and course artwork), audio and
  video are hashed static files in `dist-game/`, which `wrangler.game.toml` deploys as a public directory.
- The runtime fetches each kind of file itself: PNGs without credentials (`sprite-rig.ts`), GLBs and sound cues with
  `credentials: 'same-origin'` (`fetchModelBlob()`, `audio.ts`), music and video by setting a media element's `src`
  (`audio.ts`, `event-presenter.ts`). Nothing lets a game authorize those requests.
- Level events, audio settings and profile images may name external HTTP(S) sources, which a release loads as written.
- A release has no place for the game's own code, such as sign-in, without editing `src/play.ts` (a downstream fork).
- The project server's authentication (loopback or `STUDIO_TOKEN`) protects authoring, not players.

## Scope boundary

The engine has no concept of identities, accounts, sessions, tokens, entitlements or purchases. It never sees a
credential and never decides who may load what. It defines how release content is packaged, how a game grants access
to it, and how the release verifies what arrives. Everything about players belongs to the game's own code, backend and
CDN.

## Requested capability

Three parts, each with one owner:

| Part | Owner | Contract |
| --- | --- | --- |
| Content output | engine, at build time | content-addressed files in groups, listed by a manifest the shell pins |
| Content access | game, in its release module | grants for a group's files, or a typed refusal |
| CDN and enforcement | game, in its backend and CDN | the game's CDN serves a group's files only to granted requests |

### 1. A public shell and private content

- **Split.** A game build writes the shell (`dist-game/`: HTML, CSS, the engine's and the game module's JavaScript,
  the icon) and the content (for example `dist-game-content/`) separately. The shell holds no game content: no level,
  settings, profile, theme, HUD, audio setting, image, model or media. The content output is never inside the shell's.
- **Groups.** Content is split into groups that load together and that a CDN policy grants as a unit. The `game` group
  holds everything the release itself uses. Later features may add groups, for example one per swappable model in
  [runtime model swap](FEATURE-REQUEST-runtime-model-swap.md).
- **Content-addressed paths.** Each file is `<group>/<sha256>.<ext>`: immutable, cacheable indefinitely, renamed when
  it changes, and covered with the rest of its group by one path-scoped CDN credential.
- **Manifest.** A manifest in the `game` group lists every group's files with their role in the release, type, size
  and SHA-256. The shell pins the manifest's own SHA-256, so the shell, the manifest and every file form one integrity
  chain from a single build.
- **Everything packaged.** A game build accepts no external or unpackaged source: every level event, audio setting and
  profile reference must resolve to packaged content, or the build fails naming it.

### 2. Content access: where the game's identity plugs in

The release loads content only through a content access adapter. The game's module (§4) supplies it; a game that needs
no authentication uses the engine's public access, a plain fetch from the configured content URL (§3).

- **Grants.** The engine asks the adapter for a group and the paths it needs. The adapter returns a URL for each path
  and whether requests send cookies, or refuses with a typed error: `unauthenticated`, `denied` or `unavailable`. This
  is where the game signs the player in with its own identity provider and trades that session for CDN credentials
  from its backend; the engine never sees either.
- **Fetching.** The engine fetches granted URLs itself, with bounded concurrency, applying each type's existing size
  limit while streaming, and sends cookies only when the grant says so. Media elements play granted URLs directly, so
  signed URLs and cookies work for music and video too.
- **Integrity.** The engine checks every fetched file's size and SHA-256 against the manifest before parsing it, then
  runs the same validators as today's builds; a mismatch fails with an `integrity` error. Streamed music and video
  cannot be checked before playback, so they are access-controlled but not integrity-checked.
- **Expiry.** Grants may expire. When one has, or the CDN answers 401 or 403, the engine asks the adapter once more,
  then fails with the typed error. The adapter caches and refreshes grants as it likes.
- **Secrecy.** Grant URLs are credentials. The engine keeps them and all content in memory, never in browser storage,
  and names content by its manifest path, never its URL, in errors and notices.

Suggested adapter (upstream's design call):

```ts
interface ContentAccess {
  grant(request: { group: string; paths: readonly string[]; refresh: boolean }, signal: AbortSignal): Promise<{
    urls: ReadonlyMap<string, string>;  // signed, covered by a cookie, or a blob: URL made from a platform's bytes
    credentials: 'omit' | 'include';    // 'include' only when a cookie authorizes the CDN request
    expires: number | null;             // epoch milliseconds, or null
  }>;
}
```

### 3. The game's CDN: configuration and enforcement

The CDN is the game's choice. The engine names no CDN or provider, documents what the CDN must do, and ships none of
it.

- **Content URL.** A build input like the other `GAME_*` inputs, for example
  `GAME_CONTENT_URL=https://cdn.example.com/my-game/`, says where the content output is served. It defaults to
  `content/` beside the shell. The engine's public access fetches the content URL plus each file's path, and the
  module receives the URL (§4), so an adapter builds on it instead of hard-coding a host.
- **The adapter decides.** It sets every file's final URL, so a game can serve groups from different hosts, let its
  backend choose a host per player or region, or point a refreshed grant elsewhere.
- **Per environment.** Development, staging and production builds set different content URLs.
- **Movable content.** File names depend only on content, so every build of the same content writes the same files.
  Moving to another CDN, or mirroring on two, means uploading the same files and changing only the content URL, which
  rebuilds the shell but not the content, or the adapter's URLs, which rebuilds nothing.
- **The CDN's own settings.** Signing keys, cache rules, CORS and edge functions are configured in the game's CDN, not
  in the engine.

Each of these fits the grant contract:

- **Signed URLs or cookies.** The backend verifies the player with the game's identity provider, checks the
  entitlement for the group, then returns short-lived signed URLs or sets a signed cookie scoped to the group's path.
  The CDN verifies the signature at the edge.
- **Token at the edge.** An edge function verifies the identity provider's token from a cookie (signature, issuer,
  audience, expiry) and an entitlement claim for the group, then serves the file from private storage.
- **Backend proxy.** The backend checks each request and streams the file, giving up edge caching.

In every case the CDN answers the shell's origin with CORS headers, allowing credentials when cookies authorize. It
answers 401 for a missing or expired credential and 403 for a refused one. It may cache content-addressed files
indefinitely, checking the credential on every request.

### 4. The game's module in the release

A build input like the other `GAME_*` inputs, for example `GAME_MODULE=<path>`, bundles one module of the game's own
code into the shell. It combines with `GAME_PROJECT` and the per-file inputs.

- **Before content.** The release starts the module before it fetches anything. The module receives the interface
  mount, a notice function and the content URL, so it can show its own sign-in UI, and returns its content access
  adapter.
- **While loading.** The release loads the `game` group through the adapter and reports progress to the module. A
  refusal or failure reaches the module as a typed error, and the module can retry after sign-in or purchase; without
  a module, the release shows the error.
- **After loading.** Once the game exists, the module receives its API: pause and input blocking under its own reason
  (`Game.setPause()`, `Game.setInputBlock()`) and the halted state. Later features add theirs, such as the model
  library.
- **Lifecycle.** The module may return a disposer, which the release calls when it disposes the game (for example on
  a development reload).

**Constraints:**
- It is a build input, never project data, so nothing sent to the project server can add code to a release.
- The shell is public, so the module holds no secrets.
- The release boundary covers it: it cannot bring editor modules or editor assets into the release.
- The engine never imports anything it brings (for example an identity provider's SDK).
- Only the module holds the release API; releases put it on no global.

### 5. Development, publishing and the editor

- `npm run dev:game` and `npm run preview:game` serve the content locally, through public access or through the
  module's adapter against a local CDN stand-in.
- **Deploying.** `wrangler.game.toml` deploys the shell only. A public game also deploys its content output at its
  content URL, as a separate explicit step; a protected game uploads it to its own CDN. Deploying the shell alone
  never publishes content.
- The project server's publish writes both outputs, never content inside a release folder, and previews the release
  with its content behind the studio's existing authentication.
- **Out of scope: the editor build.** The Workshop keeps reading project files directly. A Workshop built with
  `GAME_PROJECT` publishes every project file, so a game with protected content deploys it only behind its own access
  control, or not at all.

## Threat model

- **Protected.** A player the game's backend refuses (signed out, not entitled, or holding an expired grant) cannot
  get any content from the shell, its deployment, the CDN or the engine's API.
- **Verified.** Whoever controls the CDN cannot make the release use anything but the build's content, except streamed
  music and video.
- **Not protected.** An entitled player's browser holds what it downloaded; the engine does no DRM. The shell's code
  is public, and a Workshop deployed with the project exposes that project.

## Acceptance

- **Nothing in the shell:** for a project with every kind of content, no shell file contains any content file's
  bytes, the level, the settings or a profile.
- **Only through access:** with a test module whose adapter signs URLs for a local CDN stand-in that checks them:
  - the release plays as it does today;
  - every content request uses a URL the adapter granted for that path, and an expired grant is refreshed once on a
    401 or 403;
  - an `unauthenticated` or `denied` refusal reaches the module as a typed error, and nothing more loads until it
    retries.
- **Integrity:** a manifest or file whose bytes differ from its pinned SHA-256 is rejected before parsing, and the
  game never starts on it.
- **Secrecy:** cookies go only to grants that ask for them, and no grant URL appears in an error, a notice or browser
  storage.
- **Public access:** a game built without an adapter loads its content from its content URL without credentials and
  plays as it does today.
- **Configurable CDN:** two builds that differ only in their content URL write byte-identical content outputs, and
  each plays from its own host; an adapter that serves one group from a second host loads that group from there.
- **Everything packaged:** an external source in a level event, audio setting or profile fails the build, naming it.
- **Performance:** the representative large course with mesh artwork makes one grant request per group and fetches in
  parallel with bounded concurrency, so it starts later than today by at most the grant and manifest round trips.
  Verification stays off the frame loop, and per-frame cost is unchanged.
- **Boundary:** no engine module handles identities, tokens or entitlements; a release built without `GAME_MODULE`
  contains no downstream code; runtime modules import no editor modules, and a `GAME_MODULE` that imports one fails
  the build.

## Constraints (from `AGENTS.md`)

- **Performance** is a feature requirement.
- **Separation:** runtime modules never import editor modules; releases contain no editor modules or assets.
- **Authored data:** loading content never mutates authored level or profile data.
- **Design:** the cleanest design, with no backward-compatibility shims; every game build uses this one pipeline.

## Context

A downstream game sells access to the whole game and to individual models, and signs players in with its own identity
provider. Nobody may download content they have not bought, from the release, its deployment or its CDN. Its module
signs players in and trades their session for short-lived CDN credentials from its backend, which decides entitlement.
None of that belongs in the engine.
