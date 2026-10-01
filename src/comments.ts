/**
 * Comments, in the same Markdown format as the Mac app (research-workspace apps/server/src/comments.ts):
 * one file per target, workbench/comments/<target>.md, sections headed "## <id> · <코멘트|질문> · <where>".
 *
 * The iPad never edits those files. Each comment it writes becomes a new file
 * workbench/comments/inbox/<id>.md that holds a complete one-comment file for its target
 * plus a hidden "rw-inbox" line naming the target. A new file cannot collide with edits made
 * on the Mac or by an agent, so nothing anyone wrote is ever overwritten. The Mac app (or an
 * agent) later appends the section to workbench/comments/<target>.md and removes the inbox file.
 */

export const COMMENTS_DIR = 'workbench/comments'
export const INBOX_DIR = `${COMMENTS_DIR}/inbox`

export type CommentKind = '코멘트' | '질문'
export type CommentState = '대기' | '답함' | '끝냄'
export interface CommentAnswer { by: string; at: string; body: string }
export interface CommentEntry {
  id: string
  kind: CommentKind
  where: string
  page?: number
  quote?: string
  body: string
  state: CommentState | null
  answers: CommentAnswer[]
}
export interface CommentFile { target: string; title: string; source?: string; comments: CommentEntry[] }

export interface CommentTarget { target: string; title: string; source?: string }
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 160) || '_'
export const paperTarget = (name: string): CommentTarget => ({ target: `paper-${slug(name.replace(/\.pdf$/i, ''))}`, title: `자료 ${name}`, source: name })
export const blockTarget = (bid: string, title?: string): CommentTarget => ({ target: `block-${slug(bid)}`, title: `작업노트 결과 ${title ?? bid}`, source: bid })
export const logTarget = (date: string): CommentTarget => ({ target: `log-${slug(date)}`, title: `일지 ${date}` })

const HEAD_RE = /^## (c-[\w-]+) · (\S+) · (.*)$/
const ANSWER_RE = /^### 답 · (.+?) · (.+)$/
const STATE_RE = /^- 상태: (\S+)\s*$/
const META_RE = /^<!-- rw: (\{.*\}) -->$/
const SOURCE_RE = /^<!-- rw-source: (.+) -->$/
const INBOX_RE = /^<!-- rw-inbox: (\{.*\}) -->$/

export function parseComments(target: string, text: string): CommentFile {
  let title = target
  let source: string | undefined
  const comments: CommentEntry[] = []
  let cur: CommentEntry | null = null
  let ans: CommentAnswer | null = null
  let buf: string[] = []
  const flush = () => {
    const body = buf.join('\n').trim()
    if (ans) ans.body = body
    else if (cur) cur.body = body
    buf = []
  }
  for (const line of text.split(/\r?\n/)) {
    const head = HEAD_RE.exec(line)
    if (head) {
      flush()
      ans = null
      const kind: CommentKind = head[2] === '질문' ? '질문' : '코멘트'
      const where = head[3]!.trim()
      const page = /^p\.(\d+)/.exec(where)
      cur = { id: head[1]!, kind, where, page: page ? Number(page[1]) : undefined, body: '', state: kind === '질문' ? '대기' : null, answers: [] }
      comments.push(cur)
      continue
    }
    if (!cur) {
      const h1 = /^# (.+)$/.exec(line)
      if (h1) title = h1[1]!.replace(/^코멘트 · /, '').trim()
      const src = SOURCE_RE.exec(line)
      if (src) source = src[1]!.trim()
      continue
    }
    const a = ANSWER_RE.exec(line)
    if (a) {
      flush()
      ans = { by: a[1]!.trim(), at: a[2]!.trim(), body: '' }
      cur.answers.push(ans)
      continue
    }
    const st = STATE_RE.exec(line)
    if (st) {
      if (['대기', '답함', '끝냄'].includes(st[1]!)) cur.state = st[1] as CommentState
      continue
    }
    if (!ans && buf.every((l) => !l.trim())) {
      if (META_RE.test(line)) continue
      if (line.startsWith('> ')) {
        const q = line.slice(2).trim().replace(/^"(.*)"$/, '$1')
        cur.quote = cur.quote ? `${cur.quote} ${q}` : q
        continue
      }
    }
    buf.push(line)
  }
  flush()
  return { target, title, source, comments }
}

/** The target an inbox file belongs to, or null if the file is not an inbox file */
export function inboxTarget(text: string): string | null {
  for (const line of text.split(/\r?\n/, 12)) {
    const m = INBOX_RE.exec(line)
    if (m) {
      try {
        const t = (JSON.parse(m[1]!) as { target?: unknown }).target
        return typeof t === 'string' && /^[a-z]+(?:-[A-Za-z0-9._-]{1,160})?$/.test(t) ? t : null
      } catch { return null }
    }
  }
  return null
}

export interface NewComment {
  kind: CommentKind
  target: CommentTarget
  page?: number
  quote?: string
  text: string
}

export interface OutboxItem {
  /** "<owner>/<repo>" */
  repo: string
  id: string
  path: string
  target: string
  content: string
  createdAt: string
  /** last failed attempt, shown to the user */
  error?: string
  /** when it reached GitHub; the item stays (shown as sent) until a sync brings the file back */
  sentAt?: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Keep lines the user typed from being read as a comment head, answer head or state line */
const guardBody = (s: string) => s.replace(/\r\n?/g, '\n').trim().split('\n')
  .map((l) => (/^#{1,6} /.test(l) || STATE_RE.test(l) || META_RE.test(l) || SOURCE_RE.test(l) || INBOX_RE.test(l) ? `\\${l}` : l)).join('\n')

export function localStamp(d: Date): { date: string; time: string; iso: string } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const off = -d.getTimezoneOffset()
  const iso = `${date}T${time}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  return { date, time, iso }
}

/** Build the inbox file for one comment. `rand` makes ids from two devices in the same minute distinct. */
export function buildInboxComment(repo: string, input: NewComment, now = new Date(), rand = Math.random().toString(36).slice(2, 6)): OutboxItem {
  const text = input.text.trim()
  const quote = input.quote ? oneLine(input.quote).slice(0, 600) : ''
  if (!text && !quote) throw new Error('내용이 필요함')
  if (text.length > 20_000) throw new Error('내용이 너무 김')
  const page = Number.isInteger(input.page) && input.page! > 0 ? input.page : undefined
  const { date, time, iso } = localStamp(now)
  const id = `c-${date.replace(/-/g, '')}-${time.replace(':', '')}-ipad-${rand.replace(/[^a-z0-9]/g, '')}`
  const t = input.target
  const out = [`# 코멘트 · ${oneLine(t.title || t.target)}`]
  if (t.source) out.push(`<!-- rw-source: ${oneLine(t.source)} -->`)
  out.push(`<!-- rw-inbox: ${JSON.stringify({ target: t.target, from: 'ipad', at: iso })} -->`)
  out.push('', `> iPad에서 남긴 코멘트. 맥 앱이나 에이전트가 아래 절을 \`${COMMENTS_DIR}/${t.target}.md\` 끝에 옮겨 붙인 뒤 이 파일을 지운다.`)
  out.push('', `## ${id} · ${input.kind} · ${page ? `p.${page}` : '전체'}`)
  if (quote) out.push(`> "${quote}"`)
  if (input.kind === '질문') out.push('- 상태: 대기')
  if (text) out.push('', guardBody(text))
  out.push('')
  return { repo, id, path: `${INBOX_DIR}/${id}.md`, target: t.target, content: out.join('\n'), createdAt: iso }
}
