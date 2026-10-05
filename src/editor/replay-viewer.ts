import type { Point } from '../config';
import { element, setPressed, setText } from '../dom';
import { decodePhantom, PhantomError } from '../phantom-format';
import type { PhantomPose, PhantomTrack } from '../phantom-format';
import { ProjectApiError } from './project-client';
import type { LevelVersionSummary, PhantomSummary } from './project-client';
import type { PlayedVersion } from './project-session';

// Where the viewer finds recordings: the open server project's level versions.
export interface ReplaySource {
  project(): string | null;
  played(): PlayedVersion | null;
  subscribe(listener: () => void): () => void;
  versions(project: string): Promise<readonly LevelVersionSummary[]>;
  recordings(project: string, version: number): Promise<readonly PhantomSummary[]>;
  recording(project: string, version: number, name: string, signal: AbortSignal): Promise<Uint8Array>;
}

// The figure the viewer poses: the engine playback's held slot (PhantomPlayback.hold), drawn by the runtime look.
export interface ReplayFigure {
  hold(track: PhantomTrack | null, seconds: number, continues?: boolean): Readonly<PhantomPose> | null;
}

export interface ReplayViewer {
  // Showing the Level tab lists the recordings; leaving it pauses and hides the ghost.
  setActive(active: boolean): void;
  // The designer moved the view, so the camera stops following the ghost.
  stopFollowing(): void;
  dispose(): void;
}

// A run: one play session's clips on one version, in order, as the Workshop recorded them.
interface Run {
  readonly session: string;
  readonly clips: readonly { readonly name: string; readonly clip: number }[];
  // When its first clip was stored, in milliseconds.
  readonly savedAt: number;
}

interface LoadedRun {
  readonly key: string;
  readonly tracks: readonly PhantomTrack[];
  // Each track's clip number, and where it starts in the run, in seconds.
  readonly clips: readonly number[];
  readonly offsets: readonly number[];
  readonly duration: number;
  // The course it was recorded on, which the played version's may differ from.
  readonly course: string;
}

const RECORDING = /^v([1-9][0-9]*)-([0-9a-f]{32})-(0|[1-9][0-9]*)\.phantom$/;
const SPEEDS = [0.5, 1, 2, 4] as const;
// Real seconds one frame may advance playback, so a hidden tab coming back does not jump.
const MAX_FRAME_SECONDS = 0.1;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function expected(error: unknown): error is Error {
  return error instanceof ProjectApiError || error instanceof SyntaxError;
}

/**
 * The Level tab's replays: the runs the Workshop recorded on each saved level version of the open project, played back
 * as a phantom over the current level, with the camera following it. Playback keeps its own time, as the game is paused
 * while the Level tab is open, and runs a frame loop only while playing.
 */
