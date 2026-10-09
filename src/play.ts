import './game-shell.css';
import './play.css';
import pins, { course } from 'virtual:game-content';
import createCharacterModels from 'virtual:game-character-models';
import loadCourseArt from 'virtual:game-art';
import loadAppearance from 'virtual:game-appearance';
import audioOutput from 'virtual:game-audio';
import createDecorations from 'virtual:game-decorations';
import phantoms from 'virtual:game-phantoms';
import kinds from 'virtual:game-plugins/kinds';
import runtimePlugins from 'virtual:game-plugins/runtime';
import releasePlugins from 'virtual:game-plugins/release';
import { Release } from './release';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const release = new Release({ canvas, mount, fatal }, {
  pins, course, createCharacterModels, loadCourseArt, loadAppearance, audioOutput, createDecorations, phantoms,
  kinds, runtimePlugins, releasePlugins,
});
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => release.dispose());
}
await release.run();
