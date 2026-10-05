// The public phantom service contract and its HTTP refusal. Lightweight: an SDK may export these without importing
// the reference client or recording codec. The optional phantom consumer owns those implementations.
export interface PhantomQuery {
  // Where the player's character is, in metres.
  readonly x: number;
  readonly y: number;
  // The most recordings the release wants.
  readonly limit: number;
}

export interface PhantomService {
  // One recording, in the phantom format, of the player on the course. Resolves once handed over.
  submit(course: string, recording: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void>;
  // Other players' recordings on the course that pass near the point, in the phantom format.
  nearby(course: string, query: PhantomQuery, signal: AbortSignal): Promise<readonly Uint8Array[]>;
}

export class PhantomServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
