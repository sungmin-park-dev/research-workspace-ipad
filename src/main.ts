import 'katex/dist/katex.min.css'
import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { parse as parseYaml } from 'yaml'
import { blockTarget, buildInboxComment, COMMENTS_DIR, INBOX_DIR, inboxTarget, logTarget, paperTarget, parseComments, type CommentEntry, type CommentKind, type CommentTarget, type OutboxItem } from './comments'
import * as db from './db'
import { GitHub, parseRepo, repoKey, type RepoRef, type TreeEntry } from './github'
import { mountPdf, type PdfSelection } from './pdf'
import { DEFAULT_REPOS, syncRepo, enqueue, dropQueued, flushOutbox, loadSettings, MAX_PDF_BYTES, outbox, readBytes, readText, saveSettings, snapshotOf, syncAll, type Settings, type Snapshot } from './sync'
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
const fill = (el: Element, ...children: (Child | Child[])[]) => {
  el.replaceChildren()
  for (const c of children.flat()) if (c != null && c !== false) el.append(c)
}

/** Line icons, drawn like the Mac app's (24 grid, 1.7 stroke) */
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5"/><path d="M5 3v4h4M19 21v-4h-4"/>',
  research: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 8.2v7.6M8.2 6h3.3a3 3 0 0 1 3 3v.8M14.5 12h1.3"/>',
  comment: '<path d="M5 5h14v10H9l-4 4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
}
const icon = (name: keyof typeof ICONS) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('class', 'i')
  s.setAttribute('aria-hidden', 'true')
  s.innerHTML = ICONS[name]
  return s
}

