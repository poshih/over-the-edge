export class VisualStoreError extends Error {}

export class VisualStore<TRecord extends object> {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private closed = false;
  private readonly options: { database: string; store: string; keyPath: string };

  constructor(options: { database: string; store: string; keyPath: string }) {
    this.options = options;
  }

  private connect(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new VisualStoreError('Visual storage has been closed.'));
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.options.database, 1);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new VisualStoreError('Browser storage is unavailable. Allow site storage to save visuals.'));
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(this.options.store, { keyPath: this.options.keyPath });
      request.onerror = () => reject(new VisualStoreError('Could not open local visual storage. Check this browser\'s site storage permissions.'));
      request.onsuccess = () => {
        const database = request.result;
        if (this.closed) {
          database.close();
          reject(new VisualStoreError('Visual storage was closed while opening.'));
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
        transaction = database.transaction(this.options.store, 'readonly');
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new VisualStoreError('Could not read saved visuals. Reload this page and check site storage.'));
        return;
      }
      const entries: { key: IDBValidKey; value: unknown }[] = [];
      const request = transaction.objectStore(this.options.store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          entries.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = () => reject(new VisualStoreError('Reading saved visuals failed. Existing records were not changed.'));
    });
  }

  async write(record: TRecord): Promise<void> {
    await this.change((store) => store.put(record));
  }

  async remove(key: IDBValidKey): Promise<void> {
    await this.change((store) => store.delete(key));
  }

  private async change(action: (store: IDBObjectStore) => void): Promise<void> {
    const database = await this.connect();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this.options.store, 'readwrite');
        action(transaction.objectStore(this.options.store));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        reject(new VisualStoreError('The visual could not be saved. Browser storage may be blocked or full.'));
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new VisualStoreError('The visual could not be saved. Existing saved visuals are unchanged.'));
    });
  }

  close(): void {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}
