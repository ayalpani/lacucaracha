import { DEFAULT_ORIENTATION, loadRoachModel, type RoachModel, type RoachOrientation } from './roachModel';

/**
 * Where the roach model comes from, in order:
 * 1. a GLB the user picked on this device (IndexedDB, survives reloads),
 * 2. the bundled `public/models/roach.glb`,
 * 3. nothing → the procedural roach.
 */
const DB = 'lacucaracha';
const STORE = 'models';
const KEY = 'custom';
export const BUNDLED_URL = `${import.meta.env.BASE_URL}models/roach.glb`;

interface StoredModel {
  name: string;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveCustomModel(data: ArrayBuffer, name: string): Promise<void> {
  await tx('readwrite', (s) => s.put({ name, data } satisfies StoredModel, KEY));
}

export async function clearCustomModel(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** The GLB the user picked on this device, raw (the stage needs the bytes to re-orient it). */
export async function readCustomModelData(): Promise<StoredModel | null> {
  try {
    return ((await tx('readonly', (s) => s.get(KEY))) as StoredModel | undefined) ?? null;
  } catch {
    return null;
  }
}

async function fetchBundled(): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(BUNDLED_URL);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Dev servers answer missing files with index.html: only accept real GLB ("glTF" magic).
    const magic = new Uint32Array(buf, 0, 1)[0];
    return buf.byteLength > 12 && magic === 0x46546c67 ? buf : null;
  } catch {
    return null;
  }
}

const orientKey = (name: string): string => `roach-orientation:${name}`;

export function getOrientation(name: string): RoachOrientation {
  try {
    const raw = localStorage.getItem(orientKey(name));
    return raw ? { ...DEFAULT_ORIENTATION, ...(JSON.parse(raw) as Partial<RoachOrientation>) } : { ...DEFAULT_ORIENTATION };
  } catch {
    return { ...DEFAULT_ORIENTATION };
  }
}

export function setOrientation(name: string, o: RoachOrientation): void {
  try {
    localStorage.setItem(orientKey(name), JSON.stringify(o));
  } catch {
    /* private mode: orientation just isn't remembered */
  }
}

/** The model the app should use right now, or null for the procedural roach. */
export async function loadActiveModel(): Promise<RoachModel | null> {
  const custom = await readCustomModelData();
  if (custom) {
    try {
      return await loadRoachModel(custom.data, custom.name, getOrientation(custom.name));
    } catch (err) {
      console.warn('Eigenes Modell kaputt, nehme Standard', err);
    }
  }
  const bundled = await fetchBundled();
  if (!bundled) return null;
  return loadRoachModel(bundled, 'roach.glb', getOrientation('roach.glb'));
}
