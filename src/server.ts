#!/usr/bin/env bun
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { homedir } from 'node:os'

const SCRATCH_DIR = (process.env.SCRATCH_DIR ?? '~/Scratch').replace(/^~/, homedir())
const SCRATCH_TILDE = SCRATCH_DIR.startsWith(homedir())
  ? '~' + SCRATCH_DIR.slice(homedir().length)
  : SCRATCH_DIR
const PORT = 20021

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
}

function getMime(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(d: Date): string {
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface FileEntry { name: string; size: number; mtime: Date }

async function listFiles(): Promise<FileEntry[]> {
  const entries = await readdir(SCRATCH_DIR, { withFileTypes: true })
  const files = await Promise.all(
    entries.filter(e => e.isFile()).map(async e => {
      const s = await stat(join(SCRATCH_DIR, e.name))
      return { name: e.name, size: s.size, mtime: s.mtime }
    })
  )
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

const app = new Hono()

app.get('/', async (c) => {
  const files = await listFiles()
  const rows = files.map(f => {
    const mime = getMime(f.name)
    const encoded = encodeURIComponent(f.name)
    return `
    <tr>
      <td>
        <span class="copy-btn me-1" title="Copy path / drag"
          draggable="true"
          data-path="@${SCRATCH_TILDE}/${escHtml(f.name)}"
          onclick="copyPath(this)"
          ondragstart="dragPath(event,this)">@</span><a
          href="/file/${encoded}"
          draggable="true"
          ondragstart="dragFile(event,'${escHtml(mime)}','${encoded}')">${escHtml(f.name)}</a>
      </td>
      <td class="text-end text-secondary">${formatSize(f.size)}</td>
      <td class="text-secondary">${formatDate(f.mtime)}</td>
    </tr>`
  }).join('')

  return c.html(`<!doctype html>
<html data-bs-theme="dark" lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scratch</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
  <style>
    body { font-family: monospace; }
    td, th { font-size: .9rem; }
    a { text-decoration: none; }
    a:hover { text-decoration: underline; }
    .copy-btn {
      display: inline-block; cursor: pointer; font-size: .75rem;
      padding: 0 4px; border-radius: 3px; background: #2a2a2a;
      color: #aaa; border: 1px solid #444; user-select: none;
      min-width: 1.4rem; text-align: center;
    }
    .copy-btn:hover { background: #3a3a3a; color: #fff; }
    .copy-btn.copied { background: #155724; color: #75b798; border-color: #75b798; }
    #drop-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(13,110,253,.15); border: 3px dashed #0d6efd;
      z-index: 9999; pointer-events: none;
      align-items: center; justify-content: center;
      font-size: 1.5rem; color: #0d6efd;
    }
    #drop-overlay.active { display: flex; }
    .upload-filename { font-family: monospace; font-size: .85rem; }
  </style>
</head>
<body class="container py-4">
  <div id="drop-overlay">Drop files to upload</div>

  <!-- Upload modal -->
  <div class="modal fade" id="uploadModal" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header py-2">
          <h5 class="modal-title">Upload</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body p-0">
          <table class="table table-sm mb-0">
            <thead><tr><th class="ps-3">Filename</th><th class="text-end pe-3">Size</th></tr></thead>
            <tbody id="upload-list"></tbody>
          </table>
        </div>
        <div class="modal-footer py-2">
          <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="confirm-upload-btn" onclick="confirmUpload()">Upload</button>
        </div>
      </div>
    </div>
  </div>

  <div class="d-flex align-items-center gap-2 mb-3">
    <h4 class="mb-0">Scratch <small class="text-secondary fs-6">${SCRATCH_TILDE}</small></h4>
    <div class="ms-auto d-flex gap-2">
      <button class="btn btn-sm btn-outline-secondary" onclick="document.getElementById('file-input').click()">Upload file</button>
      <button class="btn btn-sm btn-outline-secondary" onclick="handlePasteBtn()">Paste</button>
      <input type="file" id="file-input" class="d-none" multiple onchange="handleFileInput(this)">
    </div>
  </div>

  ${files.length === 0
    ? '<p class="text-secondary">No files.</p>'
    : `<table class="table table-hover table-sm">
        <thead><tr><th>Name</th><th class="text-end">Size</th><th>Modified</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`}

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let pendingFiles = []
    let uploadModal = null

    document.addEventListener('DOMContentLoaded', () => {
      uploadModal = new bootstrap.Modal(document.getElementById('uploadModal'))
    })

    // ── Cmd/Ctrl+V anywhere on the page ─────────────────────────────────────
    document.addEventListener('paste', async e => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()

      const files = []
      const textPromises = []

      for (const item of e.clipboardData.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (!f) continue
          const ext = f.type ? (f.type.split('/')[1] || 'bin') : 'bin'
          const genericNames = ['', 'image.png', 'image.jpeg', 'image.jpg', 'image.gif', 'image.webp']
          const name = genericNames.includes(f.name) ? timestampName(ext) : f.name
          files.push(new File([f], name, { type: f.type }))
        } else if (item.kind === 'string' && item.type === 'text/plain') {
          textPromises.push(new Promise(res => item.getAsString(res)))
        }
      }

      if (files.length === 0 && textPromises.length > 0) {
        const text = (await Promise.all(textPromises)).join('')
        if (text.trim()) files.push(new File([text], timestampName('txt'), { type: 'text/plain' }))
      }

      if (files.length) showListModal(files)
    })

    // ── Drag-and-drop onto page ──────────────────────────────────────────────
    let dragCounter = 0
    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragCounter++
      document.getElementById('drop-overlay').classList.add('active')
    })
    document.addEventListener('dragleave', () => {
      if (--dragCounter <= 0) { dragCounter = 0; document.getElementById('drop-overlay').classList.remove('active') }
    })
    document.addEventListener('dragover', e => e.preventDefault())
    document.addEventListener('drop', e => {
      e.preventDefault()
      dragCounter = 0
      document.getElementById('drop-overlay').classList.remove('active')
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) showListModal(files)
    })

    // ── File input ───────────────────────────────────────────────────────────
    function handleFileInput(input) {
      if (input.files?.length) showListModal([...input.files])
      input.value = ''
    }

    // ── Paste button (uses Clipboard API) ────────────────────────────────────
    async function handlePasteBtn() {
      try {
        const items = await navigator.clipboard.read()
        const files = []
        for (const item of items) {
          for (const imgType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
            if (item.types.includes(imgType)) {
              const blob = await item.getType(imgType)
              files.push(new File([blob], timestampName(imgType.split('/')[1]), { type: imgType }))
              break
            }
          }
          if (files.length === 0 && item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text()
            if (text.trim()) files.push(new File([text], timestampName('txt'), { type: 'text/plain' }))
          }
        }
        if (files.length) showListModal(files)
        else alert('Nothing useful found in clipboard.')
      } catch (err) {
        alert('Could not read clipboard: ' + err.message)
      }
    }

    // ── List modal ───────────────────────────────────────────────────────────
    function showListModal(files) {
      pendingFiles = files
      document.getElementById('upload-list').innerHTML = files.map((f, i) => \`
        <tr>
          <td class="ps-3"><input type="text" class="form-control form-control-sm upload-filename"
            data-index="\${i}" value="\${escHtml(f.name)}"></td>
          <td class="text-end pe-3 text-secondary align-middle text-nowrap">\${formatSize(f.size)}</td>
        </tr>\`).join('')
      const btn = document.getElementById('confirm-upload-btn')
      btn.disabled = false
      btn.textContent = files.length > 1 ? \`Upload \${files.length} files\` : 'Upload'
      uploadModal.show()
    }

    async function confirmUpload() {
      const inputs = [...document.querySelectorAll('#upload-list .upload-filename')]
      const entries = []
      for (let i = 0; i < inputs.length; i++) {
        const name = inputs[i].value.trim()
        if (!name || name.includes('/') || name.includes('..')) { alert('Invalid filename: ' + name); return }
        entries.push({ file: pendingFiles[i], name })
      }
      const btn = document.getElementById('confirm-upload-btn')
      btn.disabled = true
      btn.textContent = 'Uploading…'
      try {
        for (const { file, name } of entries) {
          const fd = new FormData()
          fd.append('file', new File([file], name, { type: file.type }))
          const res = await fetch('/upload', { method: 'POST', body: fd })
          if (!res.ok) throw new Error(await res.text())
        }
        uploadModal.hide()
        location.reload()
      } catch (err) {
        alert('Upload failed: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Upload'
      }
    }

    // ── Copy @ path ──────────────────────────────────────────────────────────
    function copyPath(el) {
      navigator.clipboard.writeText(el.dataset.path).then(() => {
        el.classList.add('copied')
        el.textContent = '✓'
        setTimeout(() => { el.classList.remove('copied'); el.textContent = '@' }, 1200)
      })
    }

    function dragPath(e, el) {
      e.stopPropagation()
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('text/plain', el.dataset.path)
    }

    function dragFile(e, mime, encodedName) {
      const url = window.location.origin + '/file/' + encodedName
      const filename = decodeURIComponent(encodedName)
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('DownloadURL', mime + ':' + filename + ':' + url)
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function timestampName(ext) {
      const n = new Date(), p = v => String(v).padStart(2, '0')
      const date = \`\${n.getFullYear()}\${p(n.getMonth()+1)}\${p(n.getDate())}\`
      const time = \`\${p(n.getHours())}\${p(n.getMinutes())}\${p(n.getSeconds())}\`
      return \`\${date}-\${time}-\${Math.random().toString(36).slice(2,6).toUpperCase()}.\${ext}\`
    }

    function formatSize(b) {
      if (b < 1024) return b + ' B'
      if (b < 1048576) return (b/1024).toFixed(1) + ' KB'
      if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB'
      return (b/1073741824).toFixed(1) + ' GB'
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }
  </script>
</body>
</html>`)
})

app.post('/upload', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file'] as File
  if (!file || typeof file === 'string') return c.text('No file', 400)
  const filename = file.name
  if (!filename || filename.includes('/') || filename.includes('..')) {
    return c.text('Invalid filename', 400)
  }
  const buf = await file.arrayBuffer()
  await writeFile(join(SCRATCH_DIR, filename), Buffer.from(buf))
  return c.text('OK')
})

app.get('/file/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'))
  if (name.includes('/') || name.includes('..')) return c.text('Not found', 404)
  const filepath = join(SCRATCH_DIR, name)
  let size: number
  try {
    size = statSync(filepath).size
  } catch {
    return c.text('Not found', 404)
  }
  const stream = createReadStream(filepath)
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': getMime(name),
      'Content-Length': String(size),
    },
  })
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, () => {
  console.log(`Listening on http://127.0.0.1:${PORT}`)
})
