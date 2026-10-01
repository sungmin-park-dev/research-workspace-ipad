import 'katex/dist/katex.min.css'
import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { parse as parseYaml } from 'yaml'
import { blockTarget, buildInboxComment, COMMENTS_DIR, INBOX_DIR, inboxTarget, logTarget, paperTarget, parseComments, type CommentEntry, type CommentKind, type CommentTarget, type OutboxItem } from './comments'
import * as db from './db'
import { GitHub, parseRepo, repoKey, type RepoRef, type TreeEntry } from './github'
import { mountPdf, type PdfSelection } from './pdf'
import { DEFAULT_REPOS, enqueue, dropQueued, flushOutbox, loadSettings, MAX_PDF_BYTES, outbox, readBytes, readText, saveSettings, snapshotOf, syncAll, type Settings, type Snapshot } from './sync'
import { blockMeta, blockNotes, collectMacros, escapeHtml, markdownToHtml, texToHtml, type Macros } from './tex'

registerSW({ immediate: true })

// ---------- tiny DOM helpers ----------

type Child = Node | string | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'html') el.innerHTML = String(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c)
  return el
}
const app = document.getElementById('app')!
const fmtTime = (iso?: string) => {
  if (!iso) return '없음'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// ---------- state ----------

let settings: Settings = { token: '', repos: DEFAULT_REPOS }
let syncing = false
let syncNote = ''
let cleanup: (() => void) | null = null

interface Repo { ref: RepoRef; key: string; snap: Snapshot | undefined; files: Map<string, TreeEntry> }
async function repo(key: string): Promise<Repo | null> {
  const ref = settings.repos.find((r) => repoKey(r) === key) ?? parseRepo(key)
  if (!ref) return null
  const snap = await snapshotOf(key)
  return { ref, key, snap, files: new Map((snap?.files ?? []).map((f) => [f.path, f])) }
}

let macroCache: { stamp: string; macros: Macros } | null = null
/** Macros from every synced preamble (research-library first, then the research's own) */
async function macrosFor(r: Repo): Promise<Macros> {
  const sources: string[] = []
  const stamp: string[] = []
  const all = [...settings.repos.filter((x) => repoKey(x) !== r.key), r.ref]
  for (const ref of all) {
    const rr = ref === r.ref ? r : await repo(repoKey(ref))
    if (!rr) continue
    for (const f of rr.snap?.files ?? []) {
      if (!/(^|\/)preamble[^/]*\.tex$|^preamble\/.*\.tex$/.test(f.path)) continue
      const t = await readText(rr.key, f)
      if (t) { sources.push(t); stamp.push(f.sha) }
    }
  }
  const s = stamp.join(',') + r.key
  if (macroCache?.stamp !== s) macroCache = { stamp: s, macros: collectMacros(sources) }
  return macroCache.macros
}

// ---------- comments on a target: synced files + inbox files + not yet sent ----------

interface ShownComment extends CommentEntry { origin: 'github' | 'inbox' | 'queued'; queued?: OutboxItem }
async function commentsFor(r: Repo, target: string): Promise<ShownComment[]> {
  const out: ShownComment[] = []
  const main = r.files.get(`${COMMENTS_DIR}/${target}.md`)
  const text = await readText(r.key, main)
  if (text) out.push(...parseComments(target, text).comments.map((c) => ({ ...c, origin: 'github' as const })))
  const seen = new Set(out.map((c) => c.id))
  for (const f of r.snap?.files ?? []) {
    if (!f.path.startsWith(`${INBOX_DIR}/`)) continue
    const t = await readText(r.key, f)
    if (!t || inboxTarget(t) !== target) continue
    for (const c of parseComments(target, t).comments) if (!seen.has(c.id)) { seen.add(c.id); out.push({ ...c, origin: 'inbox' }) }
  }
  for (const q of await outbox()) {
    if (q.repo !== r.key || q.target !== target) continue
    for (const c of parseComments(target, q.content).comments) if (!seen.has(c.id)) out.push({ ...c, origin: 'queued', queued: q })
  }
  return out
}

function commentView(c: ShownComment, macros: Macros, onChange: () => void): HTMLElement {
  const badge = c.origin === 'queued' ? (c.queued?.sentAt ? h('span', { class: 'chip' }, '올림') : h('span', { class: 'chip warn' }, c.queued?.error ? '올리지 못함' : '올릴 차례')) : c.origin === 'inbox' ? h('span', { class: 'chip' }, 'iPad') : null
  return h('div', { class: `comment ${c.kind === '질문' ? 'q' : ''}` },
    h('div', { class: 'comment-head' },
      h('b', {}, c.kind), h('span', { class: 'muted' }, c.where),
      c.state ? h('span', { class: `chip state-${c.state}` }, c.state) : null, badge,
      h('span', { class: 'sp' }),
      c.origin === 'queued' && !c.queued?.sentAt ? h('button', { class: 'btn ghost small', onclick: async () => { if (confirm('아직 올리지 않은 이 코멘트를 지울까요?')) { await dropQueued(c.queued!.id); onChange() } } }, '지우기') : null),
    c.quote ? h('blockquote', {}, c.quote) : null,
    c.body ? h('div', { class: 'md', html: markdownToHtml(c.body, macros) }) : null,
    c.queued?.error ? h('div', { class: 'error small' }, c.queued.error) : null,
    c.answers.map((a) => h('div', { class: 'answer' }, h('div', { class: 'muted small' }, `답 · ${a.by} · ${a.at}`), h('div', { class: 'md', html: markdownToHtml(a.body, macros) }))))
}

async function commentsPanel(r: Repo, target: CommentTarget, macros: Macros, extra: () => { page?: number; quote?: string } = () => ({})): Promise<HTMLElement> {
  const box = h('section', { class: 'comments' })
  const draw = async () => {
    const list = await commentsFor(r, target.target)
    box.replaceChildren(
      h('div', { class: 'row' }, h('h3', {}, `코멘트·질문 ${list.length || ''}`), h('span', { class: 'sp' }),
        h('button', { class: 'btn', onclick: () => compose(r, target, extra(), draw) }, '+ 남기기')),
      list.length ? h('div', {}, list.map((c) => commentView(c, macros, draw))) : h('p', { class: 'muted' }, '아직 없음'))
  }
  await draw()
  return box
}

/** The composer sheet. Saving only queues; sending happens right away if online, otherwise at the next sync. */
function compose(r: Repo, target: CommentTarget, at: { page?: number; quote?: string }, done: () => void) {
  let kind: CommentKind = '코멘트'
  const ta = h('textarea', { rows: 6, placeholder: '내용' })
  const kinds = h('div', { class: 'seg' })
  const drawKinds = () => kinds.replaceChildren(...(['코멘트', '질문'] as CommentKind[]).map((k) =>
    h('button', { class: `btn ${k === kind ? 'on' : 'ghost'}`, onclick: () => { kind = k; drawKinds() } }, k === '질문' ? '질문 (Claude에게)' : k)))
  drawKinds()
  const err = h('div', { class: 'error' })
  const sheet = h('div', { class: 'sheet-bg', onclick: (e: Event) => { if (e.target === sheet) sheet.remove() } },
    h('div', { class: 'sheet' },
      h('div', { class: 'row' }, h('b', {}, target.title), h('span', { class: 'sp' }), at.page ? h('span', { class: 'muted' }, `p.${at.page}`) : null),
      at.quote ? h('blockquote', {}, at.quote) : null,
      kinds, ta, err,
      h('div', { class: 'row' }, h('span', { class: 'sp' }),
        h('button', { class: 'btn ghost', onclick: () => sheet.remove() }, '취소'),
        h('button', { class: 'btn on', onclick: async () => {
          try {
            const item = buildInboxComment(r.key, { kind, target, page: at.page, quote: at.quote, text: ta.value })
            await enqueue(item)
            sheet.remove()
            done()
            void sendQueued().then(done)
          } catch (e) { err.textContent = (e as Error).message }
        } }, '저장'))))
  document.body.append(sheet)
  ta.focus()
}

async function sendQueued() {
  if (!settings.token || !navigator.onLine || !(await outbox()).some((x) => !x.sentAt)) return
  await flushOutbox(new GitHub(settings.token), new Map())
  void drawBar()
}

// ---------- top bar ----------

const bar = h('header', { class: 'bar' })
async function drawBar() {
  const q = (await outbox()).filter((x) => !x.sentAt).length
  const snaps = await Promise.all(settings.repos.map((r) => snapshotOf(repoKey(r))))
  const last = snaps.map((s) => s?.syncedAt).filter(Boolean).sort().at(0)
  bar.replaceChildren(
    h('a', { class: 'home', href: '#/' }, '연구 작업대'),
    h('span', { class: 'sp' }),
    h('span', { class: 'muted small' }, syncing ? syncNote : `${navigator.onLine ? '' : '오프라인 · '}받은 때 ${fmtTime(last)}${q ? ` · 올릴 코멘트 ${q}` : ''}`),
    h('button', { class: 'btn', disabled: syncing || !settings.token, onclick: () => void runSync() }, syncing ? '동기화 중…' : '동기화'),
    h('a', { class: 'btn ghost', href: '#/settings' }, '설정'))
}

async function runSync() {
  if (syncing || !settings.token) return
  syncing = true
  syncNote = '시작'
  void drawBar()
  try {
    const res = await syncAll(settings, (p) => { syncNote = p.total ? `${p.phase} (${p.done + 1}/${p.total})` : p.phase; void drawBar() })
    const bad = res.repos.filter((r) => !r.ok)
    toast(bad.length ? `일부 실패: ${bad.map((b) => `${b.repo.split('/')[1]} — ${b.error}`).join(', ')}` : `받았어요${res.sent ? ` · 코멘트 ${res.sent}개 올림` : ''}`, !!bad.length)
  } catch (e) {
    toast((e as Error).message, true)
  } finally {
    syncing = false
    void drawBar()
    // re-read what was just received, but never pull an open PDF out from under the reader
    if (!/\/pdf\//.test(location.hash)) void route()
  }
}

function toast(msg: string, bad = false) {
  const t = h('div', { class: `toast ${bad ? 'bad' : ''}` }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), bad ? 8000 : 3000)
}

// ---------- pages ----------

const main = h('main', {})
app.append(bar, main)

async function home() {
  if (!settings.token) { location.hash = '#/settings'; return }
  const cards: HTMLElement[] = []
  for (const ref of settings.repos) {
    const r = (await repo(repoKey(ref)))!
    const yaml = await readText(r.key, r.files.get('workbench/research.yaml'))
    let info: { title?: string; question?: string } = {}
    try { info = yaml ? (parseYaml(yaml) as typeof info) ?? {} : {} } catch { /* show the repo name */ }
    const pdfs = [...r.files.values()].filter((f) => /\.pdf$/i.test(f.path)).length
    const blocks = [...r.files.keys()].filter((p) => /^workbench\/blocks\/.*\.tex$/.test(p)).length
    if (!yaml && !pdfs) continue
    cards.push(h('a', { class: 'card', href: `#/r/${r.key}` },
      h('div', { class: 'card-title' }, info.title ?? ref.repo),
      info.question ? h('div', { class: 'muted' }, String(info.question)) : null,
      h('div', { class: 'small muted' }, r.snap ? `블록 ${blocks} · PDF ${pdfs} · 받은 때 ${fmtTime(r.snap.syncedAt)}` : '아직 받지 않음')))
  }
  main.replaceChildren(h('h1', {}, '연구'), cards.length ? h('div', { class: 'cards' }, cards) : h('p', { class: 'muted' }, '아직 받은 연구가 없어요. 위의 동기화를 눌러 주세요.'))
}

type Tab = 'blocks' | 'logs' | 'pdfs' | 'comments'
const TABS: [Tab, string][] = [['blocks', '블록'], ['logs', '일지'], ['pdfs', 'PDF'], ['comments', '코멘트']]

function repoHeader(r: Repo, title: string, tab: Tab | null) {
  return h('div', {},
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, '연구'), ' / ', h('a', { href: `#/r/${r.key}` }, title)),
    h('nav', { class: 'tabs' }, TABS.map(([t, label]) => h('a', { class: t === tab ? 'on' : '', href: `#/r/${r.key}/${t}` }, label))))
}

