// ai-brief-site — a tiny, ZERO-DEPENDENCY (Node stdlib only) web app that renders Jarvis's
// daily AI briefs as a clean RTL reading site, keeps a 7-day history, and lets Yossef save any
// item as a task (persisted into ~/.openclaw/workspace/tasks.md until he removes it).
//
// No npm install — respects the NPM lockdown policy. Run as a systemd --user service.
// Config via env: PORT, AUTH_USER, AUTH_PASS, BRIEFS_DIR, TASKS_FILE, BASE_URL, RETAIN_DAYS
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = parseInt(process.env.PORT || '8088', 10)
const BRIEFS_DIR = process.env.BRIEFS_DIR || '/home/yossef7875/.openclaw/workspace/insights/briefs'
const TASKS_FILE = process.env.TASKS_FILE || '/home/yossef7875/.openclaw/workspace/tasks.md'
const BASE_URL = process.env.BASE_URL || 'https://brief.byclick.co.il'
const ANTHROPIC_FEED = process.env.ANTHROPIC_FEED || '/home/yossef7875/.openclaw/workspace/insights/anthropic-feed.json'
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
  // date chips — only dates in parens (DD.MM[.YY]) or ISO; avoids matching version numbers like "4.8"
  h = h.replace(/\((\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)\)/g, '<span class="date">📅 $1</span>')
  h = h.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, '<span class="date">📅 $1</span>')
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

