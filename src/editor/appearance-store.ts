import { AppearanceError } from './appearance-types';
import type { StoredVisual, VisualPartId } from './appearance-types';

const DATABASE = 'over-the-edge:appearance';
const STORE = 'parts';

export class AppearanceStore {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private closed = false;

  private connect(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new AppearanceError('Visual storage has been closed.'));
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE, 1);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new AppearanceError('Browser storage is unavailable. Allow site storage to import models.'));
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'slot' });
      request.onerror = () => reject(new AppearanceError('Could not open local model storage. Check this browser\'s site storage permissions.'));
      request.onsuccess = () => {
        const database = request.result;
        if (this.closed) {
          database.close();
          reject(new AppearanceError('Visual storage was closed while opening.'));
          return;
        }
        this.database = database;
        database.onversionchange = () => this.close();
        resolve(database);
      };
    });
    return this.opening;
  }

  async entries(): Promise<{ key: IDBValidKey; value: unknown }[]> {
    const database = await this.connect();
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE, 'readonly');
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new AppearanceError('Could not read saved models. Reload this page and check site storage.'));
        return;
      }
      const entries: { key: IDBValidKey; value: unknown }[] = [];
      const request = transaction.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          entries.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = () => reject(new AppearanceError('Reading saved models failed. Existing records were not changed.'));
    });
  }

  async write(record: StoredVisual): Promise<void> {
    await this.change((store) => store.put(record));
  }

  async remove(slot: VisualPartId): Promise<void> {
    await this.change((store) => store.delete(slot));
  }

  private async change(action: (store: IDBObjectStore) => void): Promise<void> {
    const database = await this.connect();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE, 'readwrite');
        action(transaction.objectStore(STORE));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new AppearanceError('The model could not be saved. Browser storage may be blocked or full.'));
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new AppearanceError('The model could not be saved. Existing saved visuals are unchanged.'));
    });
  }

  close(): void {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}