async function researchTitle(r: Repo) {
  const yaml = await readText(r.key, r.files.get('workbench/research.yaml'))
  try { return (yaml && (parseYaml(yaml) as { title?: string })?.title) || r.ref.repo } catch { return r.ref.repo }
}

interface BlockInfo { id: string; path: string; title: string; status: string; parent?: string; created?: string; next?: string }
async function blocksOf(r: Repo): Promise<BlockInfo[]> {
  const out: BlockInfo[] = []
  for (const f of r.files.values()) {
    const m = /^workbench\/blocks\/(.+)\.tex$/.exec(f.path)
    if (!m) continue
    const meta = blockMeta((await readText(r.key, f)) ?? '')
    out.push({ id: meta.id ?? m[1]!, path: f.path, title: meta.title ?? m[1]!, status: meta.status ?? '', parent: meta.parent, created: meta.created, next: meta.next })
  }
  return out
}
const STATUS: Record<string, string> = { 'in-progress': '진행 중', blocked: '막힘', stopped: '중지', abandoned: '중지', resolved: '해결', done: '해결' }

async function blocksPage(r: Repo) {
  const blocks = await blocksOf(r)
  const byParent = new Map<string, BlockInfo[]>()
  const ids = new Set(blocks.map((b) => b.id))
  for (const b of blocks) {
    const p = b.parent && ids.has(b.parent) ? b.parent : ''
    byParent.set(p, [...(byParent.get(p) ?? []), b])
  }
  const tree = (p: string, depth: number): HTMLElement[] => (byParent.get(p) ?? []).sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.title.localeCompare(b.title))
    .flatMap((b) => [h('a', { class: 'item', href: `#/r/${r.key}/block/${encodeURIComponent(b.id)}`, style: `padding-left:${12 + depth * 20}px` },
      h('span', { class: `chip st-${b.status}` }, STATUS[b.status] ?? (b.status || '—')), h('span', {}, b.title)), ...tree(b.id, depth + 1)])
  main.replaceChildren(repoHeader(r, await researchTitle(r), 'blocks'), blocks.length ? h('div', { class: 'list' }, tree('', 0)) : h('p', { class: 'muted' }, '블록이 없어요'))
}

