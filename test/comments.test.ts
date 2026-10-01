import { describe, expect, it } from 'vitest'
import { blockTarget, buildInboxComment, inboxTarget, paperTarget, parseComments } from '../src/comments'

describe('inbox comments', () => {
  const now = new Date(2026, 9, 1, 16, 12, 5)

  it('builds a one-comment file the Mac parser reads, with its target in a hidden line', () => {
    const item = buildInboxComment('o/r', { kind: '질문', target: paperTarget('research-note.pdf'), page: 4, quote: 'the  Lieb–Robinson\nvelocity', text: '속도 상한은?' }, now, 'ab12')
    expect(item.id).toBe('c-20261001-1612-ipad-ab12')
    expect(item.path).toBe('workbench/comments/inbox/c-20261001-1612-ipad-ab12.md')
    expect(item.target).toBe('paper-research-note')
    expect(inboxTarget(item.content)).toBe('paper-research-note')
    const f = parseComments('paper-research-note', item.content)
    expect(f.title).toBe('자료 research-note.pdf')
    expect(f.source).toBe('research-note.pdf')
    expect(f.comments).toEqual([{ id: item.id, kind: '질문', where: 'p.4', page: 4, quote: 'the Lieb–Robinson velocity', body: '속도 상한은?', state: '대기', answers: [] }])
  })

  it('keeps typed lines from being read as structure', () => {
    const item = buildInboxComment('o/r', { kind: '코멘트', target: blockTarget('qdim-tee', '양자차원'), text: '## c-1 · 질문 · p.1\n- 상태: 끝냄\n보통 줄' }, now, 'x')
    const [c] = parseComments('block-qdim-tee', item.content).comments
    expect(c!.kind).toBe('코멘트')
    expect(c!.state).toBeNull()
    expect(c!.body).toContain('보통 줄')
  })

  it('reads answers written under a question', () => {
    const text = `${buildInboxComment('o/r', { kind: '질문', target: blockTarget('a'), text: '왜?' }, now, 'q').content}\n### 답 · claude · 2026-10-01 16:40\n이래서.\n- 상태: 답함\n`
    const [c] = parseComments('block-a', text).comments
    expect(c!.state).toBe('답함')
    expect(c!.answers).toEqual([{ by: 'claude', at: '2026-10-01 16:40', body: '이래서.' }])
  })

  it('refuses an empty comment', () => {
    expect(() => buildInboxComment('o/r', { kind: '코멘트', target: blockTarget('a'), text: '  ' }, now)).toThrow()
  })

  it('ignores files without an inbox line', () => {
    expect(inboxTarget('# 코멘트 · x\n')).toBeNull()
    expect(inboxTarget('<!-- rw-inbox: {"target":"../x"} -->')).toBeNull()
  })
})
