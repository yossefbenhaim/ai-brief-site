// ai-brief-site — a tiny, ZERO-DEPENDENCY (Node stdlib only) web app that renders Jarvis's
// daily AI briefs as a clean RTL reading site, keeps a 7-day history, and lets Yossef save any
// item as a task (persisted into ~/.openclaw/workspace/tasks.md until he removes it).
//
// No npm install — respects the NPM lockdown policy. Run as a systemd --user service.
// Config via env: PORT, AUTH_USER, AUTH_PASS, BRIEFS_DIR, TASKS_FILE, BASE_URL, RETAIN_DAYS
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = parseInt(process.env.PORT || '8088', 10)
const BRIEFS_DIR = process.env.BRIEFS_DIR || '/home/yossef7875/.openclaw/workspace/insights/briefs'
const TASKS_FILE = process.env.TASKS_FILE || '/home/yossef7875/.openclaw/workspace/tasks.md'
const BASE_URL = process.env.BASE_URL || 'https://brief.byclick.co.il'
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || '7', 10)
const AUTH_USER = process.env.AUTH_USER || ''
const AUTH_PASS = process.env.AUTH_PASS || ''
const SAVED_HEADING = '## Saved from AI Brief'

// ─── helpers ──────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// inline markdown for the controlled subset: **bold** and [text](url)
function inline(s) {
  let h = esc(s)
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>')
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return h
}
// plain text of a bullet (strip markdown) — used as the task text when saving
function plain(s) {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim()
}

function listBriefs() {
  if (!fs.existsSync(BRIEFS_DIR)) return []
  return fs.readdirSync(BRIEFS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-ai-brief\.md$/.test(f))
    .sort().reverse()
}

