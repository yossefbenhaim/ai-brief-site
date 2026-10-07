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
// Tracker: same JSON files Jarvis writes through workspace/tracker/tracker.py
const WS = process.env.WS_DIR || path.dirname(TASKS_FILE)
const TRACK_DIR = path.join(WS, 'tracker')
const SYLLABUS = path.join(WS, 'learning', 'system-design', 'syllabus.md')

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
      ${link('/features', 'features', '🏗️ פיצ׳רים ומשאבים')}
      ${link('/track', 'track', '📋 מעקב יומי')}
      ${link('/english', 'english', '🇬🇧 אנגלית STE')}
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


// ─── tracker (/track) ───────────────────────────────────────────────────────
// Yossef's side of the tracker. The gate (advancing a lesson) is NOT here: only
// Jarvis advances, after grading an answer as correct (tracker.py grade).
const TRACK_DEFAULTS = {
  learning: { course: 'system-design', current_lesson: 1, lessons: {}, questions: [] },
  tasks: { projects: ['תפסתי', 'בדיקות כדאיות', 'לקוח חדש', 'אישי'], tasks: [] },
  income: { entries: [] },
  english: { words: [] },
}
function tload(name) {
  try { return JSON.parse(fs.readFileSync(path.join(TRACK_DIR, name + '.json'), 'utf8')) }
  catch { return structuredClone(TRACK_DEFAULTS[name]) }
}
function tsave(name, data) {
  const f = path.join(TRACK_DIR, name + '.json'), tmp = path.join(TRACK_DIR, `.${name}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o664 })
  fs.renameSync(tmp, f)
}
const nextId = (arr) => Math.max(0, ...arr.map((x) => x.id || 0)) + 1
const todayISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' })
function syllabusRows() {
  try {
    return fs.readFileSync(SYLLABUS, 'utf8').split('\n').map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      .filter((c) => c.length === 4 && /^\d+$/.test(c[0])).map((c) => ({ n: +c[0], topic: c[1], pages: c[2] }))
  } catch { return [] }
}
const openQuestion = (L) => [...L.questions].reverse().find((q) => !q.grade)
function workdaysSince(iso) {
  let n = 0; const d = new Date(iso + 'T12:00:00'), end = new Date(todayISO() + 'T12:00:00')
  while (d < end) { d.setDate(d.getDate() + 1); if (d.getDay() !== 5 && d.getDay() !== 6) n++ }
  return n
}
const MOODS = ['🙂', '😐', '😠', '😡', '🤬']
const GRADE = { correct: ['✅', 'נכון'], partial: ['🟡', 'חלקי'], wrong: ['❌', 'לא נכון'] }
const ils = (n) => '₪' + Math.round(n).toLocaleString('he-IL')

function trackAction(a) {
  switch (a.action) {
    case 'learned': { const L = tload('learning'); const s = (L.lessons[a.n] ||= {}); s.learned = !!a.on; tsave('learning', L); return }
    case 'answer': {
      const L = tload('learning'); const q = openQuestion(L)
      if (!q) throw new Error('אין שאלה פתוחה')
      if (!String(a.text || '').trim()) throw new Error('תשובה ריקה')
      Object.assign(q, { answer: String(a.text).trim(), answered_at: new Date().toISOString().slice(0, 16), via: 'web' })
      tsave('learning', L); return
    }
    case 'task-add': {
      const T = tload('tasks'); if (!String(a.title || '').trim()) throw new Error('כותרת ריקה')
      T.tasks.push({ id: nextId(T.tasks), project: a.project, title: String(a.title).trim(), done: false, created: todayISO(), updated: todayISO(), note: '' })
      tsave('tasks', T); return
    }
    case 'task-done': {
      const T = tload('tasks'); const t = T.tasks.find((x) => x.id === +a.id); if (!t) throw new Error('לא נמצא')
      t.done = !!a.on; t.done_at = a.on ? todayISO() : null; t.updated = todayISO(); tsave('tasks', T); return
    }
    case 'income-add': {
      const I = tload('income'); const amount = parseFloat(a.amount)
      if (!(amount > 0) || !String(a.client || '').trim()) throw new Error('חסר לקוח או סכום')
      I.entries.push({ id: nextId(I.entries), date: a.date || todayISO(), client: String(a.client).trim(), amount, note: String(a.note || '') })
      tsave('income', I); return
    }
    case 'word-known': {
      const E = tload('english'); const w = E.words.find((x) => x.id === +a.id); if (!w) throw new Error('לא נמצא')
      w.known = !!a.on; tsave('english', E); return
    }
    default: throw new Error('פעולה לא מוכרת')
  }
}

function renderTrack() {
  const L = tload('learning'), T = tload('tasks'), I = tload('income'), E = tload('english')
  const rows = syllabusRows(), cur = L.current_lesson, q = openQuestion(L)
  const verified = Object.values(L.lessons).filter((s) => s.verified).length
  const curRow = rows.find((r) => r.n === cur)

  let qHtml
  if (!q) qHtml = `<p class="note">אין שאלה פתוחה. ג'ארוויס ישאל על <strong>${esc(curRow ? curRow.topic : 'השיעור הבא')}</strong> בתדריך הבוקר הבא.</p>`
  else if (q.answer) qHtml = `<div class="qbox"><div class="qtext">${esc(q.q)}</div>
      <div class="ans"><strong>התשובה שלך:</strong> ${esc(q.answer)}</div>
      <p class="note">⏳ ממתין לבדיקה של ג'ארוויס. התשובה תיבדק תוך כמה דקות והמשוב יגיע לטלגרם.</p></div>`
  else {
    const days = workdaysSince(q.asked_at), mood = MOODS[Math.min(days, MOODS.length - 1)]
    qHtml = `<div class="qbox"><div class="qhead"><span>שאלה פתוחה · שיעור ${q.lesson}</span><span class="mood" title="ימי עבודה בלי תשובה">${mood} ${days ? days + ' ימי עבודה בלי תשובה' : 'נשאלה היום'}</span></div>
      <div class="qtext">${esc(q.q)}</div>
      <textarea id="ans" rows="5" placeholder="כתוב כאן את התשובה שלך…"></textarea>
      <button class="btn" data-act="answer">שלח תשובה</button>
      <p class="note">הפרק לא מתקדם עד שהתשובה נבדקת ונמצאת נכונה.</p></div>`
  }

  const lessonList = rows.map((r) => {
    const s = L.lessons[r.n] || {}
    const state = s.verified ? '<span class="tag ok">✅ אומת</span>' : r.n === cur ? '<span class="tag cur">➤ עכשיו</span>' : r.n > cur ? '<span class="tag lock">🔒</span>' : ''
    return `<li class="${r.n === cur ? 'curl' : ''}"><label class="chk"><input type="checkbox" data-act="learned" data-n="${r.n}" ${s.learned ? 'checked' : ''}> <span class="ln">${r.n}.</span> ${esc(r.topic)}</label>${state}</li>`
  }).join('')

  const history = L.questions.filter((x) => x.grade).slice(-10).reverse().map((x) => {
    const [ic, lb] = GRADE[x.grade] || ['', x.grade]
    return `<li class="hist-q"><div><span class="tag">${ic} ${lb}</span> <span class="note">שיעור ${x.lesson} · ${esc(x.graded_at || '')}</span></div>
      <div class="qtext sm">${esc(x.q)}</div>${x.answer ? `<div class="ans sm">${esc(x.answer)}</div>` : ''}${x.feedback ? `<div class="fb">${esc(x.feedback)}</div>` : ''}</li>`
  }).join('') || '<li class="empty">עוד אין תשובות שנבדקו.</li>'

  const taskGroups = T.projects.map((p) => {
    const items = T.tasks.filter((t) => t.project === p).sort((a, b) => a.done - b.done)
    const li = items.map((t) => `<li><label class="chk ${t.done ? 'done' : ''}"><input type="checkbox" data-act="task-done" data-id="${t.id}" ${t.done ? 'checked' : ''}> ${esc(t.title)}</label>${t.note ? `<span class="note sm">${esc(t.note)}</span>` : ''}</li>`).join('')
    const open = items.filter((t) => !t.done).length
    return `<div class="proj"><h3>${esc(p)} <span class="note">${open} פתוחות</span></h3><ul class="items">${li || '<li class="empty">אין משימות.</li>'}</ul></div>`
  }).join('')

  const month = todayISO().slice(0, 7)
  const byMonth = {}
  for (const e of I.entries) byMonth[e.date.slice(0, 7)] = (byMonth[e.date.slice(0, 7)] || 0) + e.amount
  const incRows = I.entries.filter((e) => e.date.startsWith(month)).reverse().map((e) =>
    `<li><span class="txt">${esc(e.client)}${e.note ? ` <span class="note">· ${esc(e.note)}</span>` : ''}</span><span class="date">${esc(e.date.slice(8, 10) + '.' + e.date.slice(5, 7))}</span><strong>${ils(e.amount)}</strong></li>`).join('') || '<li class="empty">אין הכנסות החודש עדיין.</li>'
  const months = Object.keys(byMonth).sort().reverse().slice(0, 6).map((m) => `<span class="chip">${m.slice(5)}/${m.slice(2, 4)}: <strong>${ils(byMonth[m])}</strong></span>`).join('')

  const words = E.words.length ? E.words.map((w) => `<li><label class="chk ${w.known ? 'done' : ''}"><input type="checkbox" data-act="word-known" data-id="${w.id}" ${w.known ? 'checked' : ''}> <strong dir="ltr">${esc(w.en)}</strong>${w.he ? ` — ${esc(w.he)}` : ''}</label><span class="note sm">${w.correct || 0}/${w.quizzed || 0}</span></li>`).join('')
    : '<li class="empty">הרשימה ריקה. המילים שתשלח ייכנסו לכאן, וג׳ארוויס יבחן אותך על שלוש מילים בכל בוקר.</li>'
  const known = E.words.filter((w) => w.known).length

  return page({ title: 'מעקב יומי', active: 'track', main: `<style>${TRACK_CSS}</style>
  <h1>📋 מעקב יומי</h1>
  <nav class="tabs"><a href="#learn">📘 לימוד</a><a href="#tasks">🗂 משימות</a><a href="#income">💰 הכנסות</a><a href="#english">🇬🇧 אנגלית</a></nav>

  <section class="card" id="learn">
    <h2>📘 System Design · שיעור ${cur}/${rows.length}</h2>
    <div class="bar"><div style="width:${rows.length ? Math.round(verified / rows.length * 100) : 0}%"></div></div>
    <p class="note">${verified} שיעורים אומתו בשאלה · ${Object.values(L.lessons).filter((s) => s.learned).length} סומנו כנלמדו</p>
    ${qHtml}
  </section>
  <section class="card"><h2>🗒 תשובות אחרונות</h2><ul class="items">${history}</ul></section>
  <section class="card"><h2>📚 כל השיעורים</h2><p class="note">סמן מה למדת. "אומת" מופיע רק אחרי תשובה נכונה לג׳ארוויס.</p><ul class="items lessons">${lessonList}</ul></section>

  <section class="card" id="tasks"><h2>🗂 משימות לפי פרויקט</h2>
    <div class="form"><select id="tproj">${T.projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>
      <input id="ttitle" placeholder="משימה חדשה…"><button class="btn" data-act="task-add">הוסף</button></div>
    ${taskGroups}</section>

  <section class="card" id="income"><h2>💰 הכנסות · החודש ${ils(byMonth[month] || 0)}</h2>
    <div class="form"><input id="iclient" placeholder="לקוח / עבודה"><input id="iamount" type="number" min="0" placeholder="סכום ₪"><input id="idate" type="date" value="${todayISO()}"><input id="inote" placeholder="הערה (לא חובה)"><button class="btn" data-act="income-add">הוסף</button></div>
    <ul class="items">${incRows}</ul><div class="chips">${months}</div></section>

  <section class="card" id="english"><h2>🇬🇧 אנגלית · ${known}/${E.words.length} מילים ידועות</h2>
    <p class="note">מילה נחשבת ידועה אחרי שלוש תשובות נכונות בבחינת הבוקר, או כשאתה מסמן אותה.</p><ul class="items">${words}</ul></section>
<script>${TRACK_JS}</script>` })
}

const TRACK_CSS = `
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}.tabs a{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 14px;color:var(--head);text-decoration:none;font-weight:600}
.bar{height:10px;background:var(--line);border-radius:99px;overflow:hidden;margin:4px 0 6px}.bar div{height:100%;background:linear-gradient(90deg,var(--blue),var(--brown))}
.qbox{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:10px}
.qhead{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-weight:600;color:var(--muted);font-size:.9rem}
.mood{font-size:1rem;color:var(--ink)}.qtext{font-weight:600;margin:8px 0;white-space:pre-wrap}.qtext.sm{font-size:.95rem;margin:4px 0}
.ans{background:var(--card);border-right:3px solid var(--blue);padding:8px 10px;border-radius:0 8px 8px 0;white-space:pre-wrap}.ans.sm{font-size:.9rem}
.fb{background:var(--soft);border-right:3px solid var(--brown);padding:8px 10px;border-radius:0 8px 8px 0;margin-top:6px;font-size:.92rem;white-space:pre-wrap}
textarea,input,select{width:100%;font:inherit;border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--card);color:var(--ink)}
.btn{margin-top:8px;border:0;background:var(--blue);color:#fff;border-radius:10px;padding:9px 18px;font:inherit;font-weight:700;cursor:pointer}.btn:hover{background:var(--deep)}
.form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-bottom:10px}.form>*{flex:1 1 140px;margin-top:0}.form .btn{flex:0 0 auto}
.chk{display:flex;gap:8px;align-items:flex-start;flex:1;cursor:pointer}.chk input{width:auto;margin-top:6px;accent-color:var(--blue)}.chk.done{color:var(--muted);text-decoration:line-through}
.items li{align-items:center}.ln{color:var(--muted);font-weight:700}.curl{background:var(--chip);border-radius:8px}
.tag{font-size:.78rem;font-weight:700;border-radius:7px;padding:1px 8px;background:var(--chip);white-space:nowrap}.tag.ok{color:#2d7a3e}.tag.cur{color:var(--blue)}.tag.lock{background:none}
.hist-q{flex-direction:column;align-items:stretch!important;gap:4px}
.proj h3{font-size:1rem;color:var(--deep);margin:12px 0 2px}.sm{font-size:.85rem}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.chip{background:var(--chip);border-radius:8px;padding:3px 9px;font-size:.85rem}
.items li strong{white-space:nowrap}
`
const TRACK_JS = `
function post(p,ok){return fetch('/api/track',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}).then(function(r){return r.json()}).then(function(j){if(!j.ok){toast(j.error||'שגיאה');return false}toast(ok);return true}).catch(function(){toast('שגיאת רשת');return false})}
function v(id){return document.getElementById(id).value}
document.addEventListener('change',function(e){var c=e.target;if(c.type!=='checkbox')return;var a=c.dataset.act;
  var p={action:a,on:c.checked,n:c.dataset.n,id:c.dataset.id};
  post(p,c.checked?'נשמר ✓':'בוטל').then(function(ok){if(!ok){c.checked=!c.checked;return}var l=c.closest('.chk');if(l&&a!=='learned')l.classList.toggle('done',c.checked)})})
document.addEventListener('click',function(e){var b=e.target.closest('.btn');if(!b)return;var a=b.dataset.act,p={action:a},msg='נשמר ✓';
  if(a==='answer'){p.text=v('ans');msg='התשובה נשלחה לג׳ארוויס ✓'}
  if(a==='task-add'){p.project=v('tproj');p.title=v('ttitle');msg='המשימה נוספה ✓'}
  if(a==='income-add'){p.client=v('iclient');p.amount=v('iamount');p.date=v('idate');p.note=v('inote');msg='ההכנסה נרשמה ✓'}
  b.disabled=true;post(p,msg).then(function(ok){b.disabled=false;if(ok)setTimeout(function(){location.reload()},700)})})
`

// ─── English: ASD-STE100 course (/english) ────────────────────────────────────
// Same gate as tracker.py: a unit advances only when its exercise was graded correct by
// Jarvis AND >= 80% of its words were answered right at least twice.
const EN_MASTERY = 0.8
const POS_HE = { v: 'פועל', n: 'שם עצם', adj: 'שם תואר', adv: 'תואר הפועל', prep: 'מילת יחס', conj: 'מילת חיבור', pron: 'כינוי', art: 'תווית' }
const enMastered = (w) => w.known || (w.correct || 0) >= 2
function enUnitMastery(E, u) {
  const ids = new Set(u.word_ids || [])
  if (!ids.size) return 1
  return E.words.filter((w) => ids.has(w.id) && enMastered(w)).length / ids.size
}
function enMaybeAdvance(E) {
  const u = E.units[E.current_unit - 1]
  if (!u) return false
  const passed = E.exercises.some((x) => x.unit === u.n && x.grade === 'correct')
  if (passed && enUnitMastery(E, u) >= EN_MASTERY && E.current_unit < E.units.length) { E.current_unit++; return true }
  return false
}
function englishAction(a) {
  const E = tload('english')
  if (a.action === 'word-result') {
    const w = E.words.find((x) => x.id === +a.id); if (!w) throw new Error('לא נמצא')
    w.quizzed = (w.quizzed || 0) + 1
    if (a.correct) { w.correct = (w.correct || 0) + 1; if (w.correct >= 3) w.known = true }
    const adv = enMaybeAdvance(E); tsave('english', E); return { advanced: adv, correct: w.correct || 0, quizzed: w.quizzed }
  }
  if (a.action === 'en-answer') {
    const x = [...E.exercises].reverse().find((e) => !e.grade); if (!x) throw new Error('אין תרגיל פתוח')
    if (!String(a.text || '').trim()) throw new Error('תשובה ריקה')
    Object.assign(x, { answer: String(a.text).trim(), answered_at: new Date().toISOString().slice(0, 16), via: 'web' })
    tsave('english', E); return {}
  }
  throw new Error('פעולה לא מוכרת')
}

function renderEnglish() {
  const E = tload('english')
  if (!E.units || !E.units.length) return page({ title: 'אנגלית', active: 'english', main: '<h1>🇬🇧 אנגלית</h1><p class="note">הקורס עוד לא נבנה.</p>' })
  const u = E.units[E.current_unit - 1], ids = new Set(u.word_ids || [])
  const unitWords = E.words.filter((w) => ids.has(w.id))
  const mastered = E.words.filter(enMastered).length
  const m = Math.round(enUnitMastery(E, u) * 100)
  const ex = [...E.exercises].reverse().find((x) => !x.grade)
  const passed = E.exercises.some((x) => x.unit === u.n && x.grade === 'correct')
  const KIND = { words: '🧠 מילים', review: '⚡ חזרה מהירה', rule: '📏 כלל כתיבה' }

  let exHtml
  if (ex && ex.answer) exHtml = `<div class="qbox"><div class="qtext">${esc(ex.prompt)}</div><div class="ans" dir="ltr">${esc(ex.answer)}</div><p class="note">⏳ ממתין לבדיקה של ג׳ארוויס, המשוב יגיע לטלגרם.</p></div>`
  else if (ex) {
    const days = workdaysSince(ex.asked_at), mood = MOODS[Math.min(days, MOODS.length - 1)]
    exHtml = `<div class="qbox"><div class="qhead"><span>תרגיל · יחידה ${ex.unit}</span><span class="mood">${mood} ${days ? days + ' ימי עבודה בלי תשובה' : 'נשאל היום'}</span></div>
      <div class="qtext">${esc(ex.prompt)}</div><textarea id="enans" rows="4" dir="ltr" placeholder="Write your answer in STE…"></textarea>
      <button class="btn" data-en="answer">שלח תשובה</button></div>`
  } else exHtml = passed ? '<p class="note">✅ התרגיל של היחידה עבר. נשאר להגיע ל־80% בכרטיסיות.</p>' : '<p class="note">ג׳ארוויס ישלח תרגיל משפט ליחידה הזו בתדריך הבוקר.</p>'

  const cards = unitWords.map((w) => `<div class="fc" data-id="${w.id}">
      <div class="front" dir="ltr"><span class="w">${esc(w.en)}</span><span class="pos">${esc(POS_HE[w.pos] || w.pos)}</span></div>
      <div class="back"><div class="he">${esc(w.he)}</div><div class="mean" dir="ltr">${esc(w.meaning)}</div>
        <div class="exm" dir="ltr">${esc(w.example)}</div><div class="exh">${esc(w.example_he || '')}</div>
        ${w.note ? `<div class="trap" dir="ltr">⚠️ ${esc(w.note)}</div>` : ''}</div>
      <div class="fcbar"><button data-res="0">✗ לא ידעתי</button><span class="cnt">${w.correct || 0}/${w.quizzed || 0}</span><button data-res="1">✓ ידעתי</button></div>
    </div>`).join('')

  const unitList = E.units.map((x) => {
    const st = x.n < E.current_unit ? '✅' : x.n === E.current_unit ? '➤' : '🔒'
    return `<li class="${x.n === E.current_unit ? 'curl' : ''}"><span>${st} <span class="ln">${x.n}.</span> ${KIND[x.kind] || ''} · ${esc(x.title)}</span>${x.word_ids ? `<span class="note sm">${x.word_ids.length} מילים</span>` : ''}</li>`
  }).join('')

  const dict = E.words.map((w) => ({ id: w.id, en: w.en, he: w.he, pos: w.pos }))
  const main = `<style>${TRACK_CSS}${EN_CSS}</style>
  <h1>🇬🇧 אנגלית טכנית מפושטת (STE)</h1>
  <p class="note">התקן ASD-STE100: כ־900 מילים מאושרות, לכל מילה משמעות אחת. ההמלצה של קרפתי לכתיבה שקל להבין.</p>
  <nav class="tabs"><a href="#unit">היחידה שלי</a><a href="#quiz">מבחן</a><a href="#units">כל היחידות</a><a href="#dict">מילון</a></nav>
  <section class="card" id="unit">
    <h2>יחידה ${u.n}/${E.units.length} · ${KIND[u.kind] || ''} · ${esc(u.title)}</h2>
    <div class="bar"><div style="width:${Math.round(mastered / E.words.length * 100)}%"></div></div>
    <p class="note">${mastered}/${E.words.length} מילים נשלטות בכל הקורס${u.word_ids ? ` · ביחידה: <strong id="um">${m}%</strong> (נדרש 80%)` : ''}</p>
    ${u.kind === 'rule' ? `<p>ג׳ארוויס מלמד את הכלל הזה מתוך התקן (עמודים ${esc(u.pages)}) ושולח תרגיל כתיבה.</p>` : ''}
    ${exHtml}
  </section>
  ${cards ? `<section class="card"><h2>🃏 כרטיסיות</h2><p class="note">לחץ על כרטיס כדי להפוך אותו. מילה נחשבת נשלטת אחרי שתי תשובות נכונות.</p><div class="fcs">${cards}</div></section>
  <section class="card" id="quiz"><h2>🎯 מבחן</h2><div class="form"><button class="btn" data-quiz="en">אנגלית ← עברית</button><button class="btn" data-quiz="he">עברית ← אנגלית</button></div><div id="qz"></div></section>` : ''}
  <section class="card" id="units"><h2>📚 כל היחידות</h2><ul class="items">${unitList}</ul></section>
  <section class="card" id="dict"><h2>📖 מילון (${E.words.length})</h2><input id="dq" placeholder="חפש מילה באנגלית או בעברית…"><ul class="items" id="dl"></ul></section>
  <script>var UNIT=${JSON.stringify(unitWords.map((w) => ({ id: w.id, en: w.en, he: w.he })))};var DICT=${JSON.stringify(dict)};</script>
  <script>${EN_JS}</script>`
  return page({ title: 'אנגלית STE', active: 'english', main })
}

const EN_CSS = `
.fcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:12px}
@media(max-width:760px){.wrap{grid-template-columns:minmax(0,1fr)!important}}
.fc{border:1px solid var(--line);border-radius:14px;background:var(--soft);padding:12px;cursor:pointer;display:flex;flex-direction:column;gap:8px;min-height:150px}
.fc .front{display:flex;justify-content:space-between;align-items:baseline}.fc .w{font-size:1.25rem;font-weight:800;color:var(--head)}.fc .pos{color:var(--muted);font-size:.85rem}
.fc .back{display:none;font-size:.92rem}.fc.open .back{display:block}.he{font-weight:700;font-size:1.05rem}
.mean{color:var(--muted)}.exm{margin-top:6px;font-style:italic}.exh{color:var(--muted);font-size:.85rem}.trap{margin-top:6px;background:var(--chip);border-radius:8px;padding:4px 8px;font-size:.82rem}
.fcbar{display:flex;justify-content:space-between;align-items:center;margin-top:auto}.fcbar button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 10px;font:inherit;font-size:.82rem;cursor:pointer}
.fcbar button[data-res="1"]{border-color:#2d7a3e;color:#2d7a3e}.fcbar button[data-res="0"]{border-color:#b3452f;color:#b3452f}
.qq{font-size:1.4rem;font-weight:800;margin:10px 0}.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.opts button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px;font:inherit;cursor:pointer}
.opts button.ok{background:#2d7a3e;color:#fff}.opts button.no{background:#b3452f;color:#fff}
`
const EN_JS = `
function enpost(p){return fetch('/api/english',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}).then(function(r){return r.json()})}
function wr(id,ok){return enpost({action:'word-result',id:id,correct:ok}).then(function(j){if(!j.ok){toast(j.error||'שגיאה');return j}if(j.advanced){toast('🎉 עברת ליחידה הבאה!');setTimeout(function(){location.reload()},1200)}return j})}
document.addEventListener('click',function(e){
  var r=e.target.closest('[data-res]');if(r){e.stopPropagation();var c=r.closest('.fc');var ok=r.dataset.res==='1';
    wr(+c.dataset.id,ok).then(function(j){if(j.ok){c.querySelector('.cnt').textContent=j.correct+'/'+j.quizzed;toast(ok?'✓ נרשם':'נרשם, ננסה שוב');c.classList.remove('open')}});return}
  var f=e.target.closest('.fc');if(f){f.classList.toggle('open');return}
  var b=e.target.closest('[data-en]');if(b){b.disabled=true;enpost({action:'en-answer',text:document.getElementById('enans').value}).then(function(j){b.disabled=false;if(!j.ok){toast(j.error);return}toast('התשובה נשלחה לג׳ארוויס ✓');setTimeout(function(){location.reload()},800)});return}
  var q=e.target.closest('[data-quiz]');if(q){quiz(q.dataset.quiz);return}
})
function shuffle(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=a[i];a[i]=a[j];a[j]=t}return a}
function quiz(dir){var list=shuffle(UNIT.slice()),i=0,score=0,box=document.getElementById('qz');
  function next(){if(i>=list.length){box.innerHTML='<p class="qq">'+score+'/'+list.length+'</p><p class="note">התוצאות נרשמו לכל מילה.</p>';return}
    var w=list[i],key=dir==='en'?'he':'en',pool=shuffle(DICT.filter(function(d){return d.id!==w.id&&d[key]})).slice(0,3);
    var opts=shuffle(pool.concat([w]));
    box.innerHTML='<p class="note">'+(i+1)+'/'+list.length+'</p><div class="qq" dir="'+(dir==='en'?'ltr':'rtl')+'">'+(dir==='en'?w.en:w.he)+'</div><div class="opts"></div>';
    var o=box.querySelector('.opts');opts.forEach(function(x){var bt=document.createElement('button');bt.textContent=x[key];bt.dir=dir==='en'?'rtl':'ltr';
      bt.onclick=function(){var ok=x.id===w.id;bt.className=ok?'ok':'no';if(!ok){[].forEach.call(o.children,function(c,k){if(opts[k].id===w.id)c.className='ok'})}
        if(ok)score++;wr(w.id,ok);i++;setTimeout(next,ok?500:1300)};o.appendChild(bt)})}
  next()}
var dq=document.getElementById('dq'),dl=document.getElementById('dl');
function draw(s){s=(s||'').trim().toLowerCase();var r=DICT.filter(function(d){return !s||d.en.toLowerCase().indexOf(s)>=0||(d.he||'').indexOf(s)>=0}).slice(0,60);
  dl.innerHTML=r.map(function(d){return '<li><span class="txt"><strong dir="ltr">'+d.en+'</strong> <span class="note">('+d.pos+')</span> — '+(d.he||'')+'</span></li>'}).join('')}
if(dq){dq.oninput=function(){draw(dq.value)};draw('')}
`

// ─── Features board (/features) ───────────────────────────────────────────────
// Reads tracker/features.json (written by tracker.py and feature-run.sh) and
// tracker/resources.jsonl (resource-collect.py). The only write here is approving or
// rejecting a gate. Stages themselves are moved by feature-driver.py on the host.
const STAGES = ['קליטה', 'אפיון', 'מסר ושיווק', 'עיצוב', 'תכנון טכני', 'מודל איומים', 'תוכנית בדיקות', 'פיתוח', 'אימות', 'השקה', 'סיכום']
const GATE_AT = { client: 3, build: 7, release: 9 }
const GATE_NAME = { client: 'אישור לקוח', build: 'אישור פיתוח', release: 'אישור העלאה' }
const PROJ = { tafasti: 'תפסתי', feasibility: 'בדיקות כדאיות', 'new-client': 'לקוח חדש', personal: 'אישי', 'shared-db': 'מסד נתונים משותף', agents: 'פלטפורמת הסוכנים' }
const AGENT_HE = { main: 'ג׳ארוויס', vision: 'ויז׳ן', hawkeye: 'הוקאיי', shield: 'שילד', editor: 'העורך', phoenix: 'פניקס', social: 'סושיאל' }
const SHORT_PATH = [0, 1, 4, 7, 8, 10]
const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n)
const runTokens = (r) => (r.input || 0) + (r.output || 0) + (r.cache_write || 0)

