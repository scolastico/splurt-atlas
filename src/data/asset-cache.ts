// Offline storage of map data in IndexedDB. Files are fetched through `get()`,
// which prefers a stored copy; `warm()` downloads whole map ZIPs and extracts
// them so a station can be reopened without the network.
import type { ExtractedAsset } from './archive-extract.ts';
import type { ArchiveWorkerMessage } from './archive-worker.ts';
import type { Manifest, ManifestMap } from './types.ts';

const DATABASE = 'splurt-atlas-assets-v1';
const DATABASE_VERSION = 2;
/** Writes are batched for a short moment so extraction commits a few files per transaction. */
const WRITE_DELAY_MS = 35;
const WRITE_BATCH_SIZE = 64;

export type StorageMode = 'all' | 'current' | 'none';
export type StorageModeSetting = StorageMode | null;

export interface CacheProgress {
  activity: 'check' | 'download' | 'extract' | 'complete';
  stepPercent: number;
  overallPercent: number;
  completedMaps: number;
  totalMaps: number;
  remainingMaps: number;
  remainingSeconds: number | null;
}

export type StatusHandler = (message: string, progress?: CacheProgress) => void;
export type ActivityHandler = (active: boolean, info?: { currentReady: boolean }) => void;

type FetchPriority = 'high' | 'low' | 'auto';

interface ArchiveRecord {
  key: string;
  blob: Blob;
  complete: boolean;
}

interface AssetIndexEntry {
  path: string;
  bytes: number;
}

const isStorageMode = (value: unknown): value is StorageMode =>
  value === 'all' || value === 'current' || value === 'none';

export class AssetCache {
  readonly scope: string;
  mode: StorageModeSetting = null;
  currentMap: string | null = null;
  /** Paths the viewer needs first; fetched at high priority and extracted first from ZIPs. */
  priorityPaths: Set<string> | null = null;
  /** True while a station is displayed; low-priority fetches stay low only then. */
  activeView = false;
  foregroundBusy = false;

  private readonly onStatus: StatusHandler;
  private readonly onActivity: ActivityHandler;
  private readonly pending = new Map<string, Promise<Blob>>();
  private version = '';
  private mapVersions: Map<string, string> | null = null;
  private warmRun = 0;
  private warmAbort: AbortController | null = null;
  private archiveWarming: Promise<void> | null = null;
  private readyMaps: Set<string> | null = null;
  private storageFull = false;
  private readonly buffer = new Map<string, Blob>();
  private writeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private flushing: Promise<void> | null = null;
  private keys: Set<string> | null = null;
  private readonly database: Promise<IDBDatabase | null>;
  private readonly keysReady: Promise<Set<string> | null>;

