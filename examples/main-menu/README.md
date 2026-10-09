# Main menu example

A release plugin that gives a game its own main menu through the release's `MENU` point: a title
screen with **Continue**, **New game** and **Settings**, and a pause menu over play. It shows how a
game's menu drives the release's `MenuApi` to start a game, continue the player's saved climb and
change the player's settings. [Release plugins](../../docs/release-plugins.md#main-menu) describes
the API.

| File | What it shows |
| --- | --- |
| `plugins.json` | The manifest: one plugin, `main-menu`, with a release facet |
| `release.ts` | The release facet: `replace(MENU, createMainMenu)` |
| `menu.ts` | The menu: `newGame()`, `continueGame()`, `pause()`, `resume()`, `saved`, `settings` and `changeSettings()` |
| `menu.css` | Its look, in the release shell's colours |

Run it with the built-in course or any project, then open **http://localhost:5182**:

```sh
GAME_PLUGINS=examples/main-menu/plugins.json npm run dev:game
GAME_PLUGINS=examples/main-menu/plugins.json GAME_PROJECT=examples/projects/ashen-ascent npm run dev:game
```

- The game loads behind the title screen and waits there. **New game** starts from the level's
  start and captures the mouse; with a climb saved, it asks first.
- While you play, the release saves your climb every few seconds, as the menu pauses and as the
  page hides. Reload the page and **Continue** takes it up where you left off.
- **Escape** releases the mouse, as in any release; press it again, or select **Menu** at the
  bottom of the screen, for the pause menu: **Resume**, **Settings** and **Main menu**.
- **Settings** changes the volume, the control sensitivity and, in a game with two characters,
  the character. They apply at once and the browser keeps them.

A release facet runs only in releases: the Workshop and studio previews play without the menu. A
release build includes it the same way:

```sh
GAME_PLUGINS=examples/main-menu/plugins.json GAME_PROJECT=examples/projects/ashen-ascent npm run build:game
```