export function createReplayViewer(options: {
  readonly mount: HTMLElement;
  readonly signal: AbortSignal;
  readonly source: ReplaySource;
  readonly figure: ReplayFigure;
  // Centres the view on a point, keeping its zoom.
  readonly follow: (point: Readonly<Point>) => void;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
}): ReplayViewer {
  const { source, figure, signal } = options;
  const listen = { signal };
  const root = options.mount;
  root.classList.add('level-replays');
  root.innerHTML = `
    <div class="snapshot-history">
      <label for="level-replay-version">Version</label>
      <div class="tuning-profile-row">
        <select id="level-replay-version"></select>
        <button type="button" class="button level-replay-refresh">Refresh</button>
      </div>
      <label for="level-replay-run">Run</label>
      <select id="level-replay-run"></select>
    </div>
    <div class="level-action-row level-replay-controls">
      <button type="button" class="button button-primary level-replay-play">Play</button>
      <button type="button" class="button level-replay-follow" aria-pressed="true"
        title="Keep the camera on the ghost; moving the view turns this off">Follow</button>
    </div>
    <label class="level-field level-replay-speed" for="level-replay-speed">Speed
      <select id="level-replay-speed">${SPEEDS.map((speed) => `<option value="${speed}"${speed === 1 ? ' selected' : ''}>${speed}×</option>`).join('')}</select>
    </label>
    <div class="tuning-field level-replay-position">
      <div class="tuning-label-row">
        <label for="level-replay-position">Position</label><output class="level-replay-time" for="level-replay-position"></output>
      </div>
      <input id="level-replay-position" type="range" min="0" max="0" step="0.1" value="0" />
    </div>
    <p class="level-help level-replay-status" role="status" aria-live="polite"></p>
  `;
  const versionList = element<HTMLSelectElement>(root, '#level-replay-version');
  const runList = element<HTMLSelectElement>(root, '#level-replay-run');
  const refreshButton = element<HTMLButtonElement>(root, '.level-replay-refresh');
  const playButton = element<HTMLButtonElement>(root, '.level-replay-play');
  const followButton = element<HTMLButtonElement>(root, '.level-replay-follow');
  const speedList = element<HTMLSelectElement>(root, '#level-replay-speed');
  const seek = element<HTMLInputElement>(root, '#level-replay-position');
  const time = element<HTMLOutputElement>(root, '.level-replay-time');
  const status = element<HTMLParagraphElement>(root, '.level-replay-status');

  let active = false;
  let disposed = false;
  // Versions with recordings, newest first, and the selected version's runs, newest first.
  let versions: readonly LevelVersionSummary[] = [];
  let runs: readonly Run[] = [];
  // The project the lists were last made for, null before the first, and the course their labels compare with.
  let listedFor: { readonly project: string | null } | null = null;
  let labelledFor: string | null = null;
  // Requests in flight, and the newest listing, whose answers alone count.
  let listing = 0;
  let generation = 0;
  let problem: string | null = null;
  let loading: AbortController | null = null;
  let loaded: LoadedRun | null = null;
  let position = 0;
  // The clip shown, and the tenth of a second the time readout shows.
  let cursor = 0;
  let shownTenth = -1;
  let playing = false;
  let following = true;
  let speed = 1;
  let frame = 0;
  let last = 0;

  const selectedVersion = (): LevelVersionSummary | undefined => versions.find((entry) => String(entry.version) === versionList.value);
  const selectedRun = (): Run | undefined => runs.find((run) => run.session === runList.value);
  const runKey = (project: string, version: number, run: Run): string => `${project}/${version}/${run.session}/${run.clips.length}`;

  function render(): void {
    const project = source.project();
    versionList.disabled = versions.length === 0;
    runList.disabled = runs.length === 0;
    refreshButton.disabled = project === null || listing > 0;
    playButton.disabled = loading !== null || (loaded === null && selectedRun() === undefined);
    setText(playButton, playing ? 'Pause' : 'Play');
    setPressed(followButton, following);
    seek.disabled = loaded === null;
    seek.max = String(loaded?.duration ?? 0);
    if (loaded === null) setText(time, '');
    const played = source.played();
    setText(status, project === null ? 'Open or save a server project in Project to watch the play recorded on its level.'
      : problem !== null ? problem
        : versions.length === 0 ? listing > 0 ? 'Looking for recordings…' : 'No recordings yet. With Record on, play a saved version of the level.'
          : runs.length === 0 ? listing > 0 ? 'Looking for runs…' : 'This version has no recordings left; choose Refresh.'
            : loading !== null ? `Loading ${plural(selectedRun()?.clips.length ?? 0, 'clip')}…`
              : loaded !== null && played !== null && loaded.course !== played.course
                ? 'Recorded on another layout or physics: the ghost may pass through what changed.'
                : 'The ghost replays the run over the current level.');
  }

  function fillVersions(): void {
    const played = source.played();
    labelledFor = played?.course ?? null;
    const keep = versionList.value;
    versionList.replaceChildren(...(versions.length === 0 ? [new Option('No recordings', '')] : versions.map((entry) => {
      const course = played === null ? '' : entry.course === played.course ? ' · plays as now' : ' · other layout or physics';
      return new Option(`Version ${entry.version} · ${plural(entry.recordings, 'recording')}${course}`, String(entry.version));
    })));
    const choice = versions.find((entry) => String(entry.version) === keep) ?? versions.find((entry) => entry.version === played?.version) ?? versions[0];
    versionList.value = choice === undefined ? '' : String(choice.version);
  }

  function fillRuns(): void {
    const keep = runList.value;
    runList.replaceChildren(...(runs.length === 0 ? [new Option('No runs', '')]
      : runs.map((run) => new Option(`${when(run.savedAt)} · ${plural(run.clips.length, 'clip')}`, run.session))));
    runList.value = runs.some((run) => run.session === keep) ? keep : runs[0]?.session ?? '';
  }

  // Lists the open project's versions with recordings, then the chosen version's runs.
  async function refresh(): Promise<void> {
    const current = ++generation;
    const project = source.project();
    listedFor = { project };
    if (loaded !== null && !loaded.key.startsWith(`${project}/`)) unload();
    if (project === null) {
      versions = [];
      runs = [];
      problem = null;
      fillVersions();
      fillRuns();
      render();
      return;
    }
    listing++;
    render();
    let next: readonly LevelVersionSummary[] = [];
    let failure: string | null = null;
    try {
      next = (await source.versions(project)).filter((entry) => entry.recordings > 0).reverse();
    } catch (error) {
      if (!expected(error)) throw error;
      failure = `Recordings could not be listed: ${error.message}`;
    } finally {
      listing--;
    }
    if (disposed || current !== generation) return;
    versions = next;
    problem = failure;
    fillVersions();
    await refreshRuns(current);
  }

  async function refreshRuns(current = ++generation): Promise<void> {
    const project = source.project();
    const version = selectedVersion();
    if (project === null || version === undefined) {
      runs = [];
      fillRuns();
      render();
      return;
    }
    listing++;
    render();
    let list: readonly PhantomSummary[] = [];
    let failure: string | null = null;
    try {
      list = await source.recordings(project, version.version);
    } catch (error) {
      if (!expected(error)) throw error;
      failure = `Runs could not be listed: ${error.message}`;
    } finally {
      listing--;
    }
    if (disposed || current !== generation) return;
    problem = failure;
    const sessions = new Map<string, { clips: { name: string; clip: number }[]; savedAt: number }>();
    for (const recording of list) {
      const match = RECORDING.exec(recording.name);
      if (match === null || Number(match[1]) !== version.version) continue;
      const session = sessions.get(match[2]!) ?? { clips: [], savedAt: Infinity };
      session.clips.push({ name: recording.name, clip: Number(match[3]) });
      session.savedAt = Math.min(session.savedAt, Date.parse(recording.savedAt));
      sessions.set(match[2]!, session);
    }
    runs = [...sessions].map(([session, run]) => ({ session, clips: run.clips.sort((a, b) => a.clip - b.clip), savedAt: run.savedAt }))
      .sort((a, b) => b.savedAt - a.savedAt);
    fillRuns();
    render();
  }

  // Downloads and decodes a run's clips; null when it was cancelled or failed, which a notice says.
  async function load(project: string, version: LevelVersionSummary, run: Run): Promise<LoadedRun | null> {
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    render();
    try {
      const bytes = await Promise.all(run.clips.map((clip) => source.recording(project, version.version, clip.name, controller.signal)));
      const tracks: PhantomTrack[] = [];
      const clips: number[] = [];
      const offsets: number[] = [];
      let duration = 0;
      for (const [index, recording] of bytes.entries()) {
        let track: PhantomTrack;
        try {
          track = decodePhantom(recording);
        } catch (error) {
          if (!(error instanceof PhantomError)) throw error;
          options.onNotice(`Skipped ${run.clips[index]!.name}: ${error.message}`, 'error');
          continue;
        }
        tracks.push(track);
        clips.push(run.clips[index]!.clip);
        offsets.push(duration);
        duration += track.duration;
      }
      if (tracks.length === 0) return null;
      return { key: runKey(project, version.version, run), tracks, clips, offsets, duration, course: version.course };
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (!expected(error)) throw error;
      options.onNotice(`The run could not be loaded: ${error.message}`, 'error');
      return null;
    } finally {
      if (loading === controller) loading = null;
      if (!disposed) render();
    }
  }

  // Shows the run at `position`; `smooth` when playback moved it on from the previous frame.
  function show(smooth: boolean): void {
    const run = loaded!;
    let index = Math.min(cursor, run.tracks.length - 1);
    if (run.offsets[index]! > position) index = 0;
    while (index < run.tracks.length - 1 && run.offsets[index + 1]! <= position) index++;
    // A run's next clip starts where the previous one ended, unless the clip between was dropped.
    const continues = smooth && index === cursor + 1 && run.clips[index] === run.clips[cursor]! + 1;
    cursor = index;
    const pose = figure.hold(run.tracks[index]!, position - run.offsets[index]!, continues);
    if (pose !== null && following) options.follow(pose);
    const tenth = Math.floor(position * 10);
    if (tenth === shownTenth) return;
    shownTenth = tenth;
    seek.value = String(position);
    setText(time, `${position.toFixed(1)} / ${run.duration.toFixed(1)} s · clip ${index + 1} of ${run.tracks.length}`);
  }

  function tick(now: number): void {
    frame = 0;
    if (!playing || loaded === null) return;
    position = Math.min(loaded.duration, position + Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000)) * speed);
    last = now;
    show(true);
    if (position >= loaded.duration) {
      setPlaying(false);
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function setPlaying(next: boolean): void {
    playing = next;
    if (next && frame === 0) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    } else if (!next && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    render();
  }

  function unload(): void {
    setPlaying(false);
    loading?.abort();
    loaded = null;
    position = 0;
    cursor = 0;
    shownTenth = -1;
    figure.hold(null, 0);
    render();
  }

  async function togglePlay(): Promise<void> {
    if (playing) {
      setPlaying(false);
      return;
    }
    const project = source.project();
    const version = selectedVersion();
    const run = selectedRun();
    if (project === null || version === undefined || run === undefined || loading !== null) return;
    if (loaded?.key !== runKey(project, version.version, run)) {
      unload();
      const next = await load(project, version, run);
      // Choosing another version or run while it loads cancels it.
      if (next === null || disposed || !active || selectedVersion()?.version !== version.version || selectedRun()?.session !== run.session) return;
      loaded = next;
    } else if (position >= loaded.duration) {
      position = 0;
    }
    show(false);
    setPlaying(true);
  }

  versionList.addEventListener('change', () => {
    unload();
    void refreshRuns();
  }, listen);
  runList.addEventListener('change', unload, listen);
  refreshButton.addEventListener('click', () => { void refresh(); }, listen);
  playButton.addEventListener('click', () => { void togglePlay(); }, listen);
  followButton.addEventListener('click', () => {
    following = !following;
    render();
    if (following && loaded !== null) show(false);
  }, listen);
  speedList.addEventListener('change', () => { speed = Number(speedList.value); }, listen);
  seek.addEventListener('input', () => {
    if (loaded === null) return;
    position = Math.min(loaded.duration, Math.max(0, Number(seek.value)));
    shownTenth = -1;
    show(false);
  }, listen);
  // Another project lists again; another played course labels the versions, and the run's warning, again.
  const unsubscribe = source.subscribe(() => {
    if (!active) return;
    if (listedFor === null || listedFor.project !== source.project()) void refresh();
    else if ((source.played()?.course ?? null) !== labelledFor) {
      fillVersions();
      render();
    }
  });
  signal.addEventListener('abort', unsubscribe, { once: true });
  fillVersions();
  fillRuns();
  render();

  return {
    setActive(next: boolean): void {
      if (disposed || next === active) return;
      active = next;
      if (!next) {
        setPlaying(false);
        if (loading !== null) loading.abort();
        figure.hold(null, 0);
        return;
      }
      if (loaded !== null) show(false);
      void refresh();
    },
    stopFollowing(): void {
      if (!following) return;
      following = false;
      render();
    },
    dispose(): void {
      if (disposed) return;
      setPlaying(false);
      loading?.abort();
      disposed = true;
      figure.hold(null, 0);
    },
  };
}