  constructor(scope: string, onStatus: StatusHandler = () => {}, onActivity: ActivityHandler = () => {}) {
    this.scope = scope;
    this.onStatus = onStatus;
    this.onActivity = onActivity;
    try {
      const saved = localStorage.getItem('atlas-storage-mode');
      if (isStorageMode(saved)) this.mode = saved;
      this.currentMap = localStorage.getItem('atlas-storage-map');
    } catch {}
    this.database = new Promise((resolve) => {
      if (!globalThis.indexedDB) {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DATABASE, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        for (const store of ['assets', 'archives'])
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store, { keyPath: 'key' });
      };
      request.onblocked = () => this.onStatus('Close other atlas tabs to finish upgrading offline storage.');
      request.addEventListener('success', () => {
        request.result.onversionchange = () => request.result.close();
      });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.onStatus('Local storage is unavailable; using the network.');
        resolve(null);
      };
    });
    // The key set answers "is this stored?" without a transaction per lookup.
    this.keysReady = this.database.then(
      (db) =>
        new Promise((resolve) => {
          if (!db) {
            this.keys = null;
            resolve(null);
            return;
          }
          const request = db.transaction('assets').objectStore('assets').getAllKeys();
          request.onsuccess = () => {
            this.keys = new Set(request.result as string[]);
            resolve(this.keys);
          };
          request.onerror = () => {
            this.keys = null;
            resolve(null);
          };
        }),
    );
  }

  get enabled(): boolean {
    return this.mode === 'all' || this.mode === 'current';
  }

  // --- Versioning ---------------------------------------------------------

  setManifest(manifest: Manifest): void {
    this.version = manifest.buildId || manifest.commit;
    this.mapVersions = new Map(manifest.maps.map((map) => [map.id, map.assetVersion || this.version]));
  }

  /** The export version of a map-scoped path (`<map>/...`), or the catalog version. */
  versionFor(path: string): string {
    return this.mapVersions?.get(path.split('/')[0]) || this.version;
  }

  /**
   * Map files never change under the same version, so hosts may serve them as
   * immutable; the query string keeps browser and edge caches version-exact.
   */
  versioned(url: URL | string, path: string): URL {
    const target = new URL(url);
    if (path.includes('/')) target.searchParams.set('v', this.versionFor(path));
    return target;
  }

  private assetKey(path: string): string {
    return `${this.scope}:${this.versionFor(path)}:${path}`;
  }

  // --- Storage policy -----------------------------------------------------

  canStore(path: string): boolean {
    if (this.mode === 'all') return true;
    return this.mode === 'current' && !!this.currentMap && path.startsWith(`${this.currentMap}/`);
  }

  /** Whether a stored key belongs to this catalog, the current version and the chosen mode. */
  canStoreKey(key: string): boolean {
    const prefix = `${this.scope}:`;
    if (!this.enabled || !key.startsWith(prefix)) return false;
    if (key === `${prefix}catalog`) return true;
    const suffix = key.slice(prefix.length);
    const split = suffix.indexOf(':');
    const file = suffix.slice(split + 1);
    return split > 0 && suffix.slice(0, split) === this.versionFor(file) && this.canStore(file);
  }

  setMode(mode: string): void {
    if (!isStorageMode(mode)) throw new Error('Invalid storage mode');
    this.mode = mode;
    this.stopWarm();
    try {
      localStorage.setItem('atlas-storage-mode', mode);
    } catch {}
    if (mode === 'none') this.onStatus('Offline storage is off.');
    else if (mode === 'current') this.onStatus('Preparing current map storage...');
    else this.onStatus('Preparing offline maps...');
  }

  setCurrentMap(id: string | null): void {
    if (this.currentMap === id) return;
    this.currentMap = id;
    if (this.mode !== 'all') this.stopWarm();
    if (this.archiveWarming) this.onActivity(true, { currentReady: !!(id && this.readyMaps?.has(id)) });
    if (this.mode === 'current') this.onStatus('Preparing current map storage...');
    try {
      localStorage.setItem('atlas-storage-map', id || '');
    } catch {}
  }

  stopWarm(): void {
    this.warmRun++;
    this.warmAbort?.abort();
  }

  // --- Reading and writing single assets ---------------------------------

  async read(key: string): Promise<Blob | null> {
    const buffered = this.buffer.get(key);
    if (buffered) return buffered;
    const db = await this.database;
    if (!db) return null;
    const keys = await this.keysReady;
    if (keys && !keys.has(key)) return null;
    return new Promise((resolve) => {
      const request = db.transaction('assets').objectStore('assets').get(key);
      request.onsuccess = () => resolve((request.result as { blob?: Blob } | undefined)?.blob || null);
      request.onerror = () => resolve(null);
    });
  }

  async write(key: string, blob: Blob): Promise<void> {
    const db = await this.database;
    if (!db || this.storageFull || !this.canStoreKey(key)) return;
    return new Promise((resolve) => {
      const transaction = db.transaction('assets', 'readwrite', { durability: 'relaxed' });
      transaction.objectStore('assets').put({ key, blob, bytes: blob.size });
      transaction.oncomplete = () => {
        this.keys?.add(key);
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        this.markStorageFull();
        resolve();
      };
    });
  }

  private markStorageFull(): void {
    this.storageFull = true;
    this.onStatus('Storage is full or unavailable. Existing saved maps remain usable.');
  }

  /** Buffers a write; buffered blobs are readable immediately and committed in batches. */
  queueWrite(key: string, blob: Blob): void {
    if (this.storageFull) return;
    this.buffer.set(key, blob);
    if (!this.writeTimer)
      this.writeTimer = setTimeout(() => {
        this.writeTimer = 0;
        void this.flushWrites();
      }, WRITE_DELAY_MS);
    if (this.buffer.size >= WRITE_BATCH_SIZE) void this.flushWrites();
  }

  async flushWrites(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.size) return this.flushWrites();
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = 0;
    }
    this.flushing = (async () => {
      const db = await this.database;
      if (!db || this.storageFull) {
        this.buffer.clear();
        return;
      }
      for (const key of this.buffer.keys()) if (!this.canStoreKey(key)) this.buffer.delete(key);
      const batch = [...this.buffer];
      if (!batch.length) return;
      await new Promise<void>((resolve) => {
        const transaction = db.transaction('assets', 'readwrite', { durability: 'relaxed' });
        const store = transaction.objectStore('assets');
        for (const [key, blob] of batch) store.put({ key, blob, bytes: blob.size });
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => {
          this.markStorageFull();
          resolve();
        };
      });
      for (const [key, blob] of batch) {
        if (!this.storageFull) this.keys?.add(key);
        if (this.buffer.get(key) === blob) this.buffer.delete(key);
      }
    })();
    await this.flushing;
    this.flushing = null;
    if (this.buffer.size) return this.flushWrites();
  }

  /** Removes stored files that no longer match the catalog, version or storage mode. */
  async prune(): Promise<void> {
    const db = await this.database;
    await this.keysReady;
    if (this.flushing) await this.flushing;
    if (!db || !this.mode) return;
    const prefix = `${this.scope}:`;
    const keep = (key: string) => this.canStoreKey(key);
    for (const key of this.buffer.keys()) if (key.startsWith(prefix) && !keep(key)) this.buffer.delete(key);
    await new Promise<void>((resolve) => {
      const transaction = db.transaction('archives', 'readwrite');
      const request = transaction.objectStore('archives').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith(prefix) && !keep(key)) cursor.delete();
          cursor.continue();
        }
      };
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
    });
    const obsolete = [...(this.keys || [])].filter((key) => key.startsWith(prefix) && !keep(key));
    if (!obsolete.length) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction('assets', 'readwrite');
      const store = transaction.objectStore('assets');
      for (const key of obsolete) store.delete(key);
      transaction.oncomplete = () => {
        for (const key of obsolete) this.keys?.delete(key);
        resolve();
      };
      transaction.onerror = transaction.onabort = () => resolve();
    });
  }

  /** The catalog is always fetched fresh; the stored copy only serves when the network fails. */
  async catalog(url: URL | string): Promise<Manifest> {
    const key = `${this.scope}:catalog`;
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Archive: HTTP ${response.status}`);
      const blob = await response.blob();
      if (this.enabled) await this.write(key, blob);
      return JSON.parse(await blob.text());
    } catch (error) {
      const cached = this.enabled && (await this.read(key));
      if (cached) return JSON.parse(await cached.text());
      throw error;
    }
  }

  /** Fetches a map file, preferring the stored copy, and stores it when the mode allows. */
  async get(url: URL | string, path: string, priority: FetchPriority = 'auto'): Promise<Blob> {
    const key = this.assetKey(path);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = (async () => {
      const stored = this.canStore(path) && (await this.read(key));
      if (stored) return stored;
      const fetchPriority: FetchPriority = this.priorityPaths?.has(path)
        ? 'high'
        : priority === 'low' && !this.activeView
          ? 'auto'
          : priority;
      const response = await fetch(url, { priority: fetchPriority } as RequestInit);
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const blob = await response.blob();
      if (this.canStore(path)) {
        if (priority === 'low') this.queueWrite(key, blob);
        else await this.write(key, blob);
      }
      return blob;
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  // --- Packaged ZIP handling ---------------------------------------------

  /** Reads an archive record, or writes one when `record` is given. */
  private async archiveRecord(
    key: string,
    record?: Omit<ArchiveRecord, 'key'>,
  ): Promise<ArchiveRecord | undefined | null> {
    const db = await this.database;
    if (!db) return null;
    if (record && !this.canStoreKey(key)) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('archives', record ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('archives');
      const request = record ? store.put({ key, ...record }) : store.get(key);
      let value: ArchiveRecord | undefined;
      request.onsuccess = () => {
        value = request.result as ArchiveRecord | undefined;
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error || new Error('Archive storage failed'));
    });
  }

  private async deleteArchive(key: string): Promise<void> {
    const db = await this.database;
    if (!db) return;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('archives', 'readwrite');
      transaction.objectStore('archives').delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error || new Error('Could not remove extracted ZIP'));
    });
  }

  /** Extracts a ZIP in a worker (or inline without workers), handing batches to `onBatch`. */
  private async unpack(
    blob: Blob,
    onBatch: (batch: ExtractedAsset[], complete: number, total: number) => Promise<void>,
    signal: AbortSignal,
    priorities: string[] = [],
  ): Promise<void> {
    if (typeof Worker === 'undefined') {
      const { extractArchive } = await import('./archive-extract.ts');
      return extractArchive(blob, onBatch, () => signal.aborted, priorities);
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' });
      const finish = (error?: Error) => {
        worker.terminate();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new DOMException('Offline saving interrupted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      worker.onerror = (event) => finish(new Error(event.message || 'Archive extraction failed'));
      worker.onmessage = async ({ data }: MessageEvent<ArchiveWorkerMessage>) => {
        if ('error' in data) {
          finish(new Error(data.error));
          return;
        }
        if ('done' in data) {
          finish();
          return;
        }
        try {
          await onBatch(data.batch, data.complete, data.total);
          if (!signal.aborted) worker.postMessage({ ack: true });
        } catch (error) {
          finish(error as Error);
        }
      };
      worker.postMessage({ blob, priorities });
    });
  }

  private async warmArchives(manifest: Manifest, base: URL): Promise<void> {
    if (this.archiveWarming) return this.archiveWarming;
    this.archiveWarming = this.saveArchives(manifest, base);
    try {
      await this.archiveWarming;
    } finally {
      this.archiveWarming = null;
    }
  }

  /** Whether every file listed in a map's asset inventory is already stored. */
  private async isMapComplete(map: ManifestMap): Promise<boolean> {
    const inventory = await this.read(this.assetKey(map.assets));
    if (!inventory) return false;
    const assets = JSON.parse(await inventory.text()) as AssetIndexEntry[];
    return (
      assets.length > 0 && assets.every((asset) => this.keys?.has(this.assetKey(`${map.id}/${asset.path}`)))
    );
  }

  /** Downloads a map ZIP with progress, verifying the expected size. */
  private async downloadArchive(
    map: ManifestMap,
    base: URL,
    signal: AbortSignal,
    stopped: () => boolean,
    onProgress: (received: number) => void,
  ): Promise<Blob> {
    const archive = map.archive!;
    const response = await fetch(this.versioned(new URL(archive.path, base), `${map.id}/`), {
      signal,
      priority: 'low',
    } as RequestInit);
    if (!response.ok) throw new Error(`${map.name}: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return response.blob();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReport = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const now = performance.now();
      if (now - lastReport > 200 && !stopped()) {
        lastReport = now;
        onProgress(received);
      }
    }
    return new Blob(chunks as BlobPart[], { type: 'application/zip' });
  }

  private async saveArchives(manifest: Manifest, base: URL): Promise<void> {
    const run = ++this.warmRun;
    const controller = new AbortController();
    this.warmAbort = controller;
    const { signal } = controller;
    const readyMaps = (this.readyMaps = new Set<string>());
    this.onActivity(true, { currentReady: false });
    const stopped = () => signal.aborted || run !== this.warmRun || !this.enabled;
    try {
      await this.prune();
      if (stopped()) return;
      const maps =
        this.mode === 'all' ? [...manifest.maps] : manifest.maps.filter((map) => map.id === this.currentMap);
      if (!maps.length) {
        this.onStatus('Choose a map to save it on this device.');
        return;
      }
      // Progress is weighted by bytes: downloading the ZIP plus extracting it.
      const work = (map: ManifestMap) => (map.archive!.bytes || 1) + (map.bytes || map.archive!.bytes || 1);
      const totalWork = maps.reduce((sum, map) => sum + work(map), 0);
      let completedWork = 0;
      let completedMaps = 0;
      let cachedWork = 0;
      const started = performance.now();
      const report = (
        message: string,
        map: ManifestMap,
        activity: CacheProgress['activity'],
        fraction = 0,
      ) => {
        fraction = Math.max(0, Math.min(1, fraction));
        const download = map.archive!.bytes || 1;
        const extract = map.bytes || download;
        const partial =
          activity === 'download'
            ? download * fraction
            : activity === 'extract'
              ? download + extract * fraction
              : 0;
        const elapsed = (performance.now() - started) / 1000;
        const processed = completedWork - cachedWork + partial;
        const remaining = Math.max(0, totalWork - completedWork - partial);
        const finished = completedMaps === maps.length;
        this.onStatus(message, {
          activity,
          stepPercent: Math.round(fraction * 100),
          overallPercent: Math.min(
            finished ? 100 : 99,
            Math.round(((completedWork + partial) / totalWork) * 100),
          ),
          completedMaps,
          totalMaps: maps.length,
          remainingMaps: maps.length - completedMaps,
          remainingSeconds: finished
            ? 0
            : elapsed >= 2 && completedWork > cachedWork && processed > 0
              ? (elapsed * remaining) / processed
              : null,
        });
      };
      for (let index = 0; index < maps.length; index++) {
        // The current map moves to the front of the remaining queue.
        const preferred = maps.findIndex((map, position) => position >= index && map.id === this.currentMap);
        if (preferred > index) maps.splice(index, 0, maps.splice(preferred, 1)[0]);
        const map = maps[index];
        const key = `${this.scope}:${this.versionFor(`${map.id}/`)}:${map.id}/archive.zip`;
        const position = `(${index + 1}/${maps.length})`;
        this.onActivity(true, { currentReady: !!this.currentMap && readyMaps.has(this.currentMap) });
        if (stopped() || this.storageFull) return;
        report(`Checking saved ${map.name} ${position}...`, map, 'check');
        const record = await this.archiveRecord(key);
        // Complete extracted maps need no ZIP. Clean up archives left by older versions too.
        if (await this.isMapComplete(map)) {
          if (record) await this.deleteArchive(key);
          readyMaps.add(map.id);
          completedWork += work(map);
          cachedWork += work(map);
          completedMaps++;
          report(`${map.name} is already saved.`, map, 'check', 1);
          continue;
        }
        if (stopped()) return;
        let blob = record?.blob;
        if (!blob) {
          report(`Downloading ${map.name} ZIP ${position}...`, map, 'download');
          blob = await this.downloadArchive(map, base, signal, stopped, (received) =>
            report(
              `Downloading ${map.name} ZIP ${position}: ${Math.round(received / 1048576)} / ${Math.round(map.archive!.bytes / 1048576)} MB`,
              map,
              'download',
              received / map.archive!.bytes,
            ),
          );
          if (stopped()) return;
          if (blob.size !== map.archive!.bytes) throw new Error(`${map.name}: incomplete ZIP download`);
          await this.archiveRecord(key, { blob, complete: false });
        }
        if (stopped()) return;
        report(`Extracting ${map.name} ${position}: 0%`, map, 'extract');
        const priorities = ['map.json', 'search.json', ...(this.priorityPaths || [])]
          .filter((path) => !path.includes('/') || path.startsWith(`${map.id}/`))
          .map((path) => (path.startsWith(`${map.id}/`) ? path.slice(map.id.length + 1) : path));
        try {
          await this.unpack(
            blob,
            async (batch, complete, total) => {
              if (stopped()) throw new DOMException('Offline saving interrupted', 'AbortError');
              for (const item of batch) {
                const assetKey = this.assetKey(`${map.id}/${item.path}`);
                if (!this.keys?.has(assetKey)) this.queueWrite(assetKey, item.blob);
              }
              await this.flushWrites();
              if (this.storageFull) throw new Error('Storage is full');
              if (!stopped())
                report(
                  `Extracting ${map.name} ${position}: ${Math.round((complete / total) * 100)}%`,
                  map,
                  'extract',
                  complete / total,
                );
            },
            signal,
            priorities,
          );
        } catch (error) {
          if ((error as Error).name !== 'AbortError' && !this.storageFull)
            await this.deleteArchive(key).catch(() => {});
          throw error;
        }
        // Every batch transaction has committed before unpack() resolves.
        await this.deleteArchive(key);
        readyMaps.add(map.id);
        if (stopped()) return;
        completedWork += work(map);
        completedMaps++;
      }
      if (!stopped())
        report(
          `${this.mode === 'all' ? `All ${maps.length} maps` : 'Current map'} saved for reopening. Temporary ZIPs removed.`,
          maps.at(-1)!,
          'complete',
          1,
        );
    } catch (error) {
      if (!stopped())
        this.onStatus(`Offline saving paused: ${(error as Error).message}. Reopening will retry.`);
    } finally {
      if (this.warmAbort === controller) this.warmAbort = null;
      this.onActivity(false);
    }
  }

  /**
   * Saves maps for offline use. Offline copies always come from one ZIP per
   * map: fetching thousands of separate files would be dominated by request
   * overhead, so maps without a packaged download are simply not saved.
   */
  async warm(manifest: Manifest, base: URL): Promise<void> {
    if (!this.enabled) {
      await this.prune();
      return;
    }
    if (!(await this.database)) {
      this.onStatus('Local storage is unavailable; offline saving is paused.');
      return;
    }
    const packaged = { ...manifest, maps: manifest.maps.filter((map) => map.archive) };
    if (!packaged.maps.length) {
      await this.prune();
      this.onStatus('This export has no packaged map downloads; offline saving is unavailable.');
      return;
    }
    if (this.archiveWarming) {
      await this.archiveWarming;
      if (!this.enabled) return;
    }
    return this.warmArchives(packaged, base);
  }
}
