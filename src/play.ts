import './game.css';
import level from 'virtual:game-level';
import { Game } from './game';
import { createGameUI } from './game-ui';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const game = new Game({
  canvas, fatal, level,
  onAction: (action, options) => game.perform(action, options),
  onNotice: (message) => ui.notice(message, 'error'),
});
const ui = createGameUI({
  mount, initialInputMode: game.input.mode,
  onAction: (action, options) => game.perform(action, options),
});
game.start(ui.update);

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => { ui.dispose(); game.dispose(); });
}
