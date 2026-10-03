// A bounded, headless diagnostic for one no-input diagonal ground hold. No HTTP server, authored
// content writes or browser interaction. Run only with approval for this physics reproduction.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values } = parseArgs({ options: {
  project: { type: 'string' },
  output: { type: 'string' },
  iterations: { type: 'string', default: '64' },
  continuous: { type: 'string', default: 'on' },
  guideScale: { type: 'string', default: '1' },
  scenario: { type: 'string', default: 'hold' },
} });
if (!values.project || !values.output) throw new Error('Pass --project <project.json> and --output <trace.json>.');
const iterations = Number(values.iterations);
const guideScale = Number(values.guideScale);
if (![64, 1024].includes(iterations) || ![1, 100].includes(guideScale)) {
  throw new Error('Diagnostic iterations must be 64 or 1024; guideScale must be 1 or 100.');
}
if (!['on', 'off'].includes(values.continuous)) throw new Error('Pass --continuous on or off.');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STEPS = 240 * 16;
const ZERO_INPUT = Object.freeze({ x: 0, y: 0 });
const scenarios = {
  hold: () => ({ schemaVersion: 5, labels: [], objects: [
    { kind: 'start', id: 'start', x: 0, y: 1.1, angle: -Math.PI / 4, reach: 1.8 },
    { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1,
      width: 80, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false, surface: 'rock' },
  ] }),
  air: () => ({ schemaVersion: 5, labels: [], objects: [
    { kind: 'start', id: 'start', x: 0, y: 1.1, angle: -Math.PI / 4, reach: 1.8 },
  ] }),
};
const scenario = scenarios[values.scenario];
if (!scenario) throw new Error('Pass --scenario hold or air.');
const projectBytes = await readFile(values.project);
const project = JSON.parse(projectBytes);
const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, watch: null } });
let simulation;
try {
  const { Simulation } = await server.ssrLoadModule('/src/simulation.ts');
  const { PHYSICS } = await server.ssrLoadModule('/src/config.ts');
  const { validateLevel } = await server.ssrLoadModule('/src/level.ts');
  simulation = new Simulation(project.settings, validateLevel(scenario()));
  simulation.world.setContinuousPhysics(values.continuous === 'on');
  // Diagnostic-only interventions. The source controller and live project are never changed.
  const step = simulation.world.step.bind(simulation.world);
  simulation.world.step = (dt) => step(dt, iterations, PHYSICS.positionIterations);
  const rig = simulation.rig;
  for (const body of [rig.carrier, rig.sliderBody]) {
    const data = { mass: 0, center: { x: 0, y: 0 }, I: 0 };
    body.getMassData(data);
    body.setMassData({ ...data, I: data.I * guideScale });
  }
  let toiEvents = 0;
  const solver = simulation.world.m_solver;
  const solveTOI = solver.solveIslandTOI;
  solver.solveIslandTOI = function (...args) { toiEvents++; return solveTOI.apply(this, args); };
  const records = [];
  for (let index = 0; index < STEPS; index++) {
    const beforeTOI = toiEvents;
    simulation.step(ZERO_INPUT);
    const snapshot = simulation.snapshot();
    let weldPositionError = 0;
    let weldAngleError = 0;
    for (const weld of rig.welds) {
      const a = weld.getAnchorA();
      const b = weld.getAnchorB();
      weldPositionError = Math.max(weldPositionError, Math.hypot(a.x - b.x, a.y - b.y));
      weldAngleError = Math.max(weldAngleError,
        Math.abs(weld.getBodyB().getAngle() - weld.getBodyA().getAngle()));
    }
    records.push({ time: snapshot.time, root: snapshot.root, rootVelocity: snapshot.rootVelocity,
      tip: snapshot.tip, cursorOffset: snapshot.cursorOffset, targetOffset: snapshot.targetOffset,
      potAngle: snapshot.potAngle, extension: snapshot.extension, headContacts: snapshot.headContacts,
      hingeTorque: snapshot.hingeTorque, sliderForce: snapshot.sliderForce, command: snapshot.command,
      hingeSpeed: rig.hinge.getJointSpeed(), sliderSpeed: rig.slider.getJointSpeed(),
      motorResidual: rig.hinge.getJointSpeed() - snapshot.command.angularSpeed,
      weldPositionError, weldAngleError, toiEvents: toiEvents - beforeTOI });
  }
  await writeFile(values.output, JSON.stringify({
    projectHash: createHash('sha256').update(projectBytes).digest('hex'),
    parameters: { iterations, continuous: values.continuous, guideScale, scenario: values.scenario,
      dt: PHYSICS.dt, steps: STEPS }, settings: project.settings,
    final: simulation.snapshot(), records,
  }));
  console.log(JSON.stringify({ trace: values.output, steps: STEPS, toiEvents,
    finalRoot: simulation.snapshot().root, finalContacts: simulation.snapshot().headContacts }));
} finally {
  simulation?.dispose();
  await server.close();
}
