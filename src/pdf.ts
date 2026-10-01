import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfSelection { page: number; text: string }

/**
 * Scrollable PDF view: pages render when they come near the screen and are dropped again when
 * far away (tablet and phone memory). Each page has a text layer so text can be selected and quoted.
 */
export async function mountPdf(host: HTMLElement, data: ArrayBuffer, opts: { zoom?: number; onSelect(sel: PdfSelection | null): void; onPage(page: number): void }): Promise<{ destroy(): void; pages: number }> {
  // pdf.js takes ownership of the buffer it is given; pass a copy so the stored one stays usable
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise
  // fit the page to the screen width, times the chosen zoom (the view then scrolls sideways)
  const width = () => Math.min(host.clientWidth - 16, 1400) * (opts.zoom ?? 1)
  const first = await doc.getPage(1)
  const base = first.getViewport({ scale: 1 })
  const pages: { el: HTMLDivElement; rendered: boolean; task?: { cancel(): void } }[] = []

  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement('div')
    el.className = 'pdf-page'
    el.dataset.page = String(n)
    const scale = width() / base.width
    el.style.width = `${base.width * scale}px`
    el.style.height = `${base.height * scale}px`
    host.append(el)
    pages.push({ el, rendered: false })
  }

  const render = async (i: number) => {
    const p = pages[i]!
    if (p.rendered) return
    p.rendered = true
    const page = await doc.getPage(i + 1)
    const vp1 = page.getViewport({ scale: 1 })
    const scale = width() / vp1.width
    const vp = page.getViewport({ scale })
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${vp.width}px`
    canvas.style.height = `${vp.height}px`
    p.el.style.width = `${vp.width}px`
    p.el.style.height = `${vp.height}px`
    p.el.style.setProperty('--scale-factor', String(scale))
    const text = document.createElement('div')
    text.className = 'textLayer'
    p.el.replaceChildren(canvas, text)
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
    p.task = task
    try {
      await task.promise
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render()
    } catch { /* cancelled while scrolling away */ }
  }
  const release = (i: number) => {
    const p = pages[i]!
    if (!p.rendered) return
    p.task?.cancel()
    p.rendered = false
    p.el.replaceChildren()
  }

  const visible = new Set<number>()
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number((e.target as HTMLElement).dataset.page) - 1
      if (e.isIntersecting) { visible.add(i); void render(i) } else visible.delete(i)
    }
    if (visible.size) {
      const lo = Math.min(...visible), hi = Math.max(...visible)
      opts.onPage(lo + 1)
      pages.forEach((_p, i) => { if (i < lo - 3 || i > hi + 3) release(i) })
    }
  }, { root: null, rootMargin: '600px 0px' })
  pages.forEach((p) => io.observe(p.el))

  const onSel = () => {
    const sel = document.getSelection()
    const text = sel?.toString().replace(/\s+/g, ' ').trim() ?? ''
    const node = sel?.anchorNode
    const pageEl = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.pdf-page')
    opts.onSelect(text && pageEl && host.contains(pageEl) ? { page: Number(pageEl.dataset.page), text } : null)
  }
  document.addEventListener('selectionchange', onSel)

  return {
    pages: doc.numPages,
    destroy() {
      io.disconnect()
      document.removeEventListener('selectionchange', onSel)
      pages.forEach((_p, i) => release(i))
      void doc.destroy()
    },
  }
}