function parseBrief(file) {
  const raw = fs.readFileSync(path.join(BRIEFS_DIR, file), 'utf8')
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  const front = fm ? fm[1] : ''
  const body = fm ? fm[2] : raw
  const title = (front.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || file
  const date = (front.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1] || ''
  let headline = '', cur = null
  const sections = []
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) continue
    if (/^\[\[/.test(line.trim())) continue
    const h2 = line.match(/^##\s+(.*)$/)
    if (h2) { cur = { title: h2[1].trim(), items: [] }; sections.push(cur); continue }
    if (line.startsWith('>')) { headline += (headline ? ' ' : '') + line.replace(/^>\s?/, ''); continue }
    const b = line.match(/^[-*]\s+(.*)$/)
    if (b && cur) cur.items.push(b[1].trim())
  }
  return { file, title, date, headline, sections }
}

function ddmm(date) {
  const [y, m, d] = date.split('-')
  return `${d}.${m}`
}

// ─── tasks.md saved-section management (single source of truth) ─────────────
function readTasks() { return fs.existsSync(TASKS_FILE) ? fs.readFileSync(TASKS_FILE, 'utf8') : '' }

function savedItems() {
  const txt = readTasks()
  const idx = txt.indexOf(SAVED_HEADING)
  if (idx === -1) return []
  const after = txt.slice(idx + SAVED_HEADING.length)
  const end = after.search(/\n## |\n---/)
  const block = end === -1 ? after : after.slice(0, end)
  return block.split('\n')
    .map((l) => (l.match(/^[-*]\s+(?:🟡\s*)?(.*)$/) || [])[1])
    .filter(Boolean)
    .map((l) => l.replace(/\s*_\(AI .*?\)_\s*$/, '').trim())
}

function isSaved(text) {
  const t = plain(text)
  return savedItems().some((s) => s === t)
}

function saveTask(text, dateLabel) {
  const t = plain(text)
  if (isSaved(t)) return
  let txt = readTasks()
  const line = `- 🟡 ${t} _(AI ${dateLabel})_`
  if (txt.indexOf(SAVED_HEADING) === -1) {
    const section = `\n${SAVED_HEADING}\n\n> נשמר מהתדריך היומי. נמחק כשתסיים/תסיר.\n\n${line}\n`
    const at = txt.indexOf('\n## Completed')
    txt = at === -1 ? txt.trimEnd() + '\n' + section : txt.slice(0, at) + section + txt.slice(at)
  } else {
    const idx = txt.indexOf(SAVED_HEADING) + SAVED_HEADING.length
    const after = txt.slice(idx)
    const end = after.search(/\n## |\n---/)
    const insertAt = idx + (end === -1 ? after.length : end)
    txt = txt.slice(0, insertAt).trimEnd() + '\n' + line + txt.slice(insertAt)
  }
  fs.writeFileSync(TASKS_FILE, txt)
}

function unsaveTask(text) {
  const t = plain(text)
  const txt = readTasks()
  const out = txt.split('\n').filter((l) => {
    const m = (l.match(/^[-*]\s+(?:🟡\s*)?(.*)$/) || [])[1]
    if (!m) return true
    return m.replace(/\s*_\(AI .*?\)_\s*$/, '').trim() !== t
  }).join('\n')
  fs.writeFileSync(TASKS_FILE, out)
}

// ─── rendering ──────────────────────────────────────────────────────────────
const SOURCE_SECTION = (t) => /מקור/.test(t)

function renderBrief(b, allDates, activeDate) {
  const history = allDates.map((d) =>
    `<a class="hx ${d === activeDate ? 'on' : ''}" href="/?d=${d}">${ddmm(d)}</a>`).join('')
  const sectionsHtml = b.sections.map((sec) => {
    if (SOURCE_SECTION(sec.title)) {
      const links = sec.items.map((it) => `<li>${inline(it)}</li>`).join('')
      return `<section class="card sources"><h2>${esc(sec.title)}</h2><ul>${links}</ul></section>`
    }
    const items = sec.items.map((it) => {
      const saved = isSaved(it)
      return `<li>
        <span class="txt">${inline(it)}</span>
        <button class="save ${saved ? 'on' : ''}" data-text="${esc(plain(it))}" data-date="${ddmm(b.date)}" title="שמור כמשימה">
          ${saved ? '✓ נשמר' : '＋ משימה'}
        </button>
      </li>`
    }).join('')
    return `<section class="card"><h2>${esc(sec.title)}</h2><ul class="items">${items}</ul></section>`
  }).join('')

  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(b.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="wrap">
  <aside class="side">
    <div class="brand">🔥 תדריך AI</div>
    <div class="sub">דרך העדשה שלך</div>
    <nav class="hist"><div class="hlabel">היסטוריה (7 ימים)</div>${history}</nav>
    <a class="saved-link" href="/saved">⭐ משימות שמורות</a>
    <div class="foot">Jarvis · מתעדכן כל בוקר</div>
  </aside>
  <main class="main">
    <h1>${esc(b.title)}</h1>
    ${b.headline ? `<blockquote class="lead">${inline(b.headline)}</blockquote>` : ''}
    ${sectionsHtml}
  </main>
</div>
<div id="toast" class="toast"></div>
<script>${JS}</script>
</body></html>`
}

function renderSaved() {
  const items = savedItems()
  const rows = items.length
    ? items.map((t) => `<li><span class="txt">${esc(t)}</span>
        <button class="save on" data-text="${esc(t)}" data-date="">✓ הסר</button></li>`).join('')
    : '<li class="empty">אין משימות שמורות עדיין. שמור פריט מעניין מהתדריך.</li>'
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>משימות שמורות</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="wrap"><main class="main full">
  <a class="back" href="/">→ חזרה לתדריך</a>
  <h1>⭐ משימות שמורות</h1>
  <p class="note">נשמרות גם ב-tasks.md של Jarvis ומופיעות בתזכורות היומיות. נשארות עד שתסיר.</p>
  <section class="card"><ul class="items">${rows}</ul></section>
</main></div>
<div id="toast" class="toast"></div>
<script>${JS}</script></body></html>`
}

// ─── server ──────────────────────────────────────────────────────────────
function unauthorized(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AI Brief"' }).end('Auth required')
}
function checkAuth(req) {
  if (!AUTH_USER) return true // auth disabled if no user configured (local dev)
  const h = req.headers.authorization || ''
  const m = h.match(/^Basic (.+)$/)
  if (!m) return false
  const [u, p] = Buffer.from(m[1], 'base64').toString().split(':')
  return u === AUTH_USER && p === AUTH_PASS
}

function body(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) return unauthorized(res)
  const url = new URL(req.url, 'http://x')

  if (req.method === 'POST' && (url.pathname === '/save' || url.pathname === '/unsave')) {
    const { text, date } = await body(req)
    if (!text) { res.writeHead(400).end('no text'); return }
    try {
      if (url.pathname === '/save') saveTask(text, date || '')
      else unsaveTask(text)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e) }))
    }
    return
  }

  if (url.pathname === '/saved') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderSaved())
    return
  }

  if (url.pathname === '/' || url.pathname === '') {
    const dates = listBriefs().map((f) => f.slice(0, 10)).slice(0, RETAIN_DAYS)
    if (!dates.length) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:sans-serif;padding:3rem">אין תדריכים עדיין.</body>')
      return
    }
    const want = url.searchParams.get('d')
    const active = dates.includes(want) ? want : dates[0]
    const b = parseBrief(`${active}-ai-brief.md`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderBrief(b, dates, active))
    return
  }

  res.writeHead(404).end('not found')
})