async function blockPage(r: Repo, id: string) {
  const blocks = await blocksOf(r)
  const b = blocks.find((x) => x.id === id)
  if (!b) { main.replaceChildren(h('p', {}, '블록을 찾을 수 없어요')); return }
  const src = (await readText(r.key, r.files.get(b.path))) ?? ''
  const macros = await macrosFor(r)
  const children = blocks.filter((x) => x.parent === b.id)
  const parent = blocks.find((x) => x.id === b.parent)
  main.replaceChildren(...[
    repoHeader(r, await researchTitle(r), null),
    h('div', { class: 'meta' },
      h('span', { class: `chip st-${b.status}` }, STATUS[b.status] ?? b.status),
      parent ? h('span', {}, '위: ', h('a', { href: `#/r/${r.key}/block/${encodeURIComponent(parent.id)}` }, parent.title)) : null,
      children.length ? h('span', {}, '아래: ', children.flatMap((c, i) => [i ? ', ' : '', h('a', { href: `#/r/${r.key}/block/${encodeURIComponent(c.id)}` }, c.title)])) : null),
    b.next ? h('div', { class: 'next' }, h('b', {}, '다음: '), h('span', { html: markdownToHtml(b.next, macros).replace(/^<p>|<\/p>\s*$/g, '') })) : null,
    h('article', { class: 'tex', html: texToHtml(src, macros) }),
    blockNotes(src).length ? h('div', { class: 'notes' }, h('div', { class: 'small muted' }, '원본의 메모 줄'), h('ul', {}, blockNotes(src).map((n) => h('li', { html: markdownToHtml(n, macros).replace(/^<p>|<\/p>\s*$/g, '') })))) : null,
    await commentsPanel(r, blockTarget(b.id, b.title), macros)].filter((x): x is HTMLElement => !!x))
}

