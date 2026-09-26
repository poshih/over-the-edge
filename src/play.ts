import './game-shell.css';
import './play.css';
import level from 'virtual:game-level';
import settings from 'virtual:game-settings';
import sprites from 'virtual:game-sprites';
import alternateSprites from 'virtual:game-alternate-sprites';
import characterModels from 'virtual:game-character-models';
import loadArtwork from 'virtual:game-art';
import presentation from 'virtual:game-presentation';
import loadAppearance from 'virtual:game-appearance';
import createAudio from 'virtual:game-audio';
import media from 'virtual:game-media';
import { Game } from './game';
import { createPlayUI } from './play-ui';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

// Bundled project media replace their authored /media/ paths; other sources load as written.
const resolveMedia = (source: string): string => Object.hasOwn(media, source) ? media[source]! : source;
const audio = createAudio?.({ resolve: resolveMedia, onError: (message) => ui.notice(message, 'error') }) ?? null;
const game = new Game({
  canvas, fatal, eventMount: mount, level, settings, characterModels,
  theme: presentation.theme, enemyArt: presentation.enemies, resolveMedia,
  onCue: audio === null ? undefined : (cue) => audio.handle(cue),
  onAction: (action, options) => game.perform(action, options),
  onNotice: (message) => ui.notice(message, 'error'),
});
game.setCharacter({ armIk: presentation.armIk });
const ui = createPlayUI({
  mount,
  hud: presentation.hud,
  characters: alternateSprites === null ? null : {
    types: [sprites.characterRiggingType, alternateSprites.characterRiggingType],
    onSelect: (index) => { if (!game.halted) game.selectCharacter(index); },
  },
});
game.setInputBlock({ reason: 'sprite-loading', blocked: true });

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => { audio?.dispose(); ui.dispose(); game.dispose(); });
}

try {
  // Both profiles load once, before play; switching later only changes the presentation.
  await Promise.all([
    game.loadSprites(sprites),
    ...(alternateSprites === null ? [] : [game.loadAlternateSprites(alternateSprites)]),
    loadArtwork(game),
    ...(loadAppearance === null ? [] : [loadAppearance(game.view.visuals)]),
  ]);
  if (!game.halted) {
    game.selectCharacter(ui.enableCharacters());
    game.setInputBlock({ reason: 'sprite-loading', blocked: false });
    game.start((state) => {
      ui.update(state);
      audio?.setPaused(state.paused);
    });
  }
} catch (error) {
  if (!game.halted || !(error instanceof DOMException) || error.name !== 'AbortError') throw error;
}
