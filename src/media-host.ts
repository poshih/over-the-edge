import { MEDIA_LIMITS } from './media';

// A URL a media element streams, and whether its requests are CORS requests with or without cookies.
export interface MediaStream {
  readonly url: string;
  readonly crossOrigin: 'anonymous' | 'use-credentials' | null;
}

// How a host resolves authored media sources: sounds are loaded whole and decoded, while music and
// video stream from a URL. A release answers through its content access; authoring tools map
// sources to URLs.
export interface MediaHost {
  load(source: string, signal: AbortSignal): Promise<ArrayBuffer>;
  stream(source: string, signal: AbortSignal): Promise<MediaStream>;
}

// Sources resolved to plain URLs that load as the page would load them.
export function urlMediaHost(resolve: (source: string) => string): MediaHost {
  return {
    async load(source, signal) {
      const response = await fetch(resolve(source), { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MEDIA_LIMITS.bytes) throw new Error('the file is too large');
      return bytes;
    },
    async stream(source) {
      return { url: resolve(source), crossOrigin: null };
    },
  };
}
