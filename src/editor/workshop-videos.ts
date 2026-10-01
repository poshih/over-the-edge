import { DEFAULT_VIDEO_PLAYBACK } from '../trigger-events';
import type { VideoPlayback } from '../trigger-events';

/**
 * Whether the Workshop plays trigger videos while a designer tests: a browser-local preference, like the
 * sections' layout. Only a choice that differs from the default is remembered; releases always play videos.
 */
const STORAGE_KEY = 'over-the-edge:workshop:videos:v1';

export function rememberedVideos(): VideoPlayback {
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return DEFAULT_VIDEO_PLAYBACK;
    throw error;
  }
  return text === 'skip' ? 'skip' : DEFAULT_VIDEO_PLAYBACK;
}

export function rememberVideos(videos: VideoPlayback): void {
  try {
    if (videos === DEFAULT_VIDEO_PLAYBACK) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, videos);
  } catch (error) {
    // A disposable preference: unavailable or full storage only forgets it.
    if (!(error instanceof DOMException)) throw error;
  }
}
