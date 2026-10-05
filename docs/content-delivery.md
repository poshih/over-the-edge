# Content delivery

A game build is a **public shell** plus **private content**. The shell is the page, the
engine's and the game module's code, the styles and the icon. The content is everything the
game shows or plays: the level, settings, character profiles, theme, HUD, audio settings,
images, models and media. The release loads content only through the game's **content
access**, which is where each game plugs in its own identity management: its sign-in, its
backend and its CDN. The engine never sees accounts, tokens or entitlements; it only packages
content, asks for access and verifies what arrives.

The Workshop (editor build) is out of scope: it keeps reading project files directly.

## Build outputs

```sh
npm run build:game   # writes dist-game/ (shell) and dist-game-content/ (content)
```

A build with `--outDir X` writes its content to `X-content/`. The content output is never
inside the shell's folder, so deploying the shell never publishes content.

```text
dist-game/
  index.html
  favicon.svg
  assets/index-<hash>.js          engine code, and the game's module when there is one
  assets/index-<hash>.css
dist-game-content/
  game/<sha256>.json              the manifest
  game/<sha256>.png               sprite images
  game/<sha256>.glb               character, appearance and course models
  game/<sha256>.wav               media, by extension
  game/<sha256>.phantoms          bundled phantom recordings, one pack per height band
  library/<part>/<id>/<sha256>.glb  one model library entry, for runtime swaps (with GAME_MODULE)
```