function loadResources() {
  try {
    return fs.readFileSync(path.join(TRACK_DIR, 'resources.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}
function spark(vals, w = 220, h = 36) {
  if (vals.length < 2) return ''
  const max = Math.max(...vals, 0.0001)
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - v / max * (h - 2) - 1).toFixed(1)}`).join(' ')
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.6" points="${pts}"/></svg>`
}
function pendingGate(f) {
  const pathS = f.track === 'short' ? SHORT_PATH : STAGES.map((_, i) => i)
  const nxt = pathS.find((x) => x > f.stage)
  if (nxt === undefined) return null
  return Object.keys(GATE_AT).find((g) => f.stage < GATE_AT[g] && GATE_AT[g] <= nxt && !['approved', 'skipped'].includes(f.gates[g].status)) || null
}

function featuresAction(a) {
  const F = tload('features')
  const f = (F.features || []).find((x) => x.id === a.id); if (!f) throw new Error('פיצ׳ר לא נמצא')
  if (a.action !== 'gate' || !GATE_AT[a.gate] || !['approved', 'rejected'].includes(a.status)) throw new Error('פעולה לא מוכרת')
  if (pendingGate(f) !== a.gate) throw new Error('הפיצ׳ר לא ממתין לשער הזה')
  f.gates[a.gate] = { status: a.status, date: todayISO(), note: 'מהלוח' }
  tsave('features', F)
}

function renderFeatures() {
  const F = tload('features'), feats = F.features || []
  let driver = {}
  try { driver = JSON.parse(fs.readFileSync(path.join(TRACK_DIR, '.driver-state.json'), 'utf8')) } catch {}
  const R = loadResources(), now = Math.floor(Date.now() / 1000)
  const day = R.filter((s) => s.ts >= now - 86400), last = R[R.length - 1]
  const week = now - 7 * 86400

  const projKeys = ['tafasti', 'feasibility', 'new-client', 'personal'].filter((p) => feats.some((f) => f.project === p) || (last && last.projects[p]))
  const resCards = ['tafasti', 'feasibility', 'agents', 'shared-db'].filter((p) => last && last.projects[p]).map((p) => {
    const cur = last.projects[p], cpu = day.map((s) => (s.projects[p] || {}).cpu || 0), mem = day.map((s) => (s.projects[p] || {}).mem_mib || 0)
    const peak = Math.max(...cpu, 0), avg = cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0
    const tok = feats.filter((f) => f.project === p).flatMap((f) => f.runs).filter((r) => r.at >= new Date(week * 1000).toISOString().slice(0, 16)).reduce((a, r) => a + runTokens(r), 0)
    return `<div class="res"><h3>${esc(PROJ[p] || p)}</h3>
      <div class="kv"><span>מעבד עכשיו</span><strong>${cur.cpu.toFixed(1)}%</strong></div>
      <div class="kv"><span>ממוצע / שיא</span><strong>${avg.toFixed(1)}% / ${peak.toFixed(1)}%</strong></div>
      <div class="sp cpu">${spark(cpu)}</div>
      <div class="kv"><span>זיכרון</span><strong>${Math.round(cur.mem_mib)} MB</strong></div>
      <div class="sp mem">${spark(mem)}</div>
      <div class="kv"><span>${p === 'agents' ? 'תהליכים' : 'קונטיינרים'}</span><strong>${cur.containers}</strong></div>
      ${PROJ[p] && !['agents', 'shared-db'].includes(p) ? `<div class="kv"><span>אסימונים של סוכנים (7 ימים)</span><strong>${fmtK(tok)}</strong></div>` : ''}
    </div>`
  }).join('')

  const featCards = feats.slice().reverse().map((f) => {
    const pathS = f.track === 'short' ? SHORT_PATH : STAGES.map((_, i) => i)
    const steps = pathS.map((i) => {
      const gate = Object.keys(GATE_AT).find((g) => GATE_AT[g] === i && f.gates[g].status !== 'skipped')
      const gateHtml = gate ? `<span class="gt ${f.gates[gate].status}" title="${GATE_NAME[gate]}">🚦</span>` : ''
      return `${gateHtml}<span class="st ${i < f.stage || f.done ? 'ok' : i === f.stage ? 'cur' : ''}" title="${esc(STAGES[i])}">${esc(STAGES[i])}</span>`
    }).join('')
    // show a gate only once the driver announced it (the stage before it is finished)
    const pg = f.done ? null : pendingGate(f)
    const announced = pg && ((driver[f.id] || {}).notified || []).includes(pg)
    const byStage = {}
    for (const r of f.runs) {
      const k = r.stage + '|' + r.agent; byStage[k] ||= { stage: r.stage, agent: r.agent, n: 0, tok: 0, ms: 0, fail: 0 }
      const b = byStage[k]; b.n++; b.tok += runTokens(r); b.ms += r.ms || 0; if (r.ok === false) b.fail++
    }
    const rows = Object.values(byStage).sort((a, b) => a.stage - b.stage).map((b) =>
      `<tr><td>${esc(STAGES[b.stage])}</td><td>${esc(AGENT_HE[b.agent] || b.agent)}</td><td>${b.n}${b.fail ? ` <span class="bad">(${b.fail} נכשלו)</span>` : ''}</td><td>${fmtK(b.tok)}</td><td>${Math.round(b.ms / 60000)} דק׳</td></tr>`).join('')
    const total = f.runs.reduce((a, r) => a + runTokens(r), 0)
    return `<section class="card feat">
      <div class="fh"><h2>${esc(f.id)} · ${esc(f.title)}</h2><span class="tag">${esc(PROJ[f.project] || f.project)} · ${f.track === 'short' ? 'מסלול קצר' : 'מסלול מלא'} · ${f.intake === 'B' ? 'חומר מהלקוח' : 'דרישה ממך'}</span></div>
      <div class="steps">${steps}</div>
      ${f.done ? '<p class="note">✅ הושלם</p>' : announced ? `<div class="gatebox">🚦 ממתין: <strong>${GATE_NAME[pg]}</strong>
        <button class="btn" data-gate="${pg}" data-id="${esc(f.id)}" data-status="approved">מאשר</button>
        <button class="btn ghost" data-gate="${pg}" data-id="${esc(f.id)}" data-status="rejected">לא מאשר</button></div>`
        : `<p class="note">עכשיו: <strong>${esc(STAGES[f.stage])}</strong></p>`}
      <details><summary>משאבים: ${f.runs.length} הרצות · ${fmtK(total)} אסימונים</summary>
        ${rows ? `<table class="rt"><tr><th>שלב</th><th>סוכן</th><th>הרצות</th><th>אסימונים</th><th>זמן</th></tr>${rows}</table>` : '<p class="note">עוד אין הרצות.</p>'}</details>
      <a class="src" href="/features/${encodeURIComponent(f.id)}">📄 תיק הפיצ׳ר המלא</a>
    </section>`
  }).join('') || '<section class="card"><p class="empty">אין עדיין פיצ׳רים. כתוב לג׳ארוויס "פיצ׳ר חדש לתפסתי: …" והצוות יתחיל.</p></section>'

  const main = `<style>${TRACK_CSS}${FEAT_CSS}</style>
  <h1>🏗️ פיצ׳רים ומשאבים</h1>
  <p class="note">כל פיצ׳ר עובר אפיון, מסר, עיצוב, תכנון, אבטחה, בדיקות, פיתוח, אימות והשקה. 🚦 = החלטה שלך או של הלקוח.</p>
  ${featCards}
  <section class="card"><h2>📊 משאבים לפי פרויקט · 24 שעות</h2><div class="resgrid">${resCards || '<p class="note">אין עדיין מדידות.</p>'}</div>
    <p class="note sm">נמדד כל 5 דקות. אסימונים = קלט + פלט + כתיבה למטמון, בלי קריאה מהמטמון.</p></section>
  <script>${FEAT_JS}</script>`
  return page({ title: 'פיצ׳רים ומשאבים', active: 'features', main })
}

function renderDossier(id) {
  const f = (tload('features').features || []).find((x) => x.id === id)
  if (!f) return null
  let md = ''
  try { md = fs.readFileSync(f.dossier.replace(/^.*\/\.openclaw\/workspace\//, WS + '/'), 'utf8') } catch { md = '(התיק לא נגיש מהאתר)' }
  const html = md.split('\n').map((l) => {
    if (/^# /.test(l)) return `<h1>${inline(l.slice(2))}</h1>`
    if (/^## /.test(l)) return `<h2>${inline(l.slice(3))}</h2>`
    if (/^### /.test(l)) return `<h3>${inline(l.slice(4))}</h3>`
    if (/^\s*[-*] /.test(l)) return `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`
    if (/^\|/.test(l)) return `<div class="mdrow" dir="auto">${esc(l)}</div>`
    return l.trim() ? `<p dir="auto">${inline(l)}</p>` : ''
  }).join('\n')
  return page({ title: f.id, active: 'features', main: `<style>${TRACK_CSS}${FEAT_CSS}</style><a class="back" href="/features">→ לוח הפיצ׳רים</a><section class="card dossier">${html}</section>` })
}

const FEAT_CSS = `
.fh{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline}
.steps{display:flex;flex-wrap:wrap;gap:4px;margin:10px 0}.st{font-size:.78rem;border-radius:7px;padding:2px 8px;background:var(--chip);color:var(--muted)}
.st.ok{background:#2d7a3e;color:#fff}.st.cur{background:var(--blue);color:#fff;font-weight:700}
.gt{font-size:.85rem;opacity:.45}.gt.approved{opacity:1}.gt.pending{opacity:1;filter:saturate(2)}.gt.rejected{filter:grayscale(1)}
.gatebox{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.gatebox .btn{margin-top:0}.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
details{margin-top:10px}summary{cursor:pointer;color:var(--muted);font-weight:600}
.rt{width:100%;border-collapse:collapse;margin-top:6px;font-size:.88rem}.rt td,.rt th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:right}.bad{color:#b3452f}
.resgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(230px,100%),1fr));gap:12px}
.res{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--soft)}.res h3{margin:0 0 6px;font-size:1rem;color:var(--head)}
.kv{display:flex;justify-content:space-between;font-size:.88rem;padding:2px 0}.sp{color:var(--blue);max-width:100%;overflow:hidden}.sp.mem{color:var(--brown)}.spark{max-width:100%;height:auto}
.dossier h1{font-size:1.4rem}.dossier h2{font-size:1.1rem;margin-top:1.2em}.dossier li{margin-inline-start:1.2em}.mdrow{font-family:monospace;font-size:.82rem;white-space:pre-wrap}
@media(max-width:760px){.wrap{grid-template-columns:minmax(0,1fr)!important}}
`
const FEAT_JS = `
document.addEventListener('click',function(e){var b=e.target.closest('[data-gate]');if(!b)return;
  if(b.dataset.status==='rejected'&&!confirm('לעצור את הפיצ׳ר?'))return;b.disabled=true;
  fetch('/api/features',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'gate',id:b.dataset.id,gate:b.dataset.gate,status:b.dataset.status})})
   .then(function(r){return r.json()}).then(function(j){b.disabled=false;if(!j.ok){toast(j.error||'שגיאה');return}
     toast(b.dataset.status==='approved'?'אושר ✓ הצוות ממשיך תוך 10 דקות':'הפיצ׳ר נעצר');setTimeout(function(){location.reload()},900)}).catch(function(){b.disabled=false;toast('שגיאת רשת')})})
`

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

  if (req.method === 'POST' && url.pathname === '/api/track') {
    if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return }
    try {
      trackAction(await body(req))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/english') {
    if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return }
    try {
      const r = englishAction(await body(req))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...r }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/features') {
    if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return }
    try {
      featuresAction(await body(req))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }
  if (url.pathname === '/features') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderFeatures())
    return
  }
  if (url.pathname.startsWith('/features/')) {
    const h = renderDossier(decodeURIComponent(url.pathname.slice(10)))
    if (!h) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(h)
    return
  }
  if (url.pathname === '/english') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderEnglish())
    return
  }
  if (url.pathname === '/track') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderTrack())
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