const app = document.getElementById('app')!
const fmtTime = (iso?: string) => {
  if (!iso) return '없음'
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  if (mins < 24 * 60 && d.getDate() === new Date().getDate()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const inlineMd = (s: string, macros: Macros) => markdownToHtml(s, macros).replace(/^<p>|<\/p>\s*$/g, '')

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
const allRepos = async () => (await Promise.all(settings.repos.map((r) => repo(repoKey(r))))).filter((r): r is Repo => !!r)

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

async function researchTitle(r: Repo) {
  const yaml = await readText(r.key, r.files.get('workbench/research.yaml'))
  try { return (yaml && (parseYaml(yaml) as { title?: string })?.title) || r.ref.repo } catch { return r.ref.repo }
}

// ---------- blocks and their status glyphs (same shapes as the Mac app) ----------

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
type Kind = 'progress' | 'blocked' | 'stopped' | 'solved' | 'none'
const KIND: Record<string, Kind> = { 'in-progress': 'progress', blocked: 'blocked', stopped: 'stopped', abandoned: 'stopped', resolved: 'solved', done: 'solved' }
const GLYPH: Record<Kind, [string, string]> = { progress: ['●', '진행 중'], blocked: ['◆', '막힘'], stopped: ['■', '중지'], solved: ['✓', '해결'], none: ['○', '상태 없음'] }
const kindOf = (b: BlockInfo): Kind => KIND[b.status] ?? 'none'
const glyph = (k: Kind) => h('span', { class: `g ${k}`, title: GLYPH[k][1] }, GLYPH[k][0])
const blockHref = (r: Repo, id: string) => `#/r/${r.key}/block/${encodeURIComponent(id)}`
const byCreated = (a: BlockInfo, b: BlockInfo) => (a.created ?? '').localeCompare(b.created ?? '') || a.title.localeCompare(b.title)
/** In-progress blocks with no in-progress child: the ends of the branches being worked on */
const branchEnds = (blocks: BlockInfo[]) => blocks.filter((b) => kindOf(b) === 'progress' && !blocks.some((c) => c.parent === b.id && kindOf(c) === 'progress')).sort((a, b) => byCreated(b, a))

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

/** Every comment target in a repository, with its display title */
async function targetsOf(r: Repo): Promise<Map<string, string>> {
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
  return targets
}

/** Where a comment target lives in this app, so a comment list can link back to what it is about */
async function targetHref(r: Repo, target: string): Promise<string | null> {
  if (target.startsWith('block-')) {
    const b = (await blocksOf(r)).find((x) => blockTarget(x.id).target === target)
    return b ? blockHref(r, b.id) : null
  }
  if (target.startsWith('paper-')) {
    const f = [...r.files.values()].find((x) => /\.pdf$/i.test(x.path) && paperTarget(x.path.split('/').pop()!).target === target)
    return f ? `#/r/${r.key}/pdf/${encodeURIComponent(f.path)}` : null
  }
  if (target.startsWith('log-')) return `#/r/${r.key}/log/${encodeURIComponent(target.slice(4))}`
  return null
}
const shortTitle = (title: string) => title.replace(/^(작업노트 결과|자료|일지) /, '')

const isMine = (by: string) => !/^(claude|agent|에이전트)/i.test(by)
function commentView(c: ShownComment, macros: Macros, onChange: () => void): HTMLElement {
  const upload = c.origin === 'queued' && !c.queued?.sentAt
    ? c.queued?.error ? h('span', { class: 'st bad' }, '올리지 못함') : h('span', { class: 'st wait' }, '올릴 차례')
    : null
  const state = c.kind === '질문'
    ? c.answers.length || c.state === '답함' ? h('span', { class: 'st done' }, '✓ 답함') : c.state === '끝냄' ? h('span', { class: 'st plain' }, '끝냄') : upload ? null : h('span', { class: 'st wait' }, '답 기다림')
    : c.state === '끝냄' ? h('span', { class: 'st plain' }, '끝냄') : null
  return h('div', { class: 'cm' },
    h('div', { class: 'cm-head' },
      h('span', { class: 'who' }, '나'), h('span', { class: 'tag' }, c.kind), h('span', {}, c.where),
      h('span', { class: 'sp' }), upload, state,
      c.origin === 'queued' && !c.queued?.sentAt ? h('button', { class: 'btn quiet', style: 'height:26px', onclick: async () => { if (confirm('아직 올리지 않은 이 코멘트를 지울까요?')) { await dropQueued(c.queued!.id); onChange() } } }, '지우기') : null),
    c.quote ? h('blockquote', {}, c.quote) : null,
    c.body ? h('div', { class: 'md', html: markdownToHtml(c.body, macros) }) : null,
    c.queued?.error ? h('div', { class: 'error small' }, c.queued.error) : null,
    c.answers.map((a) => h('div', { class: 'ans' },
      h('div', { class: 'cm-head' }, isMine(a.by) ? h('span', { class: 'who' }, a.by.slice(0, 1)) : h('span', { class: 'who agent' }, 'C'), h('span', {}, `${isMine(a.by) ? a.by : 'Claude'} · ${a.at}`)),
      h('div', { class: 'md', html: markdownToHtml(a.body, macros) }))))
}

/** While a question on the open screen waits for an answer, check GitHub every so often and redraw when it arrives */
const ANSWER_POLL_MS = 30_000
const ANSWER_POLL_FOR_MS = 30 * 60_000
let answerWatch: { timer: number; key: string } | null = null
function stopAnswerWatch() {
  if (answerWatch) clearInterval(answerWatch.timer)
  answerWatch = null
}
const waitingForAnswer = (c: ShownComment) => c.kind === '질문' && c.state === '대기' && !c.answers.length && !(c.origin === 'queued' && !c.queued?.sentAt)

async function commentsPanel(r: Repo, target: CommentTarget, macros: Macros, extra: () => { page?: number; quote?: string } = () => ({})): Promise<HTMLElement> {
  const box = h('section', { class: 'thread' })
  const key = `${r.key}|${target.target}`
  const started = Date.now()
  const draw = async () => {
    const fresh = (await repo(r.key)) ?? r
    const list = await commentsFor(fresh, target.target)
    const waiting = list.some(waitingForAnswer)
    fill(box,
      h('div', { class: 'sec-head' }, h('h2', {}, '코멘트'), h('span', { class: 'count' }, list.length ? String(list.length) : ''), h('span', { class: 'sp' }),
        h('button', { class: 'btn', onclick: () => compose(r, target, extra(), () => void draw()) }, '질문·코멘트 남기기')),
      waiting ? h('div', { class: 'waiting' }, h('i'), settings.token && navigator.onLine ? 'Claude의 답을 기다리는 중이에요. 이 화면에 있으면 답이 오는 대로 보여요.' : '인터넷이 연결되면 답을 받아 와요.') : null,
      list.length ? list.map((c) => commentView(c, macros, () => void draw())) : h('div', { class: 'empty' }, '아직 없어요. 궁금한 데를 Claude에게 물어보세요.'))
    if (waiting && (!answerWatch || answerWatch.key !== key)) {
      stopAnswerWatch()
      answerWatch = {
        key,
        timer: window.setInterval(async () => {
          if (!box.isConnected || Date.now() - started > ANSWER_POLL_FOR_MS) { stopAnswerWatch(); return }
          if (syncing || !settings.token || !navigator.onLine) return
          await sendQueued()
          const res = await syncRepo(new GitHub(settings.token), r.ref, new Map())
          if (res.ok) { void drawBar(); await draw() }
        }, ANSWER_POLL_MS),
      }
    } else if (!waiting && answerWatch?.key === key) stopAnswerWatch()
  }
  await draw()
  return box
}

/** The composer sheet, shaped like the Mac app's memo input. Saving only queues; sending happens right away if online, otherwise at the next sync. */
function compose(r: Repo, target: CommentTarget, at: { page?: number; quote?: string }, done: () => void) {
  let kind: CommentKind = '질문'
  const ta = h('textarea', { rows: 4, placeholder: '무엇이 궁금한가요?' })
  const hint = h('span', { class: 'hint' })
  const send = h('button', { class: 'send', 'aria-label': '보내기' }, icon('send'))
  const kinds = h('div', { class: 'chips' })
  const drawKinds = () => {
    kinds.replaceChildren(...(['질문', '코멘트'] as CommentKind[]).map((k) =>
      h('button', { class: `chip ${k === kind ? 'on' : ''}`, onclick: () => { kind = k; drawKinds() } }, k === '질문' ? '질문 · Claude에게' : '코멘트')))
    ta.placeholder = kind === '질문' ? '무엇이 궁금한가요?' : '남길 말'
    hint.textContent = `${navigator.onLine && settings.token ? '바로 올려요' : '연결되면 올려요'}${kind === '질문' ? ' · 답은 이 화면에 와요' : ''}`
  }
  drawKinds()
  ta.addEventListener('input', () => send.classList.toggle('ready', !!ta.value.trim()))
  const err = h('div', { class: 'error small' })
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  send.addEventListener('click', async () => {
    if (!ta.value.trim()) { ta.focus(); return }
    try {
      const item = buildInboxComment(r.key, { kind, target, page: at.page, quote: at.quote, text: ta.value })
      await enqueue(item)
      close()
      done()
      void sendQueued().then(done)
    } catch (e) { err.textContent = (e as Error).message }
  })
  const sheet = h('div', { class: 'sheet-bg', onclick: (e: Event) => { if (e.target === sheet) close() } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': '질문·코멘트 남기기' },
      h('div', { class: 'grab' }),
      h('div', { class: 'sheet-head' }, h('b', {}, shortTitle(target.title)), h('span', { class: 'sp' }), at.page ? h('span', {}, `${at.page}쪽`) : null,
        h('button', { class: 'btn quiet', onclick: close }, '닫기')),
      kinds,
      at.quote ? h('blockquote', {}, at.quote) : null,
      h('div', { class: 'memo' }, ta, h('div', { class: 'memo-bar' }, hint, h('span', { class: 'sp' }), send)),
      err))
  document.body.append(sheet)
  document.addEventListener('keydown', onKey)
  ta.focus()
}

async function sendQueued() {
  if (!settings.token || !navigator.onLine || !(await outbox()).some((x) => !x.sentAt)) return
  await flushOutbox(new GitHub(settings.token), new Map())
  void drawBar()
}

// ---------- top bar (Mac title bar) and bottom tabs (Mac rail) ----------

const bar = h('header', { class: 'top' })
let barBack: string | null = null
let barPlace: Child[] = ['연구 작업대']
function setTop(back: string | null, ...place: Child[]) {
  barBack = back
  barPlace = place
  void drawBar()
}
async function drawBar() {
  const q = (await outbox()).filter((x) => !x.sentAt).length
  const snaps = await Promise.all(settings.repos.map((r) => snapshotOf(repoKey(r))))
  const last = snaps.map((s) => s?.syncedAt).filter(Boolean).sort().at(0)
  const online = navigator.onLine
  const state = syncing ? syncNote : !online ? `오프라인 · ${fmtTime(last)}` : q ? `올릴 것 ${q}` : `${fmtTime(last)} 동기화`
  fill(bar,
    barBack ? h('a', { class: 'icon-btn', href: barBack, 'aria-label': '뒤로' }, icon('back')) : null,
    h('span', { class: 'place' }, ...barPlace),
    h('span', { class: `sync ${!online ? 'off' : q || syncing ? 'wait' : ''}` }, h('i'), state),
    h('button', { class: `icon-btn ${syncing ? 'spin' : ''}`, 'aria-label': '동기화', title: '동기화', disabled: syncing || !settings.token, onclick: () => void runSync() }, icon('sync')))
  void drawTabs(q)
}

const tabs = h('nav', { class: 'tabbar', 'aria-label': '공간' })
let openQuestions = 0
async function drawTabs(unsent?: number) {
  const q = unsent ?? (await outbox()).filter((x) => !x.sentAt).length
  const here = location.hash.replace(/^#\/?/, '').split('/')[0]
  const n = openQuestions + q
  fill(tabs,
    h('a', { href: '#/', class: here === 'comments' || here === 'settings' ? '' : 'on' }, icon('research'), '연구'),
    h('a', { href: '#/comments', class: here === 'comments' ? 'on' : '' }, icon('comment'), '코멘트', n ? h('span', { class: 'badge', title: '답 기다림·올릴 것' }, String(n)) : null),
    h('a', { href: '#/settings', class: here === 'settings' ? 'on' : '' }, icon('settings'), '설정'))
}
async function countOpenQuestions() {
  let n = 0
  for (const r of await allRepos()) for (const t of (await targetsOf(r)).keys()) n += (await commentsFor(r, t)).filter(waitingForAnswer).length
  openQuestions = n
  void drawTabs()
}

async function runSync() {
  if (syncing || !settings.token) return
  syncing = true
  syncNote = '받는 중'
  void drawBar()
  try {
    const res = await syncAll(settings, (p) => { syncNote = p.total ? `${p.phase} ${p.done + 1}/${p.total}` : p.phase; void drawBar() })
    const bad = res.repos.filter((r) => !r.ok)
    toast(bad.length ? `일부 실패: ${bad.map((b) => `${b.repo.split('/')[1]} — ${b.error}`).join(', ')}` : `받았어요${res.sent ? ` · 코멘트 ${res.sent}개 올림` : ''}`, !!bad.length)
  } catch (e) {
    toast((e as Error).message, true)
  } finally {
    syncing = false
    void drawBar()
    void countOpenQuestions()
    // re-read what was just received, but never pull an open PDF out from under the reader
    if (!/\/pdf\//.test(location.hash)) void route()
  }
}

function toast(msg: string, bad = false) {
  const t = h('div', { class: `toast ${bad ? 'bad' : ''}`, role: 'status' }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), bad ? 8000 : 3000)
}

// ---------- pages ----------

const main = h('main', {})
app.append(bar, main, tabs)
const show = (...nodes: Child[]) => { main.className = ''; main.replaceChildren(...nodes.filter((n): n is Node | string => !!n)) }

interface Answered { r: Repo; target: string; title: string; c: ShownComment; at: string }
async function home() {
  if (!settings.token) { location.hash = '#/settings'; return }
  setTop(null, h('b', {}, '연구 작업대'))
  const cards: HTMLElement[] = []
  const answered: Answered[] = []
  for (const r of await allRepos()) {
    const yaml = await readText(r.key, r.files.get('workbench/research.yaml'))
    let info: { title?: string; question?: string } = {}
    try { info = yaml ? (parseYaml(yaml) as typeof info) ?? {} : {} } catch { /* show the repo name */ }
    const pdfs = [...r.files.values()].filter((f) => /\.pdf$/i.test(f.path)).length
    const blocks = await blocksOf(r)
    for (const [t, title] of await targetsOf(r))
      for (const c of await commentsFor(r, t)) if (c.kind === '질문' && c.answers.length) answered.push({ r, target: t, title, c, at: c.answers.at(-1)!.at })
    if (!yaml && !pdfs && !blocks.length) continue
    const counts = (['solved', 'progress', 'blocked', 'stopped'] as Kind[]).map((k) => [k, blocks.filter((b) => kindOf(b) === k).length] as const).filter(([, n]) => n)
    const next = branchEnds(blocks)[0]
    cards.push(h('a', { class: 'card', href: `#/r/${r.key}` },
      h('span', { class: 't' }, info.title ?? r.ref.repo),
      info.question ? h('span', { class: 'd' }, String(info.question)) : null,
      blocks.length ? h('div', { class: 'progress-bar', 'aria-hidden': 'true' }, counts.map(([k, n]) => h('span', { style: `width:${(100 * n) / blocks.length}%;background:var(--s-${k})` }))) : null,
      h('div', { class: 'f' },
        counts.map(([k, n]) => h('span', {}, glyph(k), String(n))),
        pdfs ? h('span', {}, `PDF ${pdfs}`) : null,
        r.snap ? null : h('span', {}, '아직 받지 않음')),
      next ? h('span', { class: 'd' }, `이어서 · ${next.title}`) : null))
  }
  answered.sort((a, b) => b.at.localeCompare(a.at))
  const recent: HTMLElement[] = []
  for (const a of answered.slice(0, 3)) {
    const href = await targetHref(a.r, a.target)
    recent.push(h('a', { class: 'row', href: href ?? `#/r/${a.r.key}/comments` }, glyph('solved'),
      h('div', {}, h('div', { class: 't' }, (a.c.body || a.c.quote || '질문').split('\n')[0]!.slice(0, 80)), h('div', { class: 'd' }, `Claude · ${shortTitle(a.title)}`)),
      h('span', { class: 'm' }, a.at.slice(5))))
  }
  show(
    h('div', {}, h('h1', { class: 'h-title' }, '연구'), h('p', { class: 'h-sub' }, '인터넷 없이도 읽을 수 있어요. 질문과 코멘트는 연결되면 올려요.')),
    recent.length ? h('section', {}, h('div', { class: 'sec-head' }, h('h2', {}, '최근 답'), h('span', { class: 'count' }, String(answered.length))), h('div', { class: 'rows' }, recent)) : null,
    cards.length ? h('section', {}, h('div', { class: 'sec-head' }, h('h2', {}, '연구'), h('span', { class: 'count' }, String(cards.length))), h('div', { class: 'cards' }, cards))
      : h('div', { class: 'empty' }, '아직 받은 연구가 없어요. 위의 동기화 버튼을 눌러 주세요.'))
}

type Tab = 'blocks' | 'logs' | 'pdfs' | 'comments'
const TABS: [Tab, string][] = [['blocks', '블록'], ['logs', '일지'], ['pdfs', 'PDF'], ['comments', '코멘트']]

/** Top bar place and the screen switcher for one research */
async function repoTop(r: Repo, tab: Tab | null, back: string | null = '#/', ...tail: Child[]) {
  const title = await researchTitle(r)
  setTop(back, ...(tail.length ? tail : ['연구 › ', h('b', {}, title)]))
  return tab ? h('nav', { class: 'seg', 'aria-label': '화면' }, TABS.map(([t, label]) => h('a', { class: t === tab ? 'on' : '', href: `#/r/${r.key}/${t}` }, label))) : null
}

async function blocksPage(r: Repo) {
  const seg = await repoTop(r, 'blocks')
  const blocks = await blocksOf(r)
  const macros = await macrosFor(r)
  const byParent = new Map<string, BlockInfo[]>()
  const ids = new Set(blocks.map((b) => b.id))
  for (const b of blocks) {
    const p = b.parent && ids.has(b.parent) ? b.parent : ''
    byParent.set(p, [...(byParent.get(p) ?? []), b])
  }
  const tree = (p: string): HTMLElement[] => (byParent.get(p) ?? []).sort(byCreated).flatMap((b) => {
    const kids = tree(b.id)
    return [h('a', { class: 'nav', href: blockHref(r, b.id) }, glyph(kindOf(b)), h('span', { class: 'label' }, b.title)), ...(kids.length ? [h('div', { class: 'tree' }, kids)] : [])]
  })
  const ends = branchEnds(blocks)
  show(seg,
    ends.length ? h('section', {}, h('div', { class: 'sec-head' }, h('h2', {}, '이어서 할 것'), h('span', { class: 'count' }, '진행 중인 가지 끝')),
      h('div', { class: 'rows' }, ends.slice(0, 4).map((b) => h('a', { class: 'row', href: blockHref(r, b.id) }, glyph('progress'),
        h('div', {}, h('div', { class: 't' }, b.title), b.next ? h('div', { class: 'd', html: `다음 · ${inlineMd(b.next, macros)}` }) : null), h('span'))))) : null,
    blocks.length ? h('section', {}, h('div', { class: 'sec-head' }, h('h2', {}, '블록'), h('span', { class: 'count' }, String(blocks.length))), h('div', { class: 'tree-list' }, tree('')))
      : h('div', { class: 'empty' }, '블록이 없어요'))
}

async function blockPage(r: Repo, id: string) {
  const blocks = await blocksOf(r)
  const b = blocks.find((x) => x.id === id)
  if (!b) { await repoTop(r, null, `#/r/${r.key}/blocks`); show(h('div', { class: 'empty' }, '블록을 찾을 수 없어요')); return }
  const src = (await readText(r.key, r.files.get(b.path))) ?? ''
  const macros = await macrosFor(r)
  const children = blocks.filter((x) => x.parent === b.id).sort(byCreated)
  const parent = blocks.find((x) => x.id === b.parent)
  await repoTop(r, null, parent ? blockHref(r, parent.id) : `#/r/${r.key}/blocks`, parent ? `${parent.title} › ` : `${await researchTitle(r)} › `, h('b', {}, b.title))
  const k = kindOf(b)
  const link = (x: BlockInfo) => h('a', { href: blockHref(r, x.id) }, glyph(kindOf(x)), ' ', x.title)
  const notes = blockNotes(src)
  show(
    h('header', { class: 'doc-head' },
      h('div', { class: 'pills' }, h('span', { class: 'pill' }, glyph(k), GLYPH[k][1])),
      h('h1', {}, b.title),
      parent || children.length || b.next ? h('dl', { class: 'props' },
        parent ? [h('dt', {}, '위'), h('dd', {}, link(parent))] : [],
        children.length ? [h('dt', {}, '아래'), h('dd', {}, children.flatMap((c, i) => [i ? h('br') : null, link(c)]))] : [],
        b.next ? [h('dt', {}, '다음'), h('dd', { html: inlineMd(b.next, macros) })] : []) : null),
    h('article', { class: 'tex', html: texToHtml(src, macros) }),
    notes.length ? h('div', { class: 'notes' }, h('div', { class: 'muted' }, '원본의 메모 줄'), h('ul', {}, notes.map((n) => h('li', { html: inlineMd(n, macros) })))) : null,
    await commentsPanel(r, blockTarget(b.id, b.title), macros))
}

async function logsPage(r: Repo) {
  const seg = await repoTop(r, 'logs')
  const logs = [...r.files.keys()].map((p) => /^workbench\/log\/(.+)\.md$/.exec(p)?.[1]).filter((x): x is string => !!x).sort().reverse()
  const macros = await macrosFor(r)
  const parts: HTMLElement[] = []
  for (const d of logs) {
    const text = (await readText(r.key, r.files.get(`workbench/log/${d}.md`))) ?? ''
    parts.push(h('article', { class: 'log' }, h('div', { class: 'md', html: markdownToHtml(text, macros) }),
      h('a', { class: 'small', href: `#/r/${r.key}/log/${encodeURIComponent(d)}` }, '이 날에 질문·코멘트')))
  }
  show(seg, parts.length ? h('div', {}, parts) : h('div', { class: 'empty' }, '일지가 없어요'))
}

async function logPage(r: Repo, d: string) {
  await repoTop(r, null, `#/r/${r.key}/logs`, '일지 › ', h('b', {}, d))
  const macros = await macrosFor(r)
  const text = (await readText(r.key, r.files.get(`workbench/log/${d}.md`))) ?? ''
  show(h('article', { class: 'md', html: markdownToHtml(text, macros) }), await commentsPanel(r, logTarget(d), macros))
}

async function pdfsPage(r: Repo) {
  const seg = await repoTop(r, 'pdfs')
  const pdfs = [...r.files.values()].filter((f) => /\.pdf$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))
  const groups = new Map<string, TreeEntry[]>()
  for (const f of pdfs) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '맨 위'
    groups.set(dir, [...(groups.get(dir) ?? []), f])
  }
  const rows: HTMLElement[] = []
  for (const [dir, fs] of groups) {
    rows.push(h('div', { class: 'row-group' }, dir))
    for (const f of fs) {
      const kept = !!(await readBytes(r.key, f))
      rows.push(h('a', { class: 'row', href: `#/r/${r.key}/pdf/${encodeURIComponent(f.path)}` }, h('span'),
        h('div', {}, h('div', { class: 't' }, f.path.split('/').pop()), kept ? null : h('div', { class: 'd' }, f.size > MAX_PDF_BYTES ? '너무 커서 이 기기에 보관하지 않아요' : '아직 받지 않았어요')),
        h('span', { class: 'm' }, fmtSize(f.size))))
    }
  }
  show(seg, rows.length ? h('div', { class: 'rows' }, rows) : h('div', { class: 'empty' }, 'GitHub에 올라간 PDF가 없어요. 맥에서 결과 PDF를 커밋해 올리면 여기에 보여요.'))
}

async function pdfPage(r: Repo, path: string) {
  const f = r.files.get(path)
  const name = path.split('/').pop()!
  await repoTop(r, null, `#/r/${r.key}/pdfs`, 'PDF › ', h('b', {}, name))
  const data = f && (await readBytes(r.key, f))
  const macros = await macrosFor(r)
  const target = paperTarget(name)
  let page = 1
  let sel: PdfSelection | null = null
  const pageLabel = h('span', {}, '')
  let zoom = 1
  const zoomCtl = h('span', { class: 'seg inline', role: 'group', 'aria-label': '확대' })
  const selBtn = h('button', { class: 'btn primary floating', hidden: true, onmousedown: (e: Event) => e.preventDefault(), onclick: () => {
    const s = sel
    compose(r, target, { page: s?.page ?? page, quote: s?.text }, () => void refreshComments())
  } }, '고른 글로 질문하기')
  const host = h('div', { class: 'pdf' })
  const side = h('div', { class: 'pdf-side' })
  const refreshComments = async () => side.replaceChildren(await commentsPanel(r, target, macros, () => ({ page, quote: sel?.text })))
  main.className = 'wide'
  main.replaceChildren(
    h('div', { class: 'pdf-tools' }, pageLabel, zoomCtl, h('span', { class: 'sp' }),
      h('button', { class: 'btn', onclick: () => compose(r, target, { page }, () => void refreshComments()) }, '이 쪽에 질문'),
      h('button', { class: 'btn quiet wide-only', onclick: () => side.scrollIntoView({ behavior: 'smooth' }) }, '코멘트 보기')),
    data ? h('div', { class: 'pdf-area' }, host) : h('div', { class: 'pdf-missing empty' }, '이 PDF는 아직 이 기기에 없어요. 인터넷이 될 때 동기화해 주세요.'),
    side, selBtn)
  await refreshComments()
  if (!data) return
  let view: Awaited<ReturnType<typeof mountPdf>> | null = null
  const mount = async () => {
    view?.destroy()
    host.replaceChildren()
    const keep = page
    view = await mountPdf(host, data, {
      zoom,
      onSelect: (s) => { sel = s; selBtn.hidden = !s },
      onPage: (p) => { page = p; pageLabel.textContent = `${p} / ${view?.pages ?? ''}쪽` },
    })
    host.querySelector<HTMLElement>(`.pdf-page[data-page="${keep}"]`)?.scrollIntoView({ block: 'start' })
  }
  const drawZoom = () => zoomCtl.replaceChildren(...[1, 1.5, 2].map((z) => h('button', { class: z === zoom ? 'on' : '', onclick: () => { zoom = z; drawZoom(); void mount() } }, `${z}×`)))
  drawZoom()
  await mount()
  cleanup = () => view?.destroy()
}

/** Comment threads of one research, or of every research when r is null */
async function commentsPage(r: Repo | null) {
  const seg = r ? await repoTop(r, 'comments') : null
  if (!r) setTop(null, h('b', {}, '코멘트'))
  const sections: HTMLElement[] = []
  let open = 0
  for (const rr of r ? [r] : await allRepos()) {
    const macros = await macrosFor(rr)
    const title = await researchTitle(rr)
    for (const [t, ttl] of [...(await targetsOf(rr))].sort((a, b) => a[1].localeCompare(b[1]))) {
      const list = await commentsFor(rr, t)
      if (!list.length) continue
      const waiting = list.filter(waitingForAnswer).length
      open += waiting
      const href = await targetHref(rr, t)
      sections.push(h('section', { class: 'thread' },
        h('div', { class: 'sec-head' }, h('h2', {}, href ? h('a', { href, style: 'color:inherit' }, shortTitle(ttl)) : shortTitle(ttl)),
          h('span', { class: 'sp' }), waiting ? h('span', { class: 'st wait' }, `답 기다림 ${waiting}`) : null),
        r ? null : h('div', { class: 'h-sub', style: 'margin:-4px 0 0' }, title),
        list.map((c) => commentView(c, macros, () => void route()))))
    }
  }
  if (!r) { openQuestions = open; void drawTabs() }
  show(seg, r ? null : h('div', {}, h('h1', { class: 'h-title' }, '코멘트'), h('p', { class: 'h-sub' }, '모든 연구에 남긴 질문과 코멘트, 그리고 Claude의 답이에요.')),
    sections.length ? h('div', { style: 'display:flex;flex-direction:column;gap:var(--sp-6)' }, sections) : h('div', { class: 'empty' }, '코멘트가 없어요'))
}

async function settingsPage() {
  setTop(null, h('b', {}, '설정'))
  const token = h('input', { id: 'token', type: 'password', value: settings.token, placeholder: 'github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const repos = h('textarea', { id: 'repos', rows: 4, autocapitalize: 'off', spellcheck: 'false' })
  repos.value = settings.repos.map(repoKey).join('\n')
  const status = h('div', { class: 'help', role: 'status' })
  const use = await db.usage()
  show(
    h('h1', { class: 'h-title' }, '설정'),
    h('section', { class: 'form' },
      h('label', { for: 'token' }, 'GitHub 토큰'), token,
      h('div', { class: 'help' },
        h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'fine-grained 토큰 만들기'),
        ' · Repository access: Only select repositories에서 아래 저장소를 고르고, Permissions › Repository permissions › Contents를 Read and write로. 토큰은 이 기기 안에만 저장돼요. 잃어버리면 GitHub에서 토큰을 지우면 돼요.'),
      h('label', { for: 'repos' }, '저장소 (한 줄에 하나, owner/name)'), repos,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => {
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
        h('button', { class: 'btn', onclick: async () => {
          if (!confirm('토큰을 이 기기에서 지울까요? 받아 둔 내용과 올릴 코멘트는 남아요.')) return
          settings = { ...settings, token: '' }
          await saveSettings(settings)
          void settingsPage(); void drawBar()
        } }, '토큰 지우기')),
      status),
    h('section', {},
      h('div', { class: 'sec-head' }, h('h2', {}, '이 기기에 보관한 것'), h('span', { class: 'count' }, use ? fmtSize(use.used) : '')),
      h('p', { class: 'help' }, 'iPad는 Safari 공유 › 홈 화면에 추가, 갤럭시는 Chrome 메뉴(⋮) › 홈 화면에 추가(또는 앱 설치)로 설치하면 인터넷 없이도 열려요. 블록·일지·코멘트와 40 MB 이하 PDF를 받아 두고, 코멘트는 workbench/comments/inbox/에 새 파일로만 올려요. 원고와 다른 파일은 바꾸지 않아요.')))
}

// ---------- router ----------

async function route() {
  cleanup?.(); cleanup = null
  stopAnswerWatch()
  window.scrollTo(0, 0)
  void drawTabs()
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  try {
    if (parts[0] === 'settings') return await settingsPage()
    if (parts[0] === 'comments') return await commentsPage(null)
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
    show(h('p', { class: 'error' }, `열지 못했어요: ${escapeHtml((e as Error).message)}`))
  }
}

window.addEventListener('hashchange', () => void route())
window.addEventListener('online', () => { void drawBar(); void sendQueued() })
window.addEventListener('offline', () => void drawBar())

void (async () => {
  settings = await loadSettings()
  await drawBar()
  await route()
  void countOpenQuestions()
  if (settings.token && navigator.onLine) void runSync()
})()