async function logsPage(r: Repo) {
  const logs = [...r.files.keys()].map((p) => /^workbench\/log\/(.+)\.md$/.exec(p)?.[1]).filter((x): x is string => !!x).sort().reverse()
  const macros = await macrosFor(r)
  const parts: HTMLElement[] = []
  for (const d of logs) {
    const text = (await readText(r.key, r.files.get(`workbench/log/${d}.md`))) ?? ''
    parts.push(h('article', { class: 'log md' }, h('div', { html: markdownToHtml(text, macros) }),
      h('a', { class: 'small', href: `#/r/${r.key}/log/${encodeURIComponent(d)}` }, '이 날에 코멘트')))
  }
  main.replaceChildren(repoHeader(r, await researchTitle(r), 'logs'), parts.length ? h('div', {}, parts) : h('p', { class: 'muted' }, '일지가 없어요'))
}

async function logPage(r: Repo, d: string) {
  const macros = await macrosFor(r)
  const text = (await readText(r.key, r.files.get(`workbench/log/${d}.md`))) ?? ''
  main.replaceChildren(repoHeader(r, await researchTitle(r), 'logs'), h('article', { class: 'log md', html: markdownToHtml(text, macros) }), await commentsPanel(r, logTarget(d), macros))
}

async function pdfsPage(r: Repo) {
  const pdfs = [...r.files.values()].filter((f) => /\.pdf$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))
  const groups = new Map<string, TreeEntry[]>()
  for (const f of pdfs) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '/'
    groups.set(dir, [...(groups.get(dir) ?? []), f])
  }
  const rows: HTMLElement[] = []
  for (const [dir, fs] of groups) {
    rows.push(h('div', { class: 'group' }, dir))
    for (const f of fs) {
      const kept = !!(await readBytes(r.key, f))
      rows.push(h('a', { class: 'item', href: `#/r/${r.key}/pdf/${encodeURIComponent(f.path)}` },
        h('span', {}, f.path.split('/').pop()), h('span', { class: 'sp' }),
        h('span', { class: 'small muted' }, `${fmtSize(f.size)}${kept ? '' : f.size > MAX_PDF_BYTES ? ' · 너무 커서 보관 안 함' : ' · 아직 안 받음'}`)))
    }
  }
  main.replaceChildren(repoHeader(r, await researchTitle(r), 'pdfs'), rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'GitHub에 올라간 PDF가 없어요. 맥에서 결과 PDF를 커밋해 올리면 여기에 보여요.'))
}