// [start, end) offsets of the saved block (text right after the heading), or null if absent
function savedBounds(txt) {
  const idx = txt.indexOf(SAVED_HEADING)
  if (idx === -1) return null
  const start = idx + SAVED_HEADING.length
  const end = txt.slice(start).search(/\n## |\n---/)
  return [start, end === -1 ? txt.length : start + end]
}

// text of a saved bullet line (without the 🟡 marker and the "(AI dd.mm)" suffix), or undefined
function bulletText(l) {
  const m = (l.match(/^[-*]\s+(?:🟡\s*)?(.*)$/) || [])[1]
  return m && m.replace(/\s*_\(AI .*?\)_\s*$/, '').trim()
}

function savedItems() {
  const txt = readTasks()
  const b = savedBounds(txt)
  if (!b) return []
  return txt.slice(b[0], b[1]).split('\n').map(bulletText).filter(Boolean)
}

// one tasks.md read per request; pass the Set to renderers instead of re-reading per item
const savedSet = () => new Set(savedItems())

function saveTask(text, dateLabel) {
  const t = plain(text)
  if (savedSet().has(t)) return
  let txt = readTasks()
  const line = `- 🟡 ${t} _(AI ${dateLabel})_`
  const b = savedBounds(txt)
  if (!b) {
    const section = `\n${SAVED_HEADING}\n\n> נשמר מהתדריך היומי. נמחק כשתסיים/תסיר.\n\n${line}\n`
    const at = txt.indexOf('\n## Completed')
    txt = at === -1 ? txt.trimEnd() + '\n' + section : txt.slice(0, at) + section + txt.slice(at)
  } else {
    txt = txt.slice(0, b[1]).trimEnd() + '\n' + line + txt.slice(b[1])
  }
  fs.writeFileSync(TASKS_FILE, txt)
}

// removes the item only from the saved section — identical tasks elsewhere in tasks.md stay put
function unsaveTask(text) {
  const t = plain(text)
  const txt = readTasks()
  const b = savedBounds(txt)
  if (!b) return
  const block = txt.slice(b[0], b[1]).split('\n').filter((l) => bulletText(l) !== t).join('\n')
  fs.writeFileSync(TASKS_FILE, txt.slice(0, b[0]) + block + txt.slice(b[1]))
}

// ─── rendering ──────────────────────────────────────────────────────────────
const SOURCE_SECTION = (t) => /מקור/.test(t)

const saveBtn = (text, date, saved) =>
  `<button class="save ${saved ? 'on' : ''}" data-text="${esc(plain(text))}" data-date="${date}" title="שמור כמשימה">${saved ? '✓ נשמר' : '＋ משימה'}</button>`

// shared shell: <head>, sidebar (history + nav) and main column — used by every page
function page({ title, active = '', activeDate = '', main }) {
  const dates = listBriefs().map((f) => f.slice(0, 10)).slice(0, RETAIN_DAYS)
  const history = dates.map((d) =>
    `<a class="hx ${d === activeDate ? 'on' : ''}" href="/?d=${d}">${ddmm(d)}</a>`).join('')
  const link = (href, key, label) =>
    `<a class="nav-link ${active === key ? 'on' : ''}" href="${href}">${label}</a>`
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔥</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="wrap">
  <aside class="side">
    <a class="brand" href="/">🔥 תדריך AI</a>
    <div class="sub">דרך העדשה שלך</div>
    ${dates.length ? `<div class="hlabel">היסטוריה (${RETAIN_DAYS} ימים)</div><nav class="hist">${history}</nav>` : ''}
    <nav class="links">
      ${link('/anthropic', 'anthropic', '🅰️ עדכוני Anthropic')}
      ${link('/saved', 'saved', '⭐ משימות שמורות')}
    </nav>
    <div class="foot">Jarvis · מתעדכן כל בוקר</div>
  </aside>
  <main class="main">${main}</main>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>${JS}</script>
</body></html>`
}

function renderBrief(b, saved) {
  const sectionsHtml = b.sections.map((sec) => {
    if (SOURCE_SECTION(sec.title)) {
      const links = sec.items.map((it) => `<li>${inline(it)}</li>`).join('')
      return `<section class="card sources"><h2>${esc(sec.title)}</h2><ul>${links}</ul></section>`
    }
    const items = sec.items.map((it) => `<li>
        <span class="txt">${inline(it)}</span>
        ${saveBtn(it, ddmm(b.date), saved.has(plain(it)))}
      </li>`).join('')
    return `<section class="card"><h2>${esc(sec.title)}</h2><ul class="items">${items}</ul></section>`
  }).join('')

  return page({
    title: b.title,
    activeDate: b.date,
    main: `<h1>${esc(b.title)}</h1>
    ${b.headline ? `<blockquote class="lead">${inline(b.headline)}</blockquote>` : ''}
    ${sectionsHtml}`,
  })
}

function loadFeed() {
  try {
    const arr = JSON.parse(fs.readFileSync(ANTHROPIC_FEED, 'utf8'))
    return Array.isArray(arr) ? arr.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')) : []
  } catch { return [] }
}

function renderAnthropic(saved) {
  const items = loadFeed()
  // group by date (already newest-first)
  const groups = []
  for (const it of items) {
    let g = groups.find((x) => x.date === it.date)
    if (!g) { g = { date: it.date, items: [] }; groups.push(g) }
    g.items.push(it)
  }
  const body = groups.length ? groups.map((g) => {
    const rows = g.items.map((it) => {
      const who = it.who || it.handle || ''
      const handle = it.handle && it.handle !== it.who ? ' ' + esc(it.handle) : ''
      const link = it.url ? `<a class="src" href="${esc(it.url)}" target="_blank" rel="noopener">↗ מקור מלא</a>` : ''
      const deep = it.body_he ? `<p class="deep">${inline(it.body_he)}</p>` : ''
      const lead = `<p class="lead-line">${inline(it.text)}</p>`
      return `<li class="feed">
        <div class="ahead"><strong>${esc(who)}${handle}</strong>
          ${saveBtn(it.text, ddmm(it.date), saved.has(plain(it.text)))}
        </div>
        ${lead}${deep}${link}
      </li>`
    }).join('')
    return `<section class="card"><h2><span class="date">📅 ${ddmm(g.date)}</span></h2><ul class="items">${rows}</ul></section>`
  }).join('') : '<section class="card"><p class="empty">עדיין אין פריטים בחלון 7 הימים. הסורק השעתי ימלא אותם.</p></section>'

  return page({
    title: 'Anthropic — השבוע האחרון',
    active: 'anthropic',
    main: `<h1>🅰️ Anthropic — השבוע האחרון</h1>
  <p class="note">כל מה שחם מ-Anthropic / Claude Code (Boris, Cat Wu, Alex Albert, @AnthropicAI), מהחדש לישן, מקובץ לפי יום — כדי שתראה גם מה פספסת. מתעדכן כל שעה.</p>
  ${body}`,
  })
}

function renderSaved() {
  const items = savedItems()
  const rows = items.length
    ? items.map((t) => `<li><span class="txt">${esc(t)}</span>
        <button class="save on" data-text="${esc(t)}" data-date="">✓ הסר</button></li>`).join('')
    : '<li class="empty">אין משימות שמורות עדיין. שמור פריט מעניין מהתדריך.</li>'
  return page({
    title: 'משימות שמורות',
    active: 'saved',
    main: `<h1>⭐ משימות שמורות</h1>
  <p class="note">נשמרות גם ב-tasks.md של Jarvis ומופיעות בתזכורות היומיות. נשארות עד שתסיר.</p>
  <section class="card"><ul class="items">${rows}</ul></section>`,
  })
}

function renderEmpty(title, msg) {
  return page({ title, main: `<h1>${esc(title)}</h1><section class="card"><p class="empty">${esc(msg)}</p></section>` })
}

// ─── server ──────────────────────────────────────────────────────────────
function unauthorized(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AI Brief"' }).end('Auth required')
}
// constant-time compare (hash first so differing lengths don't leak via timing either)
const same = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest())
function checkAuth(req) {
  if (!AUTH_USER) return true // auth disabled if no user configured (local dev)
  const h = req.headers.authorization || ''
  const m = h.match(/^Basic (.+)$/)
  if (!m) return false
  const cred = Buffer.from(m[1], 'base64').toString()
  const i = cred.indexOf(':') // split on the FIRST colon only — passwords may contain ':'
  if (i === -1) return false
  return (same(cred.slice(0, i), AUTH_USER) & same(cred.slice(i + 1), AUTH_PASS)) === 1 // no short-circuit
}

// CSRF guard for state-changing requests: browsers auto-send Basic Auth creds cross-site, so
// require a JSON content-type (forces a CORS preflight) and, when present, a same-host Origin.
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function body(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
  })
}

const html = (res, status, s) =>
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(s)

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) return unauthorized(res)
  const url = new URL(req.url, 'http://x')

  if (req.method === 'POST' && (url.pathname === '/save' || url.pathname === '/unsave')) {
    if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return }
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

  if (url.pathname === '/anthropic') return html(res, 200, renderAnthropic(savedSet()))
  if (url.pathname === '/saved') return html(res, 200, renderSaved())

  if (url.pathname === '/' || url.pathname === '') {
    const dates = listBriefs().map((f) => f.slice(0, 10)).slice(0, RETAIN_DAYS)
    if (!dates.length) return html(res, 200, renderEmpty('תדריך AI', 'אין תדריכים עדיין.'))
    const want = url.searchParams.get('d')
    const active = dates.includes(want) ? want : dates[0]
    return html(res, 200, renderBrief(parseBrief(`${active}-ai-brief.md`), savedSet()))
  }

  html(res, 404, renderEmpty('הדף לא נמצא', 'אין כאן כלום. חזור לתדריך מהתפריט.'))
})

server.listen(PORT, '0.0.0.0', () => console.log(`ai-brief-site on :${PORT}  (briefs=${BRIEFS_DIR})`))

// ─── assets (inlined; no external files) ─────────────────────────────────────
const CSS = `
:root{--deep:#1E3A5F;--blue:#3B6B9C;--light:#5A8DB8;--brown:#8B6F47;--bg:#f4f6f9;--card:#fff;--ink:#1b2733;--muted:#5b6b7b;--line:#e3e9f0;
  --head:var(--deep);--link:var(--blue);--chip:#eef3f9;--soft:#fafbfd;--shadow:rgba(0,0,0,.05);--side-a:var(--deep);--side-b:var(--blue)}
@media(prefers-color-scheme:dark){:root{--bg:#0f1620;--card:#172230;--ink:#e3eaf2;--muted:#93a4b6;--line:#26364a;
  --head:#cfe0f3;--link:#8cb8e2;--chip:#1f2e40;--soft:#131d29;--shadow:rgba(0,0,0,.35);--side-a:#16263b;--side-b:#23405f;--brown:#b8966a}}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:Heebo,system-ui,'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.65}
.wrap{display:grid;grid-template-columns:248px 1fr;gap:28px;max-width:1080px;margin:0 auto;padding:28px 22px}
.side{position:sticky;top:24px;align-self:start;background:linear-gradient(160deg,var(--side-a),var(--side-b));color:#fff;border-radius:18px;padding:22px 18px;box-shadow:0 10px 30px rgba(30,58,95,.18)}
.brand{display:block;font-size:1.4rem;font-weight:800;color:#fff;text-decoration:none}.sub{opacity:.8;font-size:.85rem;margin-bottom:18px}
.hlabel{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin:14px 0 8px}
.hist{display:flex;flex-wrap:wrap;gap:6px}
.hx{display:inline-block;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;padding:5px 11px;border-radius:9px;font-weight:600;font-size:.9rem}
.hx.on{background:#fff;color:var(--deep)}
.links{display:flex;flex-direction:column;gap:8px;margin-top:18px}
.nav-link{display:block;color:#fff;text-decoration:none;background:rgba(255,255,255,.14);padding:9px 12px;border-radius:10px;font-weight:600;text-align:center}
.nav-link.on{background:#fff;color:var(--deep)}
.hx:focus-visible,.nav-link:focus-visible,.brand:focus-visible{outline:2px solid #fff;outline-offset:2px}
.foot{margin-top:18px;font-size:.72rem;opacity:.65}
.main{min-width:0}
h1{font-size:1.7rem;font-weight:800;color:var(--head);margin:.2em 0 .5em}
.lead{font-size:1.12rem;font-weight:500;background:var(--card);border-right:5px solid var(--brown);margin:0 0 22px;padding:14px 18px;border-radius:0 12px 12px 0;box-shadow:0 4px 14px var(--shadow)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:18px;box-shadow:0 4px 14px var(--shadow)}
.card h2{margin:.1em 0 .6em;font-size:1.15rem;color:var(--head)}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px dashed var(--line)}
.items li:last-child{border-bottom:0}
.txt{flex:1;min-width:0;overflow-wrap:anywhere}.txt a{color:var(--link);font-weight:600}
.date{display:inline-block;background:var(--chip);color:var(--brown);border:1px solid var(--line);border-radius:7px;padding:0 7px;font-size:.78rem;font-weight:700;white-space:nowrap;margin-inline-start:2px}
.feed{flex-direction:column;align-items:stretch;gap:6px}
.ahead{display:flex;justify-content:space-between;align-items:center;gap:10px}
.ahead strong{color:var(--head);font-size:1.02rem}
.lead-line{margin:2px 0;font-weight:600}
.deep{margin:2px 0;color:var(--ink);line-height:1.75;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 13px}
.src{font-size:.85rem;color:var(--link);font-weight:600;text-decoration:none}
.save{flex:0 0 auto;border:1px solid var(--link);background:var(--card);color:var(--link);border-radius:999px;padding:4px 12px;font-family:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:.15s}
.save:hover{background:var(--link);color:var(--card)}
.save.on{background:var(--brown);border-color:var(--brown);color:#fff}
.save:disabled{opacity:.6;cursor:wait}
.sources ul{margin:0;padding-inline-start:1.1em}.sources li{padding:4px 0}
.sources a{color:var(--link)}
.note,.empty{color:var(--muted)}.empty{padding:14px 0;list-style:none}
.toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--deep);color:#fff;padding:11px 20px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:760px){
  .wrap{grid-template-columns:1fr;gap:16px;padding:12px 16px}
  .side{position:static;padding:12px 14px;border-radius:14px}
  .sub,.hlabel,.foot{display:none}
  .brand{font-size:1.15rem}
  .hist{flex-wrap:nowrap;overflow-x:auto;margin-top:10px;padding-bottom:2px;scrollbar-width:none}
  .hist::-webkit-scrollbar{display:none}
  .hx{flex:0 0 auto}
  .links{flex-direction:row;margin-top:10px}
  .nav-link{flex:1;padding:7px 8px;font-size:.85rem}
  h1{font-size:1.35rem}
  .card{padding:14px 15px}
  .items li{flex-direction:column;gap:6px}.items li.feed{gap:6px}
  .items li>.save{align-self:flex-end}
}
`

const JS = `
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1900)}
document.addEventListener('click',function(e){
  var b=e.target.closest('.save');if(!b||b.disabled)return;
  var saved=b.classList.contains('on');
  var ep=saved?'/unsave':'/save';
  b.disabled=true;
  fetch(ep,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:b.dataset.text,date:b.dataset.date})})
   .then(function(r){return r.ok?r.json():{ok:false}}).then(function(j){
     if(!j.ok){toast('שגיאה בשמירה');return}
     if(saved){if(location.pathname==='/saved'){b.closest('li').remove();toast('הוסר')}else{b.classList.remove('on');b.textContent='＋ משימה';toast('הוסר מהמשימות')}}
     else{b.classList.add('on');b.textContent='✓ נשמר';toast('נשמר כמשימה ✓')}
   }).catch(function(){toast('שגיאת רשת')}).finally(function(){b.disabled=false})
})
`
