import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInboxComment, blockTarget } from '../src/comments'
import * as db from '../src/db'
import { enqueue, outbox, readText, snapshotOf, syncAll, wanted } from '../src/sync'

const enc = (s: string) => new TextEncoder().encode(s).buffer

function fakeGitHub(files: Record<string, string>) {
  const created: { path: string; body: { content: string; branch: string } }[] = []
  const blobs = new Map(Object.entries(files).map(([p, c], i) => [`sha${i}`, { p, c }]))
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const path = u.pathname
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status })
    if (/^\/repos\/o\/r$/.test(path)) return json({ default_branch: 'main' })
    if (path.endsWith('/commits/main')) return json({ sha: 'c1', commit: { tree: { sha: 't1' } } })
    if (path.includes('/git/trees/')) return json({ truncated: false, tree: [...blobs].map(([sha, { p, c }]) => ({ path: p, type: 'blob', sha, size: c.length })) })
    const b = /\/git\/blobs\/(\w+)$/.exec(path)
    if (b) return new Response(blobs.get(b[1]!)!.c)
    const c = /\/contents\/(.+)$/.exec(path)
    if (c && init?.method === 'PUT') {
      created.push({ path: decodeURIComponent(c[1]!), body: JSON.parse(String(init.body)) })
      return json({ commit: { sha: 'n1' } }, 201)
    }
    return json({ message: 'Not Found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { created, fetchMock }
}

beforeEach(async () => {
  for (const s of ['kv', 'blobs', 'outbox'] as const) for (const k of await db.keys(s)) await db.del(s, k)
  vi.unstubAllGlobals()
})

describe('sync', () => {
  it('keeps workbench files, preambles and PDFs, nothing else', () => {
    expect(wanted({ path: 'workbench/blocks/a.tex', sha: '', size: 10 })).toBe(true)
    expect(wanted({ path: 'workbench/.build/a.pdf', sha: '', size: 10 })).toBe(false)
    expect(wanted({ path: 'preamble/base.tex', sha: '', size: 10 })).toBe(true)
    expect(wanted({ path: 'docs/x.pdf', sha: '', size: 10 })).toBe(true)
    expect(wanted({ path: 'docs/huge.pdf', sha: '', size: 100 * 1024 * 1024 })).toBe(false)
    expect(wanted({ path: 'code/main.py', sha: '', size: 10 })).toBe(false)
  })

  it('pushes queued comments as new files, then downloads the tree', async () => {
    const gh = fakeGitHub({ 'workbench/blocks/a.tex': '% ---\n% id: a\n% ---\nhi', 'code/x.py': 'print()' })
    const item = buildInboxComment('o/r', { kind: '코멘트', target: blockTarget('a'), text: '좋음' })
    await enqueue(item)
    const res = await syncAll({ token: 't', repos: [{ owner: 'o', repo: 'r' }] })
    expect(res).toMatchObject({ sent: 1, failed: 0, repos: [{ repo: 'o/r', ok: true, downloaded: 1 }] })
    expect(gh.created).toHaveLength(1)
    expect(gh.created[0]!.path).toBe(item.path)
    expect(gh.created[0]!.body.branch).toBe('main')
    expect(new TextDecoder().decode(Uint8Array.from(atob(gh.created[0]!.body.content), (ch) => ch.charCodeAt(0)))).toBe(item.content)
    // no sha in the request: GitHub can only create, never overwrite
    expect(gh.created[0]!.body).not.toHaveProperty('sha')
    // sent, kept until a sync brings the file back (the fake tree does not have it yet)
    expect((await outbox()).map((x) => !!x.sentAt)).toEqual([true])
    const snap = await snapshotOf('o/r')
    expect(snap?.commit).toBe('c1')
    expect(await readText('o/r', snap!.files.find((f) => f.path === 'workbench/blocks/a.tex'))).toContain('hi')
    expect(await readText('o/r', snap!.files.find((f) => f.path === 'code/x.py'))).toBeNull()
  })

  it('keeps comments queued when offline and stops early', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await enqueue(buildInboxComment('o/r', { kind: '코멘트', target: blockTarget('a'), text: 'x' }))
    const res = await syncAll({ token: 't', repos: [{ owner: 'o', repo: 'r' }] })
    expect(res.sent).toBe(0)
    expect(res.repos[0]).toMatchObject({ ok: false, error: '인터넷에 연결되지 않음' })
    const [q] = await outbox()
    expect(q!.error).toBe('인터넷에 연결되지 않음')
  })

  it('does not download an unchanged file twice', async () => {
    const gh = fakeGitHub({ 'workbench/log/2026-10-01.md': '# a' })
    await syncAll({ token: 't', repos: [{ owner: 'o', repo: 'r' }] })
    const blobCalls = () => gh.fetchMock.mock.calls.filter(([u]) => String(u).includes('/git/blobs/')).length
    expect(blobCalls()).toBe(1)
    await syncAll({ token: 't', repos: [{ owner: 'o', repo: 'r' }] })
    expect(blobCalls()).toBe(1)
    void enc
  })

  it('forgets a sent comment once the synced tree has its file', async () => {
    const item = buildInboxComment('o/r', { kind: '코멘트', target: blockTarget('a'), text: 'x' })
    fakeGitHub({ [item.path]: item.content })
    await enqueue({ ...item, sentAt: '2026-10-01T00:00:00Z' })
    const res = await syncAll({ token: 't', repos: [{ owner: 'o', repo: 'r' }] })
    expect(res.sent).toBe(0)
    expect(await outbox()).toEqual([])
  })
})
