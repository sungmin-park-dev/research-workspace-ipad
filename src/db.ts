/**
 * Everything the device keeps lives in one IndexedDB database:
 * - kv: settings and per-repository snapshots (file lists)
 * - blobs: file contents keyed by "<owner>/<repo>@<git blob sha>", so an unchanged file is never downloaded twice
 * - outbox: comments written on the device and not yet on GitHub
 */

const DB_NAME = 'rw-ipad'
const VERSION = 1
export type Store = 'kv' | 'blobs' | 'outbox'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of ['kv', 'blobs', 'outbox']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { opening = null; reject(req.error) }
  })
  return opening
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}

export const get = <T>(store: Store, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
export const put = (store: Store, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined)
export const del = (store: Store, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
export const keys = (store: Store) => run(store, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String))
export const values = <T>(store: Store) => run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)

/** Remove every blob not in `keep` (content of files that left the repositories) */
export async function pruneBlobs(keep: Set<string>): Promise<number> {
  let n = 0
  for (const k of await keys('blobs')) if (!keep.has(k)) { await del('blobs', k); n++ }
  return n
}

/** Ask the browser not to evict our data under storage pressure */
export async function persist(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false } catch { return false }
}

export async function usage(): Promise<{ used: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.()
    return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null
  } catch { return null }
}