server.listen(PORT, '0.0.0.0', () => console.log(`ai-brief-site on :${PORT}  (briefs=${BRIEFS_DIR})`))

// ─── assets (inlined; no external files) ─────────────────────────────────────
const CSS = `
:root{--deep:#1E3A5F;--blue:#3B6B9C;--light:#5A8DB8;--brown:#8B6F47;--bg:#f4f6f9;--card:#fff;--ink:#1b2733;--muted:#5b6b7b;--line:#e3e9f0}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:Heebo,system-ui,'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.65}
.wrap{display:grid;grid-template-columns:248px 1fr;gap:28px;max-width:1080px;margin:0 auto;padding:28px 22px}
.side{position:sticky;top:24px;align-self:start;background:linear-gradient(160deg,var(--deep),var(--blue));color:#fff;border-radius:18px;padding:22px 18px;box-shadow:0 10px 30px rgba(30,58,95,.18)}
.brand{font-size:1.4rem;font-weight:800}.sub{opacity:.8;font-size:.85rem;margin-bottom:18px}
.hlabel{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin:14px 0 8px}
.hist{display:flex;flex-wrap:wrap;gap:6px}
.hx{display:inline-block;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;padding:5px 11px;border-radius:9px;font-weight:600;font-size:.9rem}
.hx.on{background:#fff;color:var(--deep)}
.saved-link{display:block;margin-top:18px;color:#fff;text-decoration:none;background:rgba(255,255,255,.14);padding:9px 12px;border-radius:10px;font-weight:600;text-align:center}
.foot{margin-top:18px;font-size:.72rem;opacity:.65}
.main{min-width:0}.main.full{grid-column:1/-1;max-width:760px;margin:0 auto}
h1{font-size:1.7rem;font-weight:800;color:var(--deep);margin:.2em 0 .5em}
.lead{font-size:1.12rem;font-weight:500;background:#fff;border-right:5px solid var(--brown);margin:0 0 22px;padding:14px 18px;border-radius:0 12px 12px 0;box-shadow:0 4px 14px rgba(0,0,0,.05)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:18px;box-shadow:0 4px 14px rgba(0,0,0,.04)}
.card h2{margin:.1em 0 .6em;font-size:1.15rem;color:var(--deep)}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px dashed var(--line)}
.items li:last-child{border-bottom:0}
.txt{flex:1}.txt a{color:var(--blue);font-weight:600}
.save{flex:0 0 auto;border:1px solid var(--blue);background:#fff;color:var(--blue);border-radius:999px;padding:4px 12px;font-family:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:.15s}
.save:hover{background:var(--blue);color:#fff}
.save.on{background:var(--brown);border-color:var(--brown);color:#fff}
.sources ul{margin:0;padding-inline-start:1.1em}.sources li{padding:4px 0}
.sources a{color:var(--blue)}
.back{display:inline-block;color:var(--blue);text-decoration:none;font-weight:600;margin-bottom:8px}
.note,.empty{color:var(--muted)}.empty{padding:14px 0;list-style:none}
.toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--deep);color:#fff;padding:11px 20px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:760px){.wrap{grid-template-columns:1fr;padding:16px}.side{position:static}}
`

const JS = `
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1900)}
document.addEventListener('click',function(e){
  var b=e.target.closest('.save');if(!b)return;
  var saved=b.classList.contains('on');
  var ep=saved?'/unsave':'/save';
  fetch(ep,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:b.dataset.text,date:b.dataset.date})})
   .then(function(r){return r.json()}).then(function(j){
     if(!j.ok){toast('שגיאה בשמירה');return}
     if(saved){if(location.pathname==='/saved'){b.closest('li').remove();toast('הוסר')}else{b.classList.remove('on');b.textContent='＋ משימה';toast('הוסר מהמשימות')}}
     else{b.classList.add('on');b.textContent='✓ נשמר';toast('נשמר כמשימה ✓')}
   }).catch(function(){toast('שגיאת רשת')})
})
`
