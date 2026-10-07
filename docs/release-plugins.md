# Release plugins

A plugin's **release facet** supplies the services only a release needs: signing players in and
granting access to the game's content, the game's own phantom backend, the library models each
player has, callbacks through the load, and shell notices and fatal errors. It runs only in
releases built with it, never in the Workshop or a [studio preview](#studio-previews). Its SDK is
[`src/plugins/release-sdk.ts`](../src/plugins/release-sdk.ts). [Plugins](plugins.md) describes the
manifest, points and verbs.

```sh
GAME_PLUGINS=games/my-game/plugins.json GAME_PROJECT=projects/my-game \
  GAME_CONTENT_URL=https://cdn.example.com/my-game/ npm run build:game
```

## The release facet

The facet module default-exports a `ReleaseFacet`, made with `defineRelease`: `start(host)`,
which returns the plugin's contributions, or a promise of them.

**`ReleaseHost`** (what `start` receives):

| Member | Meaning |
| --- | --- |
| `plugin` | The plugin's ID, from the manifest |
| `mount` | The element the release mounts its interface in; the plugin may add its own interface there |
| `contentUrl` | The build's content URL, absolute |
| `phantomsUrl` | The build's [phantom](phantoms.md) URL (`GAME_PHANTOMS_URL`), absolute; `null` without one |
| `signal` | Aborts when the release closes; see [the signal](#the-signal) |
| `notice(message, kind?)` | The release's notice, `info` or `error` |

## Start order

The release starts its release facets first, one at a time in manifest order, awaiting each
`start`, before it fetches anything: a plugin can sign the player in before the first grant is
asked for. It then composes their contributions, resolves `FATAL`, `NOTICES`, `ACCESS` and `FAILED`
once, and loads the game. In a build without phantoms it also resolves `PHANTOMS` against `null`, refusing only
a non-null result. Runtime facets start after that, once for each load attempt. In a build with
phantoms the optional consumer resolves `PHANTOMS` when it starts after the game loads; the
release session caches that slot for its whole life. Release notices and the fatal display live
across all load attempts.

## The signal

`host.signal` aborts when the release closes, for example on a development reload. Once every
release facet has started, the release session lives as long as the release, even after a fatal
load error, so a plugin's own interface, such as a sign-in or a buy link, stays. Remove what the
plugin added to the page when the signal aborts, and pass the signal to the plugin's own
requests.

If a `start` throws, the release stops with `plugin-failed`, naming the plugin, and the plugins
that started before it have their signals aborted, in reverse order.

## Access and sign-in

`ACCESS` is the release's **content access**: every file the release loads is granted through
it. Its base is `publicAccess(contentUrl)`, which serves every file publicly under the content
URL, without cookies. A game whose content only some players may load replaces it with access to
its own backend, which signs players in with the game's own identity management and grants the
release its content, typically as short-lived signed CDN URLs. The engine never sees accounts or
credentials.

- `grant(request, signal)` answers a request for one group's files with their URLs;
  [content delivery](content-delivery.md#grants) describes grants, their refusals and how the
  release uses them.
- `select(request, signal)`, optional, is the backend's choice of [library models](#library-models).

```ts
import { ACCESS, add, ContentError, defineRelease, FAILED, PROGRESS, replace } from '../../src/plugins/release-sdk';
import { showProgress, showSignIn } from './sign-in';

export default defineRelease({
  start(host) {
    return [
      replace(ACCESS, {
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
      }),
      add(PROGRESS, ({ loaded, total }) => showProgress(host.mount, loaded / total)),
      // Signs the player in, or offers the game, then loads again; any other failure stops the load.
      replace(FAILED, async (error) => {
        if (error.code !== 'unauthenticated' && error.code !== 'denied') throw error;
        await showSignIn(host.mount, error.code, host.signal);
      }),
    ];
  },
});
```

`./sign-in.ts` is the game's own interface: `showProgress` draws a loading bar in the release's
mount, and `showSignIn` shows a sign-in or a buy panel there, resolving once the player has
signed in or bought the game. A release built without `GAME_PLUGINS` contains no downstream code.
The shell is public, so a plugin holds no secrets: its backend does.

## Phantom backend

`PHANTOMS` is the release's [phantom](phantoms.md) service. Its engine base is the
[reference protocol](phantoms.md#the-protocol) client at the build's phantom URL, or `null`
without a URL.

In a phantom-enabled build, the optional consumer constructs the engine base and resolves the
slot through a resolver bound to the release session. The core release keeps the descriptor and the build-availability check,
not an import of the HTTP client or codec. In a build with no phantoms the core resolves against
`null` and refuses a non-null result, so a release with neither a phantom URL nor bundled
recordings includes no phantom client or playback code.

A plugin wraps the current service to extend it, for example with an availability notice:

```ts
import { defineRelease, PHANTOMS, PhantomServiceError, wrap } from '../../src/plugins/release-sdk';
import type { PhantomService } from '../../src/plugins/release-sdk';

export default defineRelease({
  start(host) {
    return [wrap(PHANTOMS, (base): PhantomService | null => {
      if (base === null) return null;
      return {
        submit: (course, recording, signal) => base.submit(course, recording, signal),
        async nearby(course, query, signal) {
          try {
            return await base.nearby(course, query, signal);
          } catch (error) {
            if (error instanceof PhantomServiceError && error.status === 401) {
              host.notice('Sign in to see other players\' phantoms.', 'info');
            }
            throw error;
          }
        },
      };
    })];
  },
});
```

- The reference client sends cookies to the same origin only. An answer other than 2xx fails
  as a `PhantomServiceError` with its HTTP `status`. The gated client is not exported by the
  SDK: `wrap(PHANTOMS, base => ...)` receives it, or an earlier plugin's service.
- A plugin can instead implement `PhantomService` itself, over any transport:
  - `submit(course, recording, signal)` hands over one recording;
  - `nearby(course, { x, y, limit }, signal)` resolves to recordings in the phantom format.
  Use `replace(PHANTOMS, service)` for its own authorization or transport. `PhantomService`,
  `PhantomQuery` and `PhantomServiceError` are lightweight SDK exports with no client or codec import.
- A non-null resolved service requires a release with a phantom URL or bundled recordings.
  A non-null result in a release with neither stops it before loading with `invalid-contribution`,
  naming the owner. A replacement or wrapper resolving to `null` remains valid.
- The release validates every recording a service sends, and nothing a service does stops the
  game; see [what a release does](phantoms.md#what-a-release-does).

## Load failures and progress

- **`FAILED`** holds `(error: ContentError) => Promise<void>`, which the release calls when its
  load fails with a `ContentError`, such as a refused grant. Resolve to load the whole game again,
  for example once the player has signed in or bought the game; reject to stop with the rejection
  shown. Its base rejects with the error, so a release without one stops and shows it. Any other
  error stops the release at once.
- **`PROGRESS`** callbacks hear `{ loaded, total }` (`ContentProgress`) as the boot downloads
  arrive: the bytes loaded so far before play, and the bytes of every download started so far,
  which grow as the release learns what it needs. These callbacks finish synchronously;
  a promise-like return is `invalid-contribution`.

A plugin listed after the one in [access and sign-in](#access-and-sign-in) can build on its
`FAILED` rather than replace it. This one offers the game to a player who does not own it, and
leaves every other failure to the plugins before it:

```ts
import { defineRelease, FAILED, wrap } from '../../src/plugins/release-sdk';
import { offerGame } from './store';

export default defineRelease({
  start(host) {
    return [wrap(FAILED, (previous) => async (error) => {
      if (error.code !== 'denied') return previous(error);
      await offerGame(host.mount, host.signal);
    })];
  },
});
```

## Ready and the release API

`READY` callbacks run in manifest order as the game starts, once it has loaded; not if it stopped
while loading. They finish synchronously; a promise-like return is `invalid-contribution`.
Each plugin's callbacks receive its own `ReleaseApi`:

| Member | Meaning |
| --- | --- |
| `setPause(paused)` | Pauses or resumes the game under the plugin's own reason, `release:<plugin>`, so it never undoes the game's pauses or another plugin's |
| `setInputBlock(blocked)` | Blocks or unblocks the game's input under the same reason |
| `halted` | Whether the game has stopped on an error |
| `modelLibrary` | The [library models](#library-models) the player can swap to |

Pause requests always update the plugin's reason. Only a transition between running and paused
settles interpolation, clears movement and changes audio; redundant requests do not interrupt play.
After the game stops or is disposed, input-block requests are ignored. Pause reasons can still
change, but cannot resume a stopped game.

A store panel of the game's own, which pauses the game while it is open:

```ts
import { add, defineRelease, READY } from '../../src/plugins/release-sdk';

export default defineRelease({
  start(host) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Store';
    const panel = document.createElement('div');
    panel.hidden = true;
    host.signal.addEventListener('abort', () => {
      button.remove();
      panel.remove();
    });
    return [add(READY, (api) => {
      button.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        api.setPause(!panel.hidden);
      }, { signal: host.signal });
      host.mount.append(button, panel);
    })];
  },
});
```

## Library models

A release shows [library models](characters.md#model-library-and-runtime-swaps) in place of the
characters' own only as the game's backend selects them, through `select(request, signal)` on
the plugin's content access. That page describes the selection's contract, swaps and what
shows. A build packages the model library only when a plugin has a release facet, and never for
a studio preview.

```ts
import { ACCESS, add, defineRelease, MODEL_FAILED, READY, replace } from '../../src/plugins/release-sdk';
import { backend } from './backend';
import { shop } from './shop';

export default defineRelease({
  start(host) {
    return [
      replace(ACCESS, {
        grant: (request, signal) => backend.grant(request, signal),
        // Checks the player's entitlements, stores the result and answers it.
        select: (request, signal) => backend.select(request, signal),
      }),
      add(MODEL_FAILED, (error) => host.notice(error.message, 'error')),
      // The shop relays the player's choices and shows each swap's answer or refusal.
      add(READY, (api) => shop.onEquip((role, id) => api.modelLibrary.swap(role, id))),
    ];
  },
});
```

- **`MODEL_FAILED`** callbacks hear of a part that could not follow the backend's selection when
  no swap asked for it. At boot, when the selection cannot be read or a selected model cannot
  load, the part starts with the profile's own model; later, it keeps the model it shows.
- **`api.modelLibrary`** (`ModelLibraryApi`) relays the player's choices:

| Member | Meaning |
| --- | --- |
| `available(role)` | The library's IDs for one part: `avatar`, `hammer` or `pot` |
| `active(role)` | The library model the part shows, or `null` for the profile's own |
| `swap(role, id)` | Asks the backend to use `id`, or the profile's own model for `null`, for one part; resolves with the selection in use once the backend's answer shows |
| `refresh()` | Reads the backend's selection again, for example after it changed elsewhere |

## Notices

`NOTICES` is the release slot `release.notices`, holding a `NoticesFactory`,
`(mount: HTMLElement) => Notices`. The contract and default are exported from the release SDK;
the instance contract is declared in [`src/notice.ts`](../src/notice.ts) and checked by the kernel:

```ts
interface Notices {
  show(text: string, kind: 'info' | 'error'): void;
  dispose(): void;
}
```

Notices are release-shell chrome, not one Game's presentation. They serve release sign-in,
content loading, runtime notices, the gap between load attempts and the period after a fatal
error. A release facet replaces or wraps `NOTICES`; runtime facets do not contribute to it.

`DEFAULT_NOTICES` calls `createNotice`: the dismissible live-region notice, with **A QUICK
NOTE** for `info` and **NEEDS ATTENTION** for `error`. The play UI starts with that engine
instance, so release facets can call `host.notice` while their `start` is still running. Once
the release facets have composed, `Release.run()` resolves the point with `DEFAULT_NOTICES` as
its base and the play UI swaps once if the resolved factory differs. With the unchanged default
the boot instance stays. The selected instance is neither cleared nor replaced between Games
or load attempts; it is disposed only when the release closes.

`show` is event-driven: no per-frame update or idle animation loop. Use only nodes you append
to `mount`, preserve the distinction between info and errors and make errors accessible.
`dispose` removes those nodes and listeners. Creating an instance checks both required methods:
a malformed object fails with `invalid-contribution`, and a throwing factory fails with
`plugin-failed`, each naming the release plugin and `release.notices`.
The factory, `show` and `dispose` finish synchronously; a promise-like result is
`invalid-contribution`.

The Workshop keeps its engine notices. Studio previews have no release facets and therefore
also keep `DEFAULT_NOTICES`.

## Fatal display

`FATAL` is the release slot `release.fatal`, holding a `FatalDisplayFactory`,
`(element: HTMLElement) => FatalDisplay`. A release facet uses `replace(FATAL, factory)` or
`wrap(FATAL, decorate)`. The contract and default are exported from the release SDK; the instance
contract is declared in [`src/fatal-display.ts`](../src/fatal-display.ts) and checked by the kernel:

```ts
interface FatalDisplay {
  show(message: string): void;
  dispose?(): void;
}
```

`element` is the page's `#fatal-error` element, with `role="alert"`. `show` receives the complete
message, including **The game could not load:** for release load failures or **The game
stopped:** for a stopped Game. The display owns how that message appears; make errors visible
and accessible. `DEFAULT_FATAL` unhides the element and sets its text to the message, exactly
as the engine did before the point existed.

The release starts with the engine's display, so a failure before release facets compose,
including a throwing `start`, still has a fatal writer. After `ReleasePlugins.start` succeeds,
`Release.run()` resolves `FATAL` once with `DEFAULT_FATAL` as its base, before resolving the
other services. If the factory is unchanged the initial engine instance stays; otherwise the
resolved factory creates the release's display. A malformed object fails with
`invalid-contribution`, and a throwing factory fails with `plugin-failed`, naming the release
plugin and `release.fatal`. A failed resolution or construction stops startup, rather than
loading with a masking default.

The chosen display handles both the release's own fatal paths and its Games' `onFatal`
callback. It is neither cleared nor replaced between load attempts or Games, and remains
available after a fatal error. Optional `dispose()` runs when the release closes, before its
facet signals abort; release listeners and any nodes added by the display there. `show` is
event-driven, with no per-frame update or idle animation loop.
The factory, `show` and optional `dispose` finish synchronously; a promise-like result is
`invalid-contribution`.

Studio previews have no release facets and keep `DEFAULT_FATAL`. The Workshop passes its own
`#fatal-error` writer to Game's `onFatal` option and keeps the engine's text display; runtime facets
cannot contribute to `FATAL`.

## Studio previews

A [studio preview](plugins.md#studio-previews), which the project server's **Publish** builds,
drops every release facet: `virtual:game-plugins/release` lists none. The preview therefore uses
public access to its own content and the engine's notices and fatal display, has no phantom
backend and packages no library models, while the game's kinds and runtime facets still run.
Try a release facet with `npm run dev:game` or a release build instead.

## Errors

- A default export that is not an object with `start(host)` fails with `invalid-facet`, naming
  the plugin.
- A `start` that throws, or rejects, fails with `plugin-failed`, naming the plugin.
- Contributions that break the rules fail with their [codes](plugins.md#errors), naming the
  plugin and the point. `ACCESS` refuses access without `grant()`, or with a `select` that is not
  a function, `PHANTOMS` a service without `submit()` and `nearby()`, `NOTICES` a factory
  whose instance does not provide `show(text, kind)` and `dispose()`, and `FATAL` a factory
  whose instance lacks `show(message)` or supplies a non-function `dispose`.
- An error a `PROGRESS`, `MODEL_FAILED` or `READY` callback throws fails with `plugin-failed`,
  naming the executing plugin, point and action. These callbacks, wrapping functions, factories
  and all notices/fatal-display methods are synchronous; a promise-like result is
  `invalid-contribution`. A `PluginError` already attributed to that same plugin and point
  passes through; errors from another plugin, point or the engine acquire the executing
  plugin's attribution and retain the original cause.
- `start` may return a promise. `ACCESS`, `FAILED` and `PHANTOMS` retain their asynchronous
  content and phantom error semantics; in particular, `FAILED` may reject with the original
  `ContentError` to stop a load.

The release shows a fatal error as it stops: "The game could not load", and why. Once every
release facet has started, the session keeps running until the release closes, so the plugins'
own interface stays.