- **Groups.** Content is split into groups that a CDN grants as a unit. The `game` group is the
  base game: everything every player uses. A path is `<group>/<sha256>.<extension>`, so one credential
  scoped to `game/` covers the whole group. Each [model library](characters.md#model-library-and-runtime-swaps)
  entry, such as a cosmetic avatar, hammer or pot, is its own group, `library/<part>/<id>`, never part
  of the base game and fetched only once the game's backend selects it for the player; a game
  built without `GAME_MODULE` has no such backend, and no library groups.
- **Named by content.** Every file is named by its SHA-256. Files are immutable, cacheable
  forever and renamed when they change. Two builds of the same game write identical content,
  wherever it is served.
- **Pinned.** The shell pins the manifest's path and size, and lists every path of the `game`
  group, so one grant covers the group before the manifest arrives. It lists no library model. The manifest lists every
  other file with its size. Each file's path names its SHA-256, so the shell, the manifest and
  every file form one integrity chain from a single build.
- **Everything packaged.** A game build loads nothing from outside its content. It fails,
  naming the source, when a level's video or sound event, the audio settings or a character
  profile names an external URL, or when a profile's image or model is not embedded. Per-file
  builds package a level's `/media/` files from `public/media/`; project builds package the
  project's media library files the level and the audio play.
- **Only what the game uses.** A game build reads and checks only the files it packages, so an
  unused file in a project cannot fail the build. It packages the course meshes the level
  draws in the release's look, the media the level and the audio play, and the art of the
  enemy species the level places. The model library is packaged only for a game with its own
  module (`GAME_MODULE`): without a backend to select them, no library model can ever show.
  From a project directory, each file is read, checked and copied into the content on its own,
  so a build never holds more than one at a time; a project file is one JSON text, which the
  build reads whole.
- **Code by use.** The shell includes the GLB, course-mesh, appearance and audio loaders only
  when its content needs them.

## Content URL

`GAME_CONTENT_URL` says where the content output is served. It is an HTTP(S) URL or a path
relative to the page, and ends in `/`, without credentials, query or fragment. The default,
`content/`, is beside the shell, where `npm run dev:game` and `npm run preview:game` serve it.

```sh
GAME_CONTENT_URL=https://cdn.example.com/my-game/ npm run build:game
```

Development, staging and production builds set different content URLs. Moving to another CDN,
or mirroring on two, means uploading the same files and changing the content URL, which rebuilds
the shell but not the content. A game's module can also choose each file's URL itself (see
below), which rebuilds nothing.

## Public games

A game without a module loads its content from the content URL, without cookies. Deploy both
outputs:

- the shell, for example with `npx wrangler deploy --config wrangler.game.toml --keep-vars`;
- the content, uploaded to whatever static host or CDN serves the content URL. Serve it from
  another origin with CORS headers for the shell's origin, or under the shell's origin at the
  content URL.

`wrangler.game.toml` deploys the shell only; publishing content is always a separate step.

## Protected games: the game's module

`GAME_MODULE` bundles one module of the game's own code into the shell (see
[the game's module](game-module.md)). It must be a `.ts` or `.js` file inside this repository,
and combines with `GAME_PROJECT` or the per-file inputs:

```sh
GAME_PROJECT=projects/my-game GAME_MODULE=games/my-game/module.ts \
  GAME_CONTENT_URL=https://cdn.example.com/my-game/ npm run build:game
```

The module exports `start(host)`. The release calls it once, before it fetches anything, and
awaits it, so the module can sign the player in first. Types are in `src/release-module.ts`.

```ts
import { ContentError } from '../../src/release-module';
import type { ReleaseHost, ReleaseModule } from '../../src/release-module';

export async function start(host: ReleaseHost): Promise<ReleaseModule> {
  // host.mount is the release's interface element: the module may add its own sign-in UI there.
  return {
    access: {
      async grant(request, signal) {
        // The game's backend checks the player's session and entitlement for request.group,
        // then signs request.paths. The engine never sees the session or the signing key.
        const response = await fetch('https://api.example.com/content-grants', {
          method: 'POST', credentials: 'include', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        });
        if (response.status === 401) throw new ContentError('unauthenticated', 'Sign in to play.');
        if (response.status === 403) throw new ContentError('denied', 'This account does not own the game.');
        if (!response.ok) throw new ContentError('unavailable', 'The store is unavailable.');
        const answer = await response.json();
        return { urls: new Map(Object.entries(answer.urls)), credentials: 'omit', expires: answer.expires };
      },
    },
    progress: ({ loaded, total }) => { /* show loading */ },
    // Resolve to load again, for example once the player has signed in or bought the game;
    // reject to stop with that error shown.
    failed: (error) => showSignIn(host.mount, error.code),
    ready: (api) => { /* the game runs; api.setPause(true) while the module's UI is open */ },
    dispose: () => { /* development reloads */ },
  };
}
```

The module's whole contract, what `start` receives and returns, the API the running game hands it
and the HUD readouts it may draw its own way, is in [the game's module](game-module.md). A release
built without `GAME_MODULE` contains no downstream code, and the shell is public, so the module
must hold no secrets.

## Avatar rig strategies: the rig module

`AVATAR_RIG_MODULE` adds a game's own [avatar rig strategies](characters.md#rig-strategies) and
[motion kinds](characters.md#secondary-motion) to the registry that already holds the standard
strategy and the built-in hair, so its imported avatars may select them.
Like `GAME_MODULE`, it must be a `.ts` or `.js` file inside this repository:

```sh
AVATAR_RIG_MODULE=games/my-game/rigs.ts npm run build:game
```

The module default-exports `{ apiVersion, strategies, motions }` at **API version 2**
(`AVATAR_RIG_API_VERSION` in `src/avatar-rig.ts`). It is imported once, when the dev server,
build or project server starts, through Vite's own resolver, so the validators check exactly
the strategies and motion kinds the browser runs. A module whose export is malformed, declares
another API version, duplicates a strategy ID or omits the standard strategy fails with a typed
`AvatarRigError` naming the fault, and a malformed or duplicated motion kind with a typed
`AvatarMotionError`, not a plain loader error. Its editor-only `controls` export is read by the
Workshop alone; a release never imports it.

Unlike `GAME_MODULE`, the rig module is **not** ignored by publishing: the project server loads
it to validate every model it stores, and the release it builds keeps it, so a published game
shows the same avatars. The registry is a **startup snapshot** — it is not reloaded when the
module changes, so restart the dev server, rebuild or restart the project server. Every
validator enforces it: importing or opening a project, the project server's writes, release
packaging and the running release, so a custom driver never falls back to the standard rig in
one path and works in another.

## Grants

`access.grant({ group, paths, refresh }, signal)` returns a `ContentGrant`:

```ts
interface ContentGrant {
  urls: ReadonlyMap<string, string>;  // one https:, http: or blob: URL per requested path
  credentials: 'omit' | 'include';    // 'include' only when a cookie authorizes the CDN request
  expires: number | null;             // epoch milliseconds, or null
}
```

A refusal throws a `ContentError`. The engine adds the group when the module leaves it out, and
wraps anything else the adapter throws as `unavailable`.

| Code | Meaning |
| --- | --- |
| `unauthenticated` | The player must sign in, or the CDN answered 401 after a renewed grant |
| `denied` | The player may not have this content, or the CDN answered 403 after a renewed grant |
| `unavailable` | The backend, the CDN or the network failed |
| `integrity` | A file's size or SHA-256 differs from the build's, or the manifest is invalid |
| `superseded` | A newer swap of the same part replaced this one before it was sent |
| `unknown-model` | A swap, or the backend's answer, names a library model the release does not list |

The engine:

- **Asks once per group.** Concurrent downloads share one grant request. At boot, one request
  covers the whole `game` group.
- **Renews once.** A grant within 5 s of `expires` is renewed before use; one that arrives that
  close to expiry is used until the CDN refuses it. When the CDN answers a download with 401 or
  403, the engine asks again with `refresh: true`, once for all the downloads that met the old
  grant, then fails with the typed error. A refusal answers every download that started before
  it; later downloads, such as a swap after a purchase, ask again.
- **Downloads in parallel.** At most six files at a time, streamed into buffers of the manifest's
  exact size. A request that gets no response or no data for 30 s fails as `unavailable`.
- **Verifies before parsing.** Every downloaded file's SHA-256 is checked against its path, then
  the loaders run the same checks as every import. WebCrypto computes the digest; pages without
  it, such as a development server opened from another machine over plain HTTP, use a
  JavaScript digest.
- **Streams music and video.** Media elements play granted URLs directly, as CORS requests:
  `crossorigin="anonymous"` for `omit` grants and `use-credentials` for `include`. Music and
  video are access-controlled but cannot be verified before playback. Sounds are downloaded and
  verified.
- **Keeps secrets in memory.** Grants and content are never written to browser storage. Errors
  and notices name content by path, never by URL. Cookies go only to grants that ask for them.

## The game's CDN

The engine names no CDN and ships none of its configuration. Whatever serves the content must:

- answer the shell's origin with CORS headers, on errors too, so the engine can see 401 and 403.
  Grants with `credentials: 'include'` also need `Access-Control-Allow-Credentials: true` and
  the exact origin;
- answer 401 for a missing or expired credential and 403 for a refused one;
- serve byte ranges for media, which browsers request while streaming;
- check the credential on every request. Content-addressed files may otherwise be cached
  forever.

Each of these fits the grant contract:

- **Signed URLs or cookies.** The backend verifies the player with the game's identity provider,
  checks the entitlement for the group, then returns short-lived signed URLs or sets a signed
  cookie scoped to the group's path. The CDN verifies the signature at the edge.
- **Token at the edge.** An edge function verifies the identity provider's token from a cookie
  (signature, issuer, audience, expiry) and an entitlement claim for the group, then serves the
  file from private storage. Grants return plain URLs with `credentials: 'include'`.
- **Backend proxy.** The backend checks each request and streams the file, giving up edge
  caching.

Signing keys, cache rules, CORS and edge functions are configured in the game's CDN, not in
the engine. A grant must outlive the longest video, or use cookies, because media elements
keep requesting ranges while they play.

## Threat model

- **The backend decides.** The shell, the engine and the module run on the player's machine,
  where the player can change them. So the game's backend makes every decision that matters,
  such as who may load which group and which library model each part uses, and enforces it
  through what it grants and what its CDN serves; the release only carries decisions out.
- **Protected.** A player the backend refuses (signed out, not entitled, or holding an expired
  grant) cannot get content from the shell, its deployment, the CDN or the engine's API.
- **Verified.** Whoever controls the CDN cannot make the release use anything but the build's
  content, except streamed music and video.
- **Not protected.** An entitled player's browser holds what it downloaded; the engine does no
  DRM. The shell's code is public, and a Workshop deployed with its project exposes that project.

## Development and publishing

- `npm run dev:game` builds the content in memory and serves it at `/content/`; a changed input
  reloads the page. `npm run preview:game` serves `dist-game/` and `dist-game-content/` together.
- The project server's **Publish** writes the shell to `releases/<id>/` and the content to
  `releases/<id>.content/`, and serves both at `/play/<id>/`, behind the studio's own access
  checks. Publishing ignores `GAME_CONTENT_URL` and `GAME_MODULE`: a studio preview uses public
  access to its own content and, without a backend that selects, packages no library models. It
  honors [`AVATAR_RIG_MODULE`](#avatar-rig-strategies-the-rig-module): the published shell bundles
  the same strategies the project server validated the project's models against.
- A Workshop built with `GAME_PROJECT` publishes every project file, so a game with protected
  content deploys that Workshop only behind its own access control, or not at all.
