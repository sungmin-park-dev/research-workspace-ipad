import katex from 'katex'
import { marked } from 'marked'

/**
 * A light LaTeX-to-HTML reader for block sources: sections, lists, theorem-like environments,
 * text formatting and math (KaTeX). It is for reading on a tablet or phone, not a TeX engine: anything it
 * does not know is shown as plain text, and nothing here ever writes back.
 */

export type Macros = Record<string, string>

export interface BlockMeta { id?: string; title?: string; status?: string; parent?: string; created?: string; next?: string; [k: string]: string | undefined }

/** Read the "% ---" header of a block file */
export function blockMeta(src: string): BlockMeta {
  const meta: BlockMeta = {}
  const lines = src.split(/\r?\n/)
  if (lines[0]?.trim() !== '% ---') return meta
  for (const line of lines.slice(1)) {
    if (line.trim() === '% ---') break
    const m = /^%\s*([\w-]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1]!] = m[2]!.trim()
  }
  return meta
}

/** Whole-line comments after the header: in work blocks these carry pointers and notes worth reading */
export function blockNotes(src: string): string[] {
  const lines = src.split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === '% ---') { i = lines.findIndex((l, j) => j > 0 && l.trim() === '% ---') + 1 }
  return lines.slice(Math.max(i, 0)).filter((l) => /^\s*%\s*\S/.test(l) && !/^\s*%\s*-{3,}\s*$/.test(l)).map((l) => l.replace(/^\s*%+\s?/, ''))
}

/** \newcommand / \renewcommand / \providecommand / \DeclareMathOperator from preamble files, as KaTeX macros */
export function collectMacros(sources: string[]): Macros {
  const macros: Macros = {}
  for (const src of sources) {
    const text = stripComments(src)
    const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?(?:\[[^\]]*\])?\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const body = balanced(text, re.lastIndex - 1)
      if (!body) continue
      re.lastIndex = body.end
      const name = `\\${m[3]}`
      if (m[3]!.includes('@')) continue
      if (m[1] === 'providecommand' && name in macros) continue
      macros[name] = m[1] === 'DeclareMathOperator' ? `\\operatorname${m[2] ? '*' : ''}{${body.inner}}` : body.inner
    }
  }
  return macros
}

/** The contents of the brace group opening at `open` (text[open] === '{') */
function balanced(text: string, open: number): { inner: string; end: number } | null {
  if (text[open] !== '{') return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 }
  }
  return null
}

export function stripComments(src: string): string {
  return src.split(/\r?\n/).map((l) => {
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '\\') { i++; continue }
      if (l[i] === '%') return l.slice(0, i)
    }
    return l
  }).join('\n')
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderMath(tex: string, display: boolean, macros: Macros): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, macros: { ...macros }, trust: false, strict: 'ignore' })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

const DISPLAY_ENVS = 'equation|align|gather|multline|eqnarray|flalign|alignat'
const THEOREM_NAMES: Record<string, string> = {
  theorem: '정리', lemma: '보조정리', proposition: '명제', corollary: '따름정리', definition: '정의', conjecture: '추측',
  remark: '참고', example: '예', claim: '주장', assumption: '가정', axiom: '공리', proof: '증명', question: '질문',
}

