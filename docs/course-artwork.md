# Shared course artwork

The Level editor can texture an existing terrain shape with Tripo, generate a
new low-poly mesh, or reuse a GLB from a shared library. Artwork never changes
Planck collision geometry. Each terrain part retains its own artwork reference,
so illusion fades, disappearance, and resets remain independent.

This is an authoring service, not a dependency of the playable game. The hosted
Workshop uses Cloudflare Access for identity, D1 for the shared catalog and
private generation jobs, and R2 for immutable GLBs. All users authorized by the
host's Access application can read the library and publish assets/variants.
Only the owner can use their Tripo connection, list their jobs, or resume them.

## Editor workflow

1. In **Workshop / Level / Shared course artwork**, select **Connect / refresh
   shared library**. Reusing assets does not require a Tripo account.
2. Select terrain on the canvas, or choose an obstacle in **Set piece library**.
   **Generate a new asset with Tripo** lets you choose the selected terrain or
   one explicit prefab terrain part. It never generates a whole course implicitly.
3. Open **My Tripo API connection** to connect your own API key. Studio/Web App
   subscription credits are **not** API credits. The editor clears the password
   field after submission; the Worker encrypts the stored key and never returns
   it to the browser.
4. Choose a name, prompt, seed, and generation method. **Texture the exact editor
   shape** sends a self-contained GLB made from the same outline/extrusion used
   by the renderer. **Generate a new low-poly 3D mesh** sends the prompt, seed,
   shape/dimensions/front-plane context, and polygon budget. Expand **Exact
   prompt sent to Tripo** to inspect the complete text. PBR textures are
   requested in either mode. Approve the
   explicit credit/data-sharing checkbox, then choose **Generate this asset**.
5. Jobs continue on the server when the page is closed. A completed job saves
   its GLB into R2 before becoming ready. **Select saved result** previews it;
   it does not automatically replace the current object or spend more credits.
6. Use **Object artwork / Apply artwork to this object** to attach a saved asset.
   Choose **Editor shape** to remove the assignment. **Editor preview** switches
   between the blockout and saved meshes; unassigned objects still use shapes.
   **Toggle collision overlay** reveals actual gripping edges.

New mesh generation does not promise an exact silhouette, topology, or useful
orientation. Mesh bounds fit the object's width, height, and depth. Review the
result before assigning it; texturing the existing shape is the safer path for
playable surfaces. Tripo pricing is provider-controlled and is not estimated
from a Studio subscription or a fixed price in this editor.

**Share an existing GLB** adds an already-authored asset without Tripo. Identical
binary files use the same SHA-256 asset ID and are stored once. Assets and variants
are immutable; publish another version rather than changing artwork underneath
existing courses. Only share artwork you have permission to distribute to the
other editor users and in game releases.

### Reusable prefab variants

Every ready-made obstacle has a **Ready-made artwork** sub-selection: editor
shapes or one of its published variants. Expand **Choose artwork for individual
parts / save a variant** to map saved assets to individual terrain parts.
Unassigned parts retain their normal shape.

Name the combination and **Publish prefab variant** to share it. Choosing a
variant and placing an obstacle creates ordinary editable level objects with
asset IDs, never a new generation. Mirroring reflects the artwork as well as the
collision outlines, including the ramp's swapped-axis transform. Changing a
variant choice does not retroactively change previously placed obstacles.

### Recovery and limits

There are at most four active submissions per user. Jobs are submitted once,
with request IDs protecting duplicate submissions. An interrupted submission
whose provider task ID is unknown is **not** automatically retried: check Tripo
before approving another paid task. If a task ID is known, **Resume retrieval
(no regeneration)** checks/downloads that same task.

Disconnecting or replacing a key is blocked while jobs are active. An attention
job may still exist in Tripo; reconnect the same account to retrieve it. A
provider-side cancellation/refund is not implied by closing the page, ignoring
a result, disconnecting, or an editor error. The integration does not expose an
unverified provider cancellation operation.

GLBs must be self-contained and uncompressed: no external URLs, Draco, Meshopt,
or KTX2. Course textures use PNG, JPEG, or WebP (convert AVIF first), allowing the
service and build to enforce decoded image budgets before a browser allocates
them. This restriction is specific to course artwork; character imports are
unchanged. Course artwork supports ordinary static meshes, not skeletons, morph
targets, or nested GPU instances. Per asset: 20 MiB, 16 meshes, 50,000 triangles,
and textures no larger than 4096 pixels. Per loaded course: 64 distinct assets,
64 MiB of GLBs, and 32 million decoded texture pixels. Course package import is
bounded to 96 MiB. The shared catalog holds up to 500 assets and 500 variants;
the host must archive unused entries deliberately before exceeding this cap.

Opaque placements share geometry/materials and are instanced in 32 m spatial
chunks. Only edited transforms and dirty chunk bounds are uploaded. Fades update
only active fading batches. Repeated placements do not duplicate textures or
regenerate assets.

## Portable courses and release selection

