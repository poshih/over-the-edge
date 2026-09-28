import './game-shell.css';
import './play.css';
import pins from 'virtual:game-content';
import createCharacterModels from 'virtual:game-character-models';
import loadCourseArt from 'virtual:game-art';
import loadAppearance from 'virtual:game-appearance';
import AudioDirector from 'virtual:game-audio';
import start from 'virtual:game-module';
import { Release } from './release';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const release = new Release({ canvas, mount, fatal }, { pins, createCharacterModels, loadCourseArt, loadAppearance, AudioDirector, start });
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => release.dispose());
}
await release.run();