async function pdfPage(r: Repo, path: string) {
  const f = r.files.get(path)
  const name = path.split('/').pop()!
  const data = f && (await readBytes(r.key, f))
  const macros = await macrosFor(r)
  const target = paperTarget(name)
  let page = 1
  let sel: PdfSelection | null = null
  const pageLabel = h('span', { class: 'muted small' }, '')
  const selBtn = h('button', { class: 'btn on floating', hidden: true, onmousedown: (e: Event) => e.preventDefault(), onclick: () => {
    const s = sel
    compose(r, target, { page: s?.page ?? page, quote: s?.text }, () => void refreshComments())
  } }, '고른 글에 코멘트')
  const host = h('div', { class: 'pdf' })
  const side = h('div', { class: 'pdf-comments' })
  const refreshComments = async () => side.replaceChildren(await commentsPanel(r, target, macros, () => ({ page, quote: sel?.text })))
  main.replaceChildren(
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, '연구'), ' / ', h('a', { href: `#/r/${r.key}/pdfs` }, await researchTitle(r)), ' / ', name),
    h('div', { class: 'row pdf-bar' }, pageLabel, h('span', { class: 'sp' }),
      h('button', { class: 'btn', onclick: () => compose(r, target, { page }, () => void refreshComments()) }, '이 쪽에 코멘트'),
      h('button', { class: 'btn ghost', onclick: () => side.scrollIntoView({ behavior: 'smooth' }) }, '코멘트 보기')),
    data ? host : h('p', { class: 'muted' }, '이 PDF는 아직 iPad에 없어요. 인터넷이 될 때 동기화해 주세요.'),
    side, selBtn)
  await refreshComments()
  if (!data) return
  const view = await mountPdf(host, data, {
    onSelect: (s) => { sel = s; selBtn.hidden = !s },
    onPage: (p) => { page = p; pageLabel.textContent = `${p} / ${view?.pages ?? ''}쪽` },
  })
  cleanup = () => view.destroy()
}

async function commentsPage(r: Repo) {
  const macros = await macrosFor(r)
  const targets = new Map<string, string>()
  for (const f of r.snap?.files ?? []) {
    const m = new RegExp(`^${COMMENTS_DIR}/([^/]+)\\.md$`).exec(f.path)
    if (m) targets.set(m[1]!, parseComments(m[1]!, (await readText(r.key, f)) ?? '').title)
    if (f.path.startsWith(`${INBOX_DIR}/`)) {
      const t = (await readText(r.key, f)) ?? ''
      const tg = inboxTarget(t)
      if (tg && !targets.has(tg)) targets.set(tg, parseComments(tg, t).title)
    }
  }
  for (const q of await outbox()) if (q.repo === r.key && !targets.has(q.target)) targets.set(q.target, parseComments(q.target, q.content).title)
  const sections: HTMLElement[] = []
  for (const [t, title] of [...targets].sort((a, b) => a[1].localeCompare(b[1]))) {
    const list = await commentsFor(r, t)
    if (!list.length) continue
    const open = list.filter((c) => c.kind === '질문' && c.state === '대기').length
    sections.push(h('section', { class: 'comments' }, h('h3', {}, title, open ? h('span', { class: 'chip warn' }, `답 기다림 ${open}`) : null), list.map((c) => commentView(c, macros, () => void route()))))
  }
  main.replaceChildren(repoHeader(r, await researchTitle(r), 'comments'), sections.length ? h('div', {}, sections) : h('p', { class: 'muted' }, '코멘트가 없어요'))
}