/** Replace \cmd{arg} (balanced) using fn(arg) */
function replaceCmd(text: string, cmd: string, fn: (arg: string) => string): string {
  const re = new RegExp(`\\\\${cmd}\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, 'g')
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const b = balanced(text, re.lastIndex - 1)
    if (!b) break
    out += text.slice(last, m.index) + fn(b.inner)
    last = re.lastIndex = b.end
  }
  return out + text.slice(last)
}

export function texToHtml(src: string, macros: Macros = {}): string {
  const slots: string[] = []
  const hold = (html: string) => `@@S${slots.push(html) - 1}@@`
  let t = stripComments(src)

  // display math
  t = t.replace(new RegExp(`\\\\begin\\{(${DISPLAY_ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\1\\2\\}`, 'g'), (_m, env: string, _star: string, body: string) => {
    let b = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '')
    if (/^(align|flalign|alignat|eqnarray)$/.test(env)) b = `\\begin{aligned}${b.replace(/^\{\d+\}/, '')}\\end{aligned}`
    else if (env === 'gather') b = `\\begin{gathered}${b}\\end{gathered}`
    else if (env === 'multline') b = `\\begin{gathered}${b}\\end{gathered}`
    return hold(`<div class="math">${renderMath(b.trim(), true, macros)}</div>`)
  })
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_m, b: string) => hold(`<div class="math">${renderMath(b.replace(/\\label\{[^}]*\}/g, '').trim(), true, macros)}</div>`))
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_m, b: string) => hold(`<div class="math">${renderMath(b.trim(), true, macros)}</div>`))
  // inline math
  t = replaceCmd(t, 'ensuremath', (b) => hold(renderMath(b, false, macros)))
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_m, b: string) => hold(renderMath(b, false, macros)))
  t = t.replace(/(^|[^\\])\$((?:\\.|[^$\\])+?)\$/g, (_m, pre: string, b: string) => pre + hold(renderMath(b, false, macros)))

  t = escapeHtml(t)

  // structure
  const heading = (tag: string) => (arg: string) => `\n\n${hold(`<${tag}>`)}${arg}${hold(`</${tag}>`)}\n\n`
  t = replaceCmd(t, 'section', heading('h2'))
  t = replaceCmd(t, 'subsection', heading('h3'))
  t = replaceCmd(t, 'subsubsection', heading('h4'))
  t = replaceCmd(t, 'paragraph', (a) => `\n\n${hold('<b>')}${a}${hold('</b>')} `)
  t = t.replace(/\\begin\{(itemize|enumerate|description)\}(\[[^\]]*\])?/g, (_m, e: string) => `\n\n${hold(e === 'enumerate' ? '<ol>' : '<ul>')}`)
  t = t.replace(/\\end\{(itemize|enumerate|description)\}/g, (_m, e: string) => `${hold(e === 'enumerate' ? '</li></ol>' : '</li></ul>')}\n\n`)
  t = t.replace(/\\item(?:\[([^\]]*)\])?\s*/g, (_m, label?: string) => hold(`</li><li>${label ? `<b>${label}</b> ` : ''}`))
  t = t.replace(/\\begin\{([A-Za-z]+)\*?\}(?:\[([^\]]*)\])?/g, (_m, env: string, opt?: string) => {
    const name = THEOREM_NAMES[env.toLowerCase()]
    if (!name) return ''
    return `\n\n${hold(`<div class="env env-${env.toLowerCase()}"><span class="env-name">${name}${opt ? ` (${opt})` : ''}.</span> `)}`
  })
  t = t.replace(/\\end\{([A-Za-z]+)\*?\}/g, (_m, env: string) => (THEOREM_NAMES[env.toLowerCase()] ? `${hold('</div>')}\n\n` : ''))

  // inline formatting
  const wrap = (open: string, close: string) => (a: string) => `${hold(open)}${a}${hold(close)}`
  t = replaceCmd(t, 'textbf', wrap('<b>', '</b>'))
  for (const c of ['emph', 'textit']) t = replaceCmd(t, c, wrap('<i>', '</i>'))
  t = replaceCmd(t, 'texttt', wrap('<code>', '</code>'))
  t = replaceCmd(t, 'url', (a) => hold(`<a href="${a}" target="_blank" rel="noopener">${a}</a>`))
  t = t.replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, (_m, u: string, x: string) => hold(`<a href="${u}" target="_blank" rel="noopener">${x}</a>`))
  for (const c of ['cite', 'citep', 'citet']) t = replaceCmd(t, c, (a) => hold(`<span class="cite">[${a.split(',').map((s) => s.trim()).join(', ')}]</span>`))
  for (const c of ['ref', 'eqref', 'cref', 'Cref', 'autoref']) t = replaceCmd(t, c, (a) => hold(`<span class="ref">‹${a}›</span>`))
  t = replaceCmd(t, 'label', () => '')
  t = replaceCmd(t, 'footnote', (a) => `${hold('<span class="fn">(')}${a}${hold(')</span>')}`)
  t = t.replace(/\\\\(\[[^\]]*\])?/g, () => hold('<br>'))
  t = t.replace(/``/g, '“').replace(/''/g, '”').replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' ')
  t = t.replace(/\\(noindent|medskip|bigskip|smallskip|newpage|clearpage|centering|maketitle|par)\b/g, '')
  t = t.replace(/\\([%&$#_{}])/g, '$1')

  // paragraphs
  const html = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => (/^@@S\d+@@/.test(p) && /<(h\d|ul|ol|div|\/)/.test(slots[Number(/^@@S(\d+)@@/.exec(p)![1])] ?? '') ? p : `<p>${p}</p>`)).join('\n')
  // the first \item of a list closes nothing
  return html.replace(/@@S(\d+)@@/g, (_m, i: string) => slots[Number(i)] ?? '').replace(/(<[uo]l>)\s*<\/li>/g, '$1')
}

/** Markdown with $…$ and $$…$$ math (logs and notes) */
export function markdownToHtml(src: string, macros: Macros = {}): string {
  const slots: string[] = []
  const hold = (html: string) => `@@M${slots.push(html) - 1}@@`
  let t = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => hold(m)) // code spans keep their dollars
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_m, b: string) => hold(`<div class="math">${renderMath(b.trim(), true, macros)}</div>`))
  t = t.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_m, pre: string, b: string) => pre + hold(renderMath(b, false, macros)))
  // code spans go back before Markdown runs so marked formats them
  t = t.replace(/@@M(\d+)@@/g, (m, i: string) => (slots[Number(i)]!.startsWith('`') ? slots[Number(i)]! : m))
  const html = marked.parse(t, { async: false, gfm: true, breaks: false }) as string
  return sanitize(html.replace(/@@M(\d+)@@/g, (_m, i: string) => slots[Number(i)] ?? ''))
}

/** Markdown may carry raw HTML; keep only harmless markup */
function sanitize(html: string): string {
  return html.replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/javascript:/gi, '')
}