Ordinary **Export level JSON** saves artwork IDs, not GLB files. Named level
snapshots retain those same references. Use **Export course + artwork** for a
self-contained `course.json` containing the level, referenced GLBs, compatible
prefab variants, and the selected **Built game artwork** setting. Exported files
contain no API keys, private jobs, server connections, or editor code.

**Import course + share artwork** verifies embedded asset hashes, publishes
missing assets/variants into the current shared library, and imports the level.
It asks before sharing and before replacing an unsaved level. Shared uploads
that completed before a later network failure remain in the library; the
current level is not replaced until import succeeds.
Imports start in shapes preview so the previous course's GPU resources can be
released before loading another full asset budget. Choose **Saved meshes** to
inspect the new course.

```sh
# Use the release look saved in the package:
GAME_LEVEL=levels/course.json npm run build:game

# Explicitly override it:
GAME_LEVEL=levels/course.json GAME_ART_MODE=shapes npm run build:game
GAME_LEVEL=levels/course.json GAME_ART_MODE=meshes npm run build:game
```

`GAME_ART_MODE` also works with `npm run dev:game`. Plain level JSON and the
built-in course default to shapes. Mesh mode with asset IDs requires a package
containing those assets. Unknown modes, missing assets, invalid containers, and
content/hash mismatches fail instead of producing a misleading release.

Shape-only releases do not include GLBs, the GLTF loader, or the mesh-art renderer.
Mesh releases emit each referenced GLB once and load them before starting play.
Both remain editor-free and work without the authoring service. Deploy the game
with the unchanged `wrangler.game.toml`; never attach the editor's Access policy
to the public playable domain.

## Hosted setup

These steps create cloud resources and change the Workshop deployment; they are
not performed by `npm run build`. The existing static-only Workshop deployment
must be upgraded before the shared controls can connect.

1. In Cloudflare Zero Trust, create an **Access self-hosted application** covering
   the entire Workshop hostname, including `/api/art/*`. Set the allow policy for
   your intended editor users. Copy its team domain and application audience
   (AUD). The Worker verifies JWT signatures, issuer, audience, and expiry; it
   does not trust an email header or an unverified cookie.
2. Create storage:

   ```sh
   npx wrangler d1 create over-the-edge-art
   npx wrangler r2 bucket create over-the-edge-art
   ```

3. Put the returned D1 database ID in `wrangler.toml` as `database_id` (a
   fork replaces this deployment's ID with its own). Set `ACCESS_TEAM_DOMAIN` to your
   `your-team.cloudflareaccess.com` hostname (no scheme), and `ACCESS_AUD` to the
   Access application's audience. These are configuration, not Tripo API keys.
   Do **not** set `ART_LOCAL` in the hosted Worker.
4. Generate a cryptographically random 32-byte base64 encryption key and store
   it as a Worker secret. Do not paste it into source files:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" \
     | npx wrangler secret put ART_KEY_SECRET --config wrangler.toml
   ```

   Keep the secret stable. Replacing it makes existing encrypted connections
   unreadable; users will need to reconnect their Tripo keys.
5. Apply the schema and deploy:

   ```sh
   npx wrangler d1 migrations apply over-the-edge-art --remote --config wrangler.toml
   npm run build
   npx wrangler deploy --config wrangler.toml --keep-vars
   ```

The minute cron retrieves pending task results even with no browser open.
Requests only use the fixed Tripo API origin; GLB downloads allow HTTPS hosts
under `tripo3d.ai` and `tripo3d.com`, including validated redirects. If Tripo
changes its CDN host, a job reports an error rather than allowing arbitrary
server-side URL fetching. Review the new provider host before changing the
allowlist. Credentials are never forwarded to asset-download hosts.

All mutating requests require an exact same-origin request and the editor's
custom header, in addition to Access identity. The Worker returns no CORS
permission for other sites. R2 is private; downloads pass through Access. The
shared catalog is scoped to this Worker/Access application, not publicly readable
and not a cross-organization asset marketplace.

## Local development

`wrangler.local.toml` uses local D1/R2 and a loopback-only development identity.
It does not consume cloud storage or require Access sign-in. Set a generated
`ART_KEY_SECRET` in the ignored `.dev.vars` file; never put a real Tripo API key
there, because users connect their own keys in the editor.

```sh
npm run build
npx wrangler d1 migrations apply over-the-edge-art --local --config wrangler.local.toml
npm run dev:art
# In another terminal:
npm run dev
```

Open `http://localhost:5181`. Vite forwards `/api/art` to the Worker on
`127.0.0.1:8787`; the proxy only accepts loopback clients. Local Tripo generation
still calls the real paid API after explicit approval. `npm run preview` alone
serves the Workshop but does not run the shared backend; to exercise a built
Workshop with its backend, open `http://localhost:8787` instead.
Wrangler's local server does not automatically run the hosted cron. Keep the
jobs view open until the result is saved when generating locally; the deployed
Worker runs automatic background retrieval with the browser closed.

```sh
npm run verify:art
```

This uses isolated local D1/R2, signed test identities, mocked Tripo responses,
browser flows, a 1,000-terrain/600 m course with reused 3,072-triangle meshes,
illusion lifecycles, and both
release modes. It never submits paid generations or uses a user's API key.
