import { describe, expect, it } from 'vitest'
import { blockMeta, collectMacros, markdownToHtml, stripComments, texToHtml } from '../src/tex'

describe('tex reader', () => {
  it('reads the block header', () => {
    expect(blockMeta('% ---\n% id: qdim\n% title: 양자차원 · TEE\n% parent: sup\n% ---\n\\section{x}')).toMatchObject({ id: 'qdim', title: '양자차원 · TEE', parent: 'sup' })
  })

  it('strips comments but not escaped percent signs', () => {
    expect(stripComments('a 50\\% b % note\n% whole')).toBe('a 50\\% b \n')
  })

  it('renders sections, lists, theorems and math', () => {
    const html = texToHtml('\\section{Intro}\nText with $x^2$ and \\textbf{bold}.\n\n\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}\n\n\\begin{theorem}[A]\nIt holds.\n\\end{theorem}\n\\begin{align}\na &= b \\label{e1}\\\\\nc &= d\n\\end{align}\nSee \\eqref{e1} and \\cite{k1, k2}.')
    expect(html).toContain('<h2>Intro</h2>')
    expect(html).toContain('<b>bold</b>')
    expect(html).toMatch(/<ul><li>one\s*<\/li><li>two\s*<\/li><\/ul>/)
    expect(html).toContain('<span class="env-name">정리 (A).</span>')
    expect(html).toContain('class="katex-display"')
    expect(html).toContain('[k1, k2]')
    expect(html).not.toContain('\\label')
  })

  it('escapes html in text', () => {
    expect(texToHtml('a <script>x</script>')).toContain('&lt;script&gt;')
  })

  it('collects macros from preambles', () => {
    const m = collectMacros(['\\providecommand{\\ket}[1]{\\lvert #1\\rangle}\n\\newcommand{\\Tr}{\\operatorname{Tr}}\n\\DeclareMathOperator{\\rank}{rank}\n\\newcommand{\\x@y}{z}'])
    expect(m).toEqual({ '\\ket': '\\lvert #1\\rangle', '\\Tr': '\\operatorname{Tr}', '\\rank': '\\operatorname{rank}' })
    expect(texToHtml('$\\ket{0}$', m)).not.toContain('katex-error')
  })

  it('renders markdown with math and keeps code dollars', () => {
    const html = markdownToHtml('# 일지\n- $\\Delta^2$ 값\n- `a$b$c`\n\n$$x=1$$')
    expect(html).toContain('<h1>일지</h1>')
    expect(html).toContain('class="katex"')
    expect(html).toContain('<code>a$b$c</code>')
    expect(html).toContain('katex-display')
  })
})

describe('block notes', () => {
  it('lists whole-line comments after the header', async () => {
    const { blockNotes } = await import('../src/tex')
    expect(blockNotes('% ---\n% id: a\n% ---\n\\section{x}\n\n% 근거: docs/a.tex\ntext % inline\n% ---')).toEqual(['근거: docs/a.tex'])
  })
  it('renders ensuremath', () => {
    expect(texToHtml('\\section{V (\\ensuremath{J_\\Gamma})}')).toContain('class="katex"')
  })
})
