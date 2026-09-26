import './game-shell.css';
import './play.css';
import level from 'virtual:game-level';
import settings from 'virtual:game-settings';
import sprites from 'virtual:game-sprites';
import alternateSprites from 'virtual:game-alternate-sprites';
import characterModels from 'virtual:game-character-models';
import loadArtwork from 'virtual:game-art';
import { Game } from './game';
import { createPlayUI } from './play-ui';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const game = new Game({
  canvas, fatal, eventMount: mount, level, settings, characterModels,
  onAction: (action, options) => game.perform(action, options),
  onNotice: (message) => ui.notice(message, 'error'),
});
const ui = createPlayUI({
  mount,
  characters: alternateSprites === null ? null : {
    types: [sprites.characterRiggingType, alternateSprites.characterRiggingType],
    onSelect: (index) => { if (!game.halted) game.selectCharacter(index); },
  },
});
game.setInputBlock({ reason: 'sprite-loading', blocked: true });

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => { ui.dispose(); game.dispose(); });
}

try {
  // Both profiles load once, before play; switching later only changes the presentation.
  await Promise.all([
    game.loadSprites(sprites),
    ...(alternateSprites === null ? [] : [game.loadAlternateSprites(alternateSprites)]),
    loadArtwork(game),
  ]);
  if (!game.halted) {
    game.selectCharacter(ui.enableCharacters());
    game.setInputBlock({ reason: 'sprite-loading', blocked: false });
    game.start(ui.update);
  }
} catch (error) {
  if (!game.halted || !(error instanceof DOMException) || error.name !== 'AbortError') throw error;
}
