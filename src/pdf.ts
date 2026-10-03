import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfSelection { page: number; text: string }
export interface PdfView { pages: number; destroy(): void }

/** Left and right edge of the printed text on a page, as fractions of the page width */
async function textEdges(page: pdfjs.PDFPageProxy): Promise<[number, number]> {
  const vp = page.getViewport({ scale: 160 / page.getViewport({ scale: 1 }).width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let lo = width, hi = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3]! > 0 && data[i]! + data[i + 1]! + data[i + 2]! < 600) { if (x < lo) lo = x; if (x > hi) hi = x }
    }
  return hi < lo ? [0, 1] : [lo / width, (hi + 1) / width]
}

/**
 * Scrollable PDF view: pages render when they come near the screen and are dropped again when
 * far away (tablet and phone memory). Each page has a text layer so text can be selected and quoted.
 * At zoom 1 the white side margins are cut off so the printed text fills the screen width.
 */
export async function mountPdf(host: HTMLElement, data: ArrayBuffer, opts: { zoom?: number; onSelect(sel: PdfSelection | null): void; onPage(page: number): void }): Promise<PdfView> {
  // pdf.js takes ownership of the buffer it is given; pass a copy so the stored one stays usable
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise
  const first = await doc.getPage(1)
  const base = first.getViewport({ scale: 1 })

  // the text column: union over the first few pages, with a little air on each side
  let [x0, x1] = [1, 0]
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const [a, b] = await textEdges(n === 1 ? first : await doc.getPage(n))
    if (b - a < 0.98) { x0 = Math.min(x0, a); x1 = Math.max(x1, b) }
  }
  if (x1 <= x0 || x1 - x0 < 0.3) [x0, x1] = [0, 1]
  const pad = 0.02
  x0 = Math.max(0, x0 - pad); x1 = Math.min(1, x1 + pad)

  // the shown part of every page is `shown` px wide: the text column at the host width, times the zoom
  const shown = Math.min(host.clientWidth - 16, 1400) * (opts.zoom ?? 1)
  const scaleFor = (w: number) => shown / ((x1 - x0) * w)
  const pages: { el: HTMLDivElement; rendered: boolean; task?: { cancel(): void } }[] = []

  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement('div')
    el.className = 'pdf-page'
    el.dataset.page = String(n)
    const scale = scaleFor(base.width)
    el.style.width = `${shown}px`
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
    const scale = scaleFor(vp1.width)
    const vp = page.getViewport({ scale })
    // very large zooms would make huge canvases; keep the pixel count within what phones allow
    const dpr = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(16e6 / (vp.width * vp.height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${vp.width}px`
    canvas.style.height = `${vp.height}px`
    p.el.style.height = `${vp.height}px`
    const inner = document.createElement('div')
    inner.className = 'pdf-inner'
    inner.style.width = `${vp.width}px`
    inner.style.height = `${vp.height}px`
    inner.style.left = `${-x0 * vp.width}px`
    inner.style.setProperty('--scale-factor', String(scale))
    const text = document.createElement('div')
    text.className = 'textLayer'
    inner.append(canvas, text)
    p.el.replaceChildren(inner)
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
      pages.forEach((_p, i) => { if (i < lo - 3 || i > hi + 3) release(i) })
    }
  }, { root: null, rootMargin: '600px 0px' })
  pages.forEach((p) => io.observe(p.el))

  // the current page is the one crossing a line a third down the screen
  const onScroll = () => {
    const line = window.innerHeight / 3
    const hit = pages.find((p) => { const b = p.el.getBoundingClientRect(); return b.top <= line && b.bottom > line })
    if (hit) opts.onPage(Number(hit.el.dataset.page))
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  requestAnimationFrame(onScroll)

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
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('selectionchange', onSel)
      pages.forEach((_p, i) => release(i))
      void doc.destroy()
    },
  }
}