async function settingsPage() {
  const token = h('input', { type: 'password', value: settings.token, placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const repos = h('textarea', { rows: 4, autocapitalize: 'off', spellcheck: 'false' })
  repos.value = settings.repos.map(repoKey).join('\n')
  const status = h('div', { class: 'small' })
  const use = await db.usage()
  main.replaceChildren(
    h('h1', {}, '설정'),
    h('label', {}, 'GitHub 토큰'), token,
    h('div', { class: 'help small' },
      h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'fine-grained 토큰 만들기'),
      ' · Repository access: Only select repositories에서 아래 저장소를 고르고, Permissions › Repository permissions › Contents를 Read and write로. 토큰은 이 iPad 안에만 저장돼요. 잃어버리면 GitHub에서 토큰을 지우면 돼요.'),
    h('label', {}, '저장소 (한 줄에 하나, owner/name)'), repos,
    h('div', { class: 'row' },
      h('button', { class: 'btn on', onclick: async () => {
        const list = repos.value.split('\n').map((s) => s.trim()).filter(Boolean)
        const parsed = list.map(parseRepo)
        if (parsed.some((p) => !p)) { status.textContent = '저장소 이름을 owner/name으로 적어 주세요'; return }
        settings = { token: token.value.trim(), repos: parsed as RepoRef[] }
        await saveSettings(settings)
        status.textContent = '확인 중…'
        try {
          const who = await new GitHub(settings.token).user()
          status.textContent = `저장했어요 (${who}). 받기를 시작해요.`
          await db.persist()
          void runSync()
        } catch (e) { status.textContent = `저장했지만 확인 실패: ${(e as Error).message}` }
        void drawBar()
      } }, '저장하고 받기'),
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!confirm('토큰을 이 iPad에서 지울까요? 받아 둔 내용과 올릴 코멘트는 남아요.')) return
        settings = { ...settings, token: '' }
        await saveSettings(settings)
        void settingsPage(); void drawBar()
      } }, '토큰 지우기')),
    status,
    h('h3', {}, '이 iPad에 보관한 것'),
    h('p', { class: 'small muted' }, use ? `${fmtSize(use.used)} 사용` : ''),
    h('p', { class: 'small muted' }, 'Safari에서 공유 › 홈 화면에 추가로 설치하면 인터넷 없이도 열려요. 블록·일지·코멘트와 40 MB 이하 PDF를 받아 두고, 코멘트는 workbench/comments/inbox/에 새 파일로만 올려요. 원고와 다른 파일은 바꾸지 않아요.'))
}

// ---------- router ----------

async function route() {
  cleanup?.(); cleanup = null
  window.scrollTo(0, 0)
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  try {
    if (parts[0] === 'settings') return await settingsPage()
    if (parts[0] === 'r' && parts[1] && parts[2]) {
      const r = await repo(`${parts[1]}/${parts[2]}`)
      if (!r) return await home()
      const [tab, arg] = [parts[3], parts.slice(4).join('/')]
      if (tab === 'block' && arg) return await blockPage(r, arg)
      if (tab === 'log' && arg) return await logPage(r, arg)
      if (tab === 'pdf' && arg) return await pdfPage(r, arg)
      if (tab === 'logs') return await logsPage(r)
      if (tab === 'pdfs') return await pdfsPage(r)
      if (tab === 'comments') return await commentsPage(r)
      const hasBlocks = [...r.files.keys()].some((p) => p.startsWith('workbench/blocks/'))
      return await (hasBlocks ? blocksPage(r) : pdfsPage(r))
    }
    return await home()
  } catch (e) {
    main.replaceChildren(h('p', { class: 'error' }, `열지 못했어요: ${escapeHtml((e as Error).message)}`))
  }
}

window.addEventListener('hashchange', () => void route())
window.addEventListener('online', () => { void drawBar(); void sendQueued() })
window.addEventListener('offline', () => void drawBar())

void (async () => {
  settings = await loadSettings()
  await drawBar()
  await route()
  if (settings.token && navigator.onLine) void runSync()
})()
