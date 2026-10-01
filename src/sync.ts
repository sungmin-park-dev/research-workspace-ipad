import * as db from './db'
import { GitHub, GitHubError, repoKey, type RepoRef, type TreeEntry } from './github'
import type { OutboxItem } from './comments'

export interface Settings { token: string; repos: RepoRef[] }
export interface Snapshot { repo: string; branch: string; commit: string; syncedAt: string; files: TreeEntry[]; truncated?: boolean }

export const DEFAULT_REPOS: RepoRef[] = [
  { owner: 'sungmin-park-dev', repo: 'entanglement-bootstrap' },
  { owner: 'sungmin-park-dev', repo: 'Linear-Spin-Wave-Theory' },
  // shared LaTeX macros (preamble/*.tex) so formulas in blocks render
  { owner: 'sungmin-park-dev', repo: 'research-library' },
]
/** PDFs larger than this are listed but not kept offline */
export const MAX_PDF_BYTES = 40 * 1024 * 1024

export async function loadSettings(): Promise<Settings> {
  return (await db.get<Settings>('kv', 'settings')) ?? { token: '', repos: DEFAULT_REPOS }
}
export const saveSettings = (s: Settings) => db.put('kv', 'settings', s)
export const snapshotOf = (repo: string) => db.get<Snapshot>('kv', `snap:${repo}`)
export const blobKey = (repo: string, sha: string) => `${repo}@${sha}`

/** Files kept on the iPad: the workbench (blocks, logs, comments, research.yaml), LaTeX preambles and PDFs */
export function wanted(f: TreeEntry): boolean {
  if (/(^|\/)\.build\//.test(f.path)) return false
  if (/(^|\/)preamble[^/]*\.tex$|^preamble\/.*\.tex$/.test(f.path)) return f.size < 512 * 1024
  if (f.path.startsWith('workbench/')) return f.size < 5 * 1024 * 1024
  return /\.pdf$/i.test(f.path) && f.size <= MAX_PDF_BYTES
}

export async function readText(repo: string, f: TreeEntry | undefined): Promise<string | null> {
  if (!f) return null
  const b = await db.get<ArrayBuffer>('blobs', blobKey(repo, f.sha))
  return b ? new TextDecoder().decode(b) : null
}
export const readBytes = (repo: string, f: TreeEntry) => db.get<ArrayBuffer>('blobs', blobKey(repo, f.sha))

export const outbox = async () => (await db.values<OutboxItem>('outbox')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
export const enqueue = (item: OutboxItem) => db.put('outbox', item.id, item)
export const dropQueued = (id: string) => db.del('outbox', id)

export interface Progress { phase: string; done: number; total: number }

/** Push queued comments. Each is a new file, so a retry can only add, never overwrite. */
export async function flushOutbox(gh: GitHub, branches: Map<string, string>): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0
  for (const item of (await outbox()).filter((x) => !x.sentAt)) {
    const [owner, repo] = item.repo.split('/') as [string, string]
    const ref = { owner, repo }
    try {
      let branch = branches.get(item.repo)
      if (!branch) { branch = await gh.defaultBranch(ref); branches.set(item.repo, branch) }
      await gh.createFile(ref, item.path, item.content, `Add iPad comment on ${item.target}`, branch)
      await markSent(item)
      sent++
    } catch (e) {
      // 422 without a sha means the file is already there: an earlier attempt went through but its answer never arrived
      if (e instanceof GitHubError && e.status === 422 && await gh.exists(ref, item.path, branches.get(item.repo)!).catch(() => false)) {
        await markSent(item)
        sent++
        continue
      }
      failed++
      await db.put('outbox', item.id, { ...item, error: (e as Error).message })
      if (e instanceof GitHubError && (e.status === 0 || e.status === 401)) break
    }
  }
  return { sent, failed }
}

const markSent = (item: OutboxItem) => db.put('outbox', item.id, { ...item, error: undefined, sentAt: new Date().toISOString() })

export interface SyncResult { repos: { repo: string; ok: boolean; error?: string; downloaded: number }[]; sent: number; failed: number }

export async function syncAll(s: Settings, onProgress: (p: Progress) => void = () => {}): Promise<SyncResult> {
  const gh = new GitHub(s.token)
  const branches = new Map<string, string>()
  onProgress({ phase: '코멘트 올리는 중', done: 0, total: 0 })
  const { sent, failed } = await flushOutbox(gh, branches)
  const result: SyncResult = { repos: [], sent, failed }
  for (const r of s.repos) {
    const key = repoKey(r)
    let downloaded = 0
    try {
      onProgress({ phase: `${r.repo} 목록 받는 중`, done: 0, total: 0 })
      const branch = branches.get(key) ?? await gh.defaultBranch(r)
      const t = await gh.tree(r, branch)
      const need: TreeEntry[] = []
      for (const f of t.files.filter(wanted)) if (!(await db.get('blobs', blobKey(key, f.sha)))) need.push(f)
      for (const f of need) {
        onProgress({ phase: `${r.repo} 받는 중 · ${f.path.split('/').pop()}`, done: downloaded, total: need.length })
        await db.put('blobs', blobKey(key, f.sha), await gh.blob(r, f.sha))
        downloaded++
      }
      await db.put('kv', `snap:${key}`, { repo: key, branch, commit: t.commit, syncedAt: new Date().toISOString(), files: t.files, truncated: t.truncated } satisfies Snapshot)
      // sent comments now come from the synced files; forget the local copies
      const paths = new Set(t.files.map((f) => f.path))
      for (const item of await outbox()) if (item.repo === key && item.sentAt && paths.has(item.path)) await db.del('outbox', item.id)
      result.repos.push({ repo: key, ok: true, downloaded })
    } catch (e) {
      result.repos.push({ repo: key, ok: false, error: (e as Error).message, downloaded })
      if (e instanceof GitHubError && (e.status === 0 || e.status === 401)) break
    }
  }
  // drop contents no snapshot points to any more (only once every repository synced, so nothing still readable is lost)
  if (result.repos.length === s.repos.length && result.repos.every((r) => r.ok)) {
    const keep = new Set<string>()
    for (const r of s.repos) {
      const snap = await snapshotOf(repoKey(r))
      for (const f of snap?.files ?? []) keep.add(blobKey(repoKey(r), f.sha))
    }
    await db.pruneBlobs(keep)
  }
  return result
}
