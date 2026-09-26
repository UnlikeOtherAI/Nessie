import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

type PdfState = { document: PDFDocumentProxy | null; error: boolean; loading: boolean }

/** Draws uploaded PDFs as pixels, without depending on the host WebView's PDF plugin. */
export const PdfPreview = ({ title, url }: { title: string; url: string }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<PdfState>({ document: null, error: false, loading: true })
  const [pageNumber, setPageNumber] = useState(1)
  const [width, setWidth] = useState(0)
  const [renderError, setRenderError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let document: PDFDocumentProxy | null = null
    let loadingTask: ReturnType<typeof import('pdfjs-dist').getDocument> | null = null
    setState({ document: null, error: false, loading: true })
    setPageNumber(1)
    void (async () => {
      try {
        // The authenticated bytes already live at this object URL. Passing
        // data to PDF.js avoids another request from its worker and never runs
        // scripts or follows links embedded in an uploaded document.
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
        if (cancelled) return
        const pdfjs = await import('pdfjs-dist')
        const { default: pdfWorkerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        if (cancelled) return
        // The worker was once served as octet-stream with an immutable one-year
        // cache lifetime. Its content hash did not change when nginx's MIME type
        // was fixed, so existing browsers can still reuse the bad response.
        const workerUrl = new URL(pdfWorkerUrl, window.location.href)
        workerUrl.searchParams.set('nessie-worker-mime', '2')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href
        loadingTask = pdfjs.getDocument({ data: bytes })
        document = await loadingTask.promise
        if (!cancelled) setState({ document, error: false, loading: false })
      } catch {
        if (!cancelled) setState({ document: null, error: true, loading: false })
      }
    })()
    return () => {
      cancelled = true
      void loadingTask?.destroy()
      if (document && !loadingTask) void document.destroy()
    }
  }, [url])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const pdf = state.document
    const canvas = canvasRef.current
    if (!pdf || !canvas || width <= 0) return
    let cancelled = false
    let task: RenderTask | null = null
    setRenderError(false)
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(2, width / base.width)
        const viewport = page.getViewport({ scale })
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.ceil(viewport.width * pixelRatio)
        canvas.height = Math.ceil(viewport.height * pixelRatio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas unavailable')
        task = page.render({
          canvas,
          canvasContext: context,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          viewport,
        })
        await task.promise
      } catch {
        if (!cancelled) setRenderError(true)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pageNumber, state.document, width])

  return (
    <div className="flex h-full min-h-0 w-full flex-col" ref={containerRef}>
      {state.error || renderError ? (
        <p className="p-8 text-center text-sm text-[color:var(--tx3)]">
          This PDF couldn’t be previewed. Download it to open it in another app.
        </p>
      ) : state.loading ? (
        <p className="p-8 text-center text-sm text-[color:var(--tx3)]">Loading PDF…</p>
      ) : null}
      {state.document && !renderError ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <canvas aria-label={`${title}, page ${pageNumber}`} className="mx-auto" ref={canvasRef} role="img" />
          </div>
          {state.document.numPages > 1 ? (
            <div className="flex items-center justify-center gap-3 border-t border-[color:var(--sep)] p-2 text-sm">
              <button className="admin-button admin-button-secondary admin-button-compact" disabled={pageNumber === 1} onClick={() => setPageNumber((page) => page - 1)} type="button">Previous</button>
              <span>Page {pageNumber} of {state.document.numPages}</span>
              <button className="admin-button admin-button-secondary admin-button-compact" disabled={pageNumber === state.document.numPages} onClick={() => setPageNumber((page) => page + 1)} type="button">Next</button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
