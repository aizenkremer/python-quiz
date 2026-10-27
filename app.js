'use strict';
const POLL_MS = 2000;
const CAT = { code: 'Python', fun: 'Python-игра', prog: 'Python без кода', logic: 'Логика', arch: 'Архитектура ЭВМ', math: 'Математика', free: 'Свободный ответ' };
const catLabel = tk => tk.kind === 'code' && tk.cat !== 'fun' ? '⌨️ Код' : tk.cat === 'prog' ? '🧩 ' + tk.sub : tk.cat === 'fun' ? '🎮 ' + tk.sub + (tk.kind === 'code' ? ' ⌨️' : '') : tk.cat === 'free' ? '📝 ' + CAT.free : CAT[tk.cat] || '';
const RATING_HELP = 'Места определяются по рейтингу. Рейтинг = процент баллов за задачи + бонусы на участника (до +15) − штраф на участника. Серия: +1 за каждые 3 решения с первой попытки, максимум +5. Итог не ниже нуля. Время финиша показывается отдельно.';
const rHelp = () => `<span class="rhelp" title="${RATING_HELP}">ⓘ Как считается рейтинг</span>`;
const STATUS = { lobby: 'Сбор команд', election: 'Выборы капитанов', running: 'Решение задач', closed: 'Завершено' };
const TASK = Object.fromEntries(BANK.map(t => [t.id, t]));
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)), del: k => localStorage.removeItem(k) };
// Ответ на действие пользователя (ошибка, «Верно!» и т.п.) — тот же единственный слот сверху, без очереди
function toast(msg, ms = 2500) { showSlot(msg, Math.min(ms, 4000)); }
// ---------- уведомления (v12): один маленький тост сверху, без стопок, без звука ----------
const SS = { get: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
function showSlot(msg, ms = 2500, cls = '', onclick = null) {
  let d = $('#nslot'); if (!d) { d = document.createElement('div'); d.id = 'nslot'; document.body.appendChild(d); }
  d.className = 'show ' + cls + (onclick ? ' click' : ''); d.textContent = msg; d.onclick = onclick ? () => { d.className = ''; onclick(); } : null;
  clearTimeout(showSlot.h); showSlot.h = setTimeout(() => d.className = '', ms);
}
const isTyping = () => { const a = document.activeElement; return !!a && (a.matches('input:not([type=radio]):not([type=checkbox]), textarea, select, [contenteditable]') || !!a.closest('.CodeMirror, .cm-editor')); };
let nQueue = null;
// Прерывающее уведомление. id — для дедупликации (sessionStorage), не показывается повторно после перезагрузки/поллинга
function notify(id, msg, opt = {}) {
  const seen = SS.get('pq_nseen') || []; if (seen.includes(id)) return; seen.push(id); SS.set('pq_nseen', seen.slice(-300));
  if (opt.vibrate && navigator.vibrate) try { navigator.vibrate(120); } catch (e) {}
  if (isTyping()) { nQueue = { msg, opt, at: Date.now() }; return; }
  showSlot(msg, 2500, opt.cls || '', opt.onclick || null);
}
document.addEventListener('focusout', () => setTimeout(() => { if (!nQueue || isTyping()) return; const q = nQueue; nQueue = null; if (Date.now() - q.at <= 30000) showSlot(q.msg, 2500, q.opt.cls || '', q.opt.onclick || null); }, 150));
// Тихие события: запись в «Ленту» + счётчик на вкладке
function feed(id, txt, tab = 'teams') {
  const k = 'pq_feed_' + ((S && S.code) || ''), F = SS.get(k) || [];
  if (F.some(f => f.id === id)) return; F.push({ id, txt, at: Date.now(), tab, read: TAB === tab }); SS.set(k, F.slice(-60)); renderFeed();
}
function renderFeed() {
  const el = $('#feed'); if (!el || !S) return; const F = (SS.get('pq_feed_' + S.code) || []).slice().reverse();
  const h = `<div class="card"><h3>🔔 Лента</h3>${F.length ? F.slice(0, 30).map(f => `<div class="fd ${f.read ? '' : 'unread'}"><span class="muted">${hhmm(f.at)}</span> ${esc(f.txt)}</div>`).join('') : '<div class="muted">Пока событий нет</div>'}</div>`;
  if (el._h !== h) { el.innerHTML = h; el._h = h; }
  tabBadge('teams', F.filter(f => !f.read && f.tab === 'teams').length);
}
function feedRead(tab) { if (!S) return; const k = 'pq_feed_' + S.code, F = SS.get(k) || []; F.forEach(f => { if (f.tab === tab) f.read = true; }); SS.set(k, F); }

// ---------- API ----------
async function api(p, post) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
  let r;
  try {
  if (post) r = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(p), signal: controller.signal }); // text/plain → без preflight
  else r = await fetch(APPS_SCRIPT_URL + '?' + new URLSearchParams(p), { signal: controller.signal });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
  } finally { clearTimeout(timeout); }
}
async function act(p, btn) {
  if (btn) btn.disabled = true;
  try { const r = await api({ ...p, withState: true }, true); if (r.state) applyState(r.state); else pollNow(); return r; }
  catch (e) { toast('⚠ ' + e.message); throw e; }
  finally { if (btn) btn.disabled = false; }
}

// ---------- Python в Web Worker (можно прервать бесконечный цикл) ----------
let worker = null, wReady = false, wSeq = 0, workerReady = null, pyQueue = Promise.resolve();
const wWait = new Map();
function stopWorker(message) {
  if (worker) worker.terminate(); worker = null; wReady = false; workerReady = null;
  for (const done of wWait.values()) done({ out: '', ok: false, msg: message });
  wWait.clear();
}
function newWorker() {
  if (workerReady) return workerReady;
  workerReady = new Promise((resolve, reject) => {
    const w = new Worker('pyworker.js?v=14'); worker = w;
    const timer = setTimeout(() => { reject(new Error('Python не загрузился за 45 секунд. Проверьте интернет и повторите.')); stopWorker('Python не загружен'); }, 45000);
    w.onerror = () => { clearTimeout(timer); reject(new Error('Не удалось загрузить Python. Повторите проверку.')); stopWorker('Ошибка загрузки Python'); };
    w.onmessage = e => {
      if (e.data.ready) { clearTimeout(timer); wReady = true; resolve(); return; }
      if (e.data.error) { clearTimeout(timer); reject(new Error(e.data.error)); stopWorker(e.data.error); return; }
      const done = wWait.get(e.data.id); if (done) { wWait.delete(e.data.id); done(e.data); }
    };
  });
  return workerReady;
}
const caseStrict = tk => /upper|lower|capitalize|title|регистр|заглав|строчн|прописн/i.test((tk.desc || '') + (tk.tests || ''));
function runPy(code, tests, ci = true) {
  const job = async () => {
    try { await newWorker(); } catch(e) { return { out: '', ok: false, msg: e.message, infrastructure: true }; }
    return new Promise(resolve => {
      const id = ++wSeq;
      const timer = setTimeout(() => stopWorker('⏱ Выполнение остановлено через 8 секунд. Проверьте цикл.'), 8000);
      wWait.set(id, data => { clearTimeout(timer); resolve(data); });
      worker.postMessage({ id, code, tests: tests ?? null, ci });
    });
  };
  const result = pyQueue.then(job, job); pyQueue = result.then(() => {}); return result;
}

// ---------- поллинг ----------
let pollTimer = null, polling = null, lastV = 0, S = null, clockOff = 0, lastCv = '', lastEv = -1;
function startPoll(fn) { polling = fn; lastV = 0; lastCv = ''; lastEv = -1; pollNow(); }
function stopPoll() { polling = null; clearTimeout(pollTimer); }
let pollBusy = false;
function applyState(r) {
  if (!r || r.same || (S && S.code === r.code && Number(r.v) < lastV)) return;
  lastV = r.v; lastCv = r.cv || ''; clockOff = r.now - Date.now(); S = r;
  const ev = r.events || []; if (lastEv >= 0) onEvents(ev);
  lastEv = ev.length ? Math.max(lastEv, ...ev.map(e => e.id)) : Math.max(lastEv, 0); render();
}
async function pollNow() {
  clearTimeout(pollTimer); if (!polling) return;
  if (pollBusy) { pollTimer = setTimeout(pollNow, POLL_MS); return; } pollBusy = true;
  const fn = polling;
  try {
    const r = await fn(lastV);
    $('#net').textContent = '🟢 онлайн';
    if (polling === fn) applyState(r);
  } catch (e) {
    $('#net').textContent = '🔴 нет связи';
    if (/удалил вас/.test(e.message)) { kickedScreen(e.message); $('#net').textContent = ''; return; }
    if (/не найден|доступа/.test(e.message)) { toast(e.message); store.del('pq_student'); store.del('pq_teacher'); stopPoll(); return home(); }
  }
  finally { pollBusy = false; }
  if (polling === fn) pollTimer = setTimeout(pollNow, document.hidden ? POLL_MS * 3 : POLL_MS);
}
let render = () => {};
setInterval(() => { document.querySelectorAll('[data-deadline]').forEach(el => { const s = Math.max(0, Math.ceil((+el.dataset.deadline - Date.now() - clockOff) / 1000)); el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }); }, 500);

function kickedScreen(msg) {
  const s = store.get('pq_student'); if (s) { const m = store.get('pq_mids') || {}; delete m[s.code]; store.set('pq_mids', m); }
  store.del('pq_student'); stopPoll(); render = () => {}; if (typeof closeExtras === 'function') closeExtras(); document.body.classList.remove('student');
  wizard('who'); toast(msg || 'Преподаватель удалил вас из комнаты — можно зайти заново', 7000);
}
// ---------- главная ----------
function home() {
  stopPoll(); render = () => {}; clearRoomUI14();
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes('PASTE')) { $('#app').innerHTML = '<div class="card err">Не настроен APPS_SCRIPT_URL в config.js</div>'; return; }
  if (location.hash === '#teacher') return teacherHome();
  const saved = store.get('pq_student');
  if (saved) return studentStart(saved);
  wizard('who');
}
// ---------- мастер входа студента ----------
const teamCode = (code, tid) => code + '-' + String(tid).replace(/^t/, '');
function parseTeamCode(v) { const m = String(v).toUpperCase().replace(/\s/g, '').match(/^([A-Z2-9]{6})-?(\d+)$/); return m ? { code: m[1], tid: 't' + m[2] } : null; }
async function joinRoom(code, btn) {
  const L = store.get('pq_last'), mids = store.get('pq_mids') || {};
  const r = await act({ a: 'join', code, fio: L.fio, group: L.group, mid: mids[code] }, btn);
  mids[code] = r.mid; store.set('pq_mids', mids);
  return { code, mid: r.mid, fio: L.fio, group: L.group };
}
function wizard(step) {
  stopPoll(); render = () => {}; clearRoomUI14(); document.body.classList.remove('student', 'tv-open'); closeExtras();
  const L = store.get('pq_last') || {}, back = to => `<button class="sec" data-back="${to}">← Назад</button>`;
  const roomInput = `<label>Код комнаты* (скажет преподаватель)<input id="room" maxlength="6" placeholder="ABC123" style="text-transform:uppercase;font-family:monospace;font-size:22px"></label>`;
  const V = {
    who: `<div class="card"><h2>Вход для студента</h2>
      <label>ФИО*<input id="fio" placeholder="Иванов Иван Иванович" value="${esc(L.fio)}"></label>
      <label>Группа*<input id="group" placeholder="ИС-21" value="${esc(L.group)}"></label>
      <button id="next">Далее →</button></div><p class="muted">Преподаватель? <a href="#teacher">Режим преподавателя</a></p>`,
    choice: `<div class="card"><h2>${esc(L.fio)}, что делаем?</h2><div class="choice">
      <button class="bigbtn" id="c-create">➕<br>Создать команду</button><button class="bigbtn" id="c-join">👥<br>Войти в команду</button><button class="bigbtn" id="c-solo">🧑‍💻<br>Играть соло</button></div>
      <p class="muted">Соло: личный набор из 15 задач дня (команды: ~12–13 задач на человека), без выборов капитана.</p>${back('who')}</div>`,
    create: `<div class="card"><h2>Создать команду</h2>${roomInput}<label>Название команды*<input id="tname" maxlength="30" placeholder="Байтики"></label>
      ${back('choice')} <button id="go">Создать</button></div>`,
    solo: `<div class="card"><h2>Играть соло</h2>${roomInput}${back('choice')} <button id="go">Начать</button></div>`,
    join: `<div class="card"><h2>Войти в команду</h2>${roomInput}${back('choice')} <button id="go">Показать команды →</button>
      <hr><p><b>или</b> введите код команды от товарищей (код комнаты тогда не нужен):</p>
      <input id="tcode" placeholder="ABC123-1" style="text-transform:uppercase;font-family:monospace;font-size:20px"> <button id="go2">Вступить</button></div>`
  };
  $('#app').innerHTML = V[step];
  $('#app').querySelectorAll('[data-back]').forEach(b => b.onclick = () => wizard(b.dataset.back));
  const room = () => { const c = $('#room').value.trim().toUpperCase(); if (c.length !== 6) { toast('Код комнаты — 6 символов'); return null; } return c; };
  const enter = s => { store.set('pq_student', s); studentStart(s); };
  if (step === 'who') $('#next').onclick = () => {
    const fio = $('#fio').value.trim(), group = $('#group').value.trim();
    if (!fio || !group) return toast('Заполните ФИО и группу');
    store.set('pq_last', { fio, group }); wizard('choice');
  };
  if (step === 'choice') { $('#c-create').onclick = () => wizard('create'); $('#c-join').onclick = () => wizard('join'); $('#c-solo').onclick = () => wizard('solo'); }
  if (step === 'solo') $('#go').onclick = async e => {
    const code = room(); if (!code) return;
    try { const s = await joinRoom(code, e.target); await act({ a: 'createTeam', code, mid: s.mid, solo: true }, e.target); enter(s); } catch (x) {}
  };
  if (step === 'create') $('#go').onclick = async e => {
    const code = room(), name = $('#tname').value.trim(); if (!code) return; if (!name) return toast('Введите название команды');
    try { const s = await joinRoom(code, e.target); await act({ a: 'createTeam', code, mid: s.mid, name }, e.target); enter(s); } catch (x) {}
  };
  if (step === 'join') {
    $('#go').onclick = async e => { const code = room(); if (!code) return; try { enter(await joinRoom(code, e.target)); } catch (x) {} };
    $('#go2').onclick = async e => {
      const tc = parseTeamCode($('#tcode').value); if (!tc) return toast('Код команды вида ABC123-1');
      let s; try { s = await joinRoom(tc.code, e.target); } catch (x) { return; }
      try { await act({ a: 'joinTeam', code: tc.code, mid: s.mid, tid: tc.tid }, e.target); } catch (x) {}
      enter(s);
    };
  }
}
window.addEventListener('hashchange', home);

// ---------- преподаватель ----------
function teacherHome() {
  const saved = store.get('pq_teacher');
  if (saved) return teacherStart(saved);
  $('#app').innerHTML = `<div class="card"><h2>Режим преподавателя</h2>
    <label>Пароль (если задан в скрипте)<input id="pw" type="password"></label><button id="create">Создать комнату</button>
    <hr><p class="muted">Вернуться в существующую комнату можно только с этого же браузера.</p></div><p><a href="#">← Студент</a></p>`;
  $('#create').onclick = async e => { const r = await act({ a: 'createRoom', pw: $('#pw').value }, e.target); const s = { code: r.code, key: r.key }; store.set('pq_teacher', s); teacherStart(s); };
}
function teacherStart(T) {
  document.body.classList.remove('student');
  render = () => renderTeacher(T);
  startPoll(v => api({ a: 'tstate', code: T.code, key: T.key, v, cv: lastCv, ev: Math.max(lastEv, 0) }));
}
function renderTeacher(T) {
  const s = S, set = st => e => act({ a: 'setStatus', code: T.code, key: T.key, status: st }, e.target);
  const teams = s.teams.slice().sort((a, b) => s.status === 'lobby' ? 0 : (b.rating || 0) - (a.rating || 0)).map(t => {
    const cap = t.members.find(m => m.mid === t.captain);
    return `<div class="team ${t.solo ? 'solo' : ''}"><h3>${t.finished ? '<span class="pill fin">🏁 ' + t.finished.place + ' место</span> ' : ''}${t.solo ? '<span class="pill solo">Соло</span> ' + esc(t.members[0].fio) : esc(t.name) + ` <span class="muted">${teamCode(s.code, t.tid)} · ${t.members.length} чел.</span>`}</h3>
      <div>Капитан: <b>${cap ? '★ ' + esc(cap.fio) : '—'}</b></div>
      <table>${t.members.map(m => `<tr><td>${m.mid === t.captain ? '★ ' : ''}${esc(m.fio)}<br><span class="muted">${esc(m.group)}</span></td><td>${s.status === 'election' ? (m.voted ? '🗳 голос' : '…') : ''}</td><td>${m.solved} ✔ / ${m.pts} б.${m.rating != null ? ' · ' + m.rating + '%' : ''}</td><td><button class="kick" data-kick="${m.mid}" data-fio="${esc(m.fio)}" title="Кикнуть из комнаты">✖</button></td></tr>`).join('')}</table>
      <div class="muted">Назначено: ${t.score.assigned} · решено: ${t.score.solved} · провалено: ${t.score.failed} из ${t.total || s.poolSize}</div>
      <div style="font-size:22px">рейтинг <b>${t.rating}%</b> <span class="muted" style="font-size:14px">· ${t.score.total} б. из ${t.max} · пул ${t.total} · место ${t.rank}</span></div>${tFinish(t)}${tChat(t)}${s.status !== 'closed' ? `<button class="sec red-o wide" data-disband="${t.tid}" data-name="${esc(t.solo ? t.members[0].fio : t.name)}">Расформировать команду</button>` : ''}</div>`;
  }).join('');
  $('#app').innerHTML = `<div class="card"><div class="muted">Код комнаты — покажите студентам:</div><div class="big">${s.code}</div>
    <div style="text-align:center">Статус: <b>${STATUS[s.status]}</b> ${s.status === 'election' ? '· осталось <span class="timer" data-deadline="' + s.deadline + '"></span>' : ''} · задачи дня: ${s.date}<br>
    ${s.status === 'lobby' ? '<button id="b-el">Открыть выборы капитанов</button>' : ''}
    ${s.status === 'election' ? '<button id="b-run">Начать решение задач</button>' : ''}
    ${s.status === 'lobby' ? '<button class="sec" id="b-run">Сразу к задачам</button>' : ''}
    ${s.status === 'running' ? '<button id="b-blitz">⚡ Блиц</button>' : ''}
    ${s.status === 'running' ? '<button class="red" id="b-close">Завершить и записать результаты</button>' : ''}
    ${s.status !== 'lobby' ? '<button class="sec" id="b-exp">Записать результаты в таблицу</button>' : ''}
    <button class="sec" id="b-leave">Выйти из комнаты</button></div></div>
    ${s.loose.length ? `<div class="card"><b>Без команды (${s.loose.length}):</b>${s.loose.map(m => `<div class="loose">${esc(m.fio)} <span class="muted">${esc(m.group)}</span> <button class="kick" data-kick="${m.mid}" data-fio="${esc(m.fio)}">✖ Кикнуть</button></div>`).join('')}</div>` : ''}
    ${(s.kicked || []).length ? `<div class="muted" style="margin:4px 0">Удалены из комнаты: ${s.kicked.map(esc).join(', ')}</div>` : ''}
    <div class="muted" style="margin:4px 0">${rHelp()}</div>${tBlitz(s)}${tFinished(s)}<div class="grid">${teams || '<div class="card">Команд пока нет</div>'}</div>`;
  $('#b-el') && ($('#b-el').onclick = set('election'));
  $('#app').onclick = async e => {
    const kb = e.target.closest('[data-kick]');
    if (kb) { if (await askConfirm('Кикнуть «' + kb.dataset.fio + '» из комнаты?\nЕго открытые задачи вернутся капитану, войти снова с этого устройства он не сможет.')) act({ a: 'kick', code: T.code, key: T.key, mid: kb.dataset.kick }, kb).then(() => toast('Игрок удалён')).catch(() => {}); return; }
    const db = e.target.closest('[data-disband]');
    if (db) { if (await askConfirm('Расформировать команду «' + db.dataset.name + '»?\nУчастники вернутся к выбору команды, их ответы останутся в таблице.')) act({ a: 'disband', code: T.code, key: T.key, tid: db.dataset.disband }, db).then(() => toast('Команда расформирована')).catch(() => {}); return; }
    const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); openHelp(g.dataset.goto, g.dataset.tid); } };
  $('#b-blitz') && ($('#b-blitz').onclick = e => act({ a: 'blitz', code: T.code, key: T.key }, e.target).then(r => toast('⚡ Блиц запущен: ' + ((TASK[r.task] || {}).title || r.task))).catch(() => {}));
  document.querySelectorAll('details[data-chat]').forEach(d => { d.open = !!openChats[d.dataset.chat]; d.ontoggle = () => openChats[d.dataset.chat] = d.open; });
  $('#b-run') && ($('#b-run').onclick = set('running'));
  $('#b-close') && ($('#b-close').onclick = async e => await askConfirm('Завершить игру? Ответы больше не принимаются.') && set('closed')(e));
  $('#b-exp') && ($('#b-exp').onclick = e => act({ a: 'exportRes', code: T.code, key: T.key }, e.target).then(() => toast('Записано в листы Results и TeamResults')));
  $('#b-leave').onclick = async () => { if (await askConfirm('Выйти? Вернуться в комнату будет нельзя (ключ сохраняется только в этом браузере).')) { store.del('pq_teacher'); stopPoll(); home(); } };
}

// ---------- студент ----------
let ME = null, TAB = 'tasks', growSeen = {};
function studentStart(s) {
  newWorker().catch(() => {});
  ME = s; render = renderStudent; taskCards = {}; prevMine = null; TAB = 'tasks';
  $('#app').innerHTML = `<div id="hdr" class="hdr"></div>
    <section class="tab" id="tab-tasks"><div id="main"></div><div id="mylist"></div></section>
    <section class="tab" id="tab-chat" hidden></section>
    <section class="tab" id="tab-teams" hidden><aside id="side"></aside><div id="feed"></div></section>
    <section class="tab" id="tab-achievements" hidden></section><section class="tab" id="tab-me" hidden></section>
    <div id="cardstore" hidden></div>
    <nav id="tabs">${[['tasks', '📋', 'Задачи'], ['chat', '💬', 'Чат'], ['teams', '🏆', 'Команды'], ['achievements', '🏅', 'Награды'], ['me', '👤', 'Моё']].map(([k, i, n]) => `<button data-tab="${k}" class="${k === TAB ? 'on' : ''}"><span class="ti">${i}</span><span>${n}</span><b class="tb" id="tb-${k}" hidden></b></button>`).join('')}</nav>`;
  document.body.classList.add('student');
  $('#tabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  startPoll(v => api({ a: 'state', code: s.code, mid: s.mid, v, cv: lastCv, ev: Math.max(lastEv, 0) }));
}
function setTab(k) {
  TAB = k; closeTask();
  document.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
  ['tasks', 'chat', 'teams', 'achievements', 'me'].forEach(x => { const el = $('#tab-' + x); if (el) el.hidden = x !== k; });
  if (k === 'teams') { feedRead('teams'); renderFeed(); }
  if (k === 'chat') { feedRead('chat'); markRead(); const l = $('#ch-list'); if (l) l.scrollTop = l.scrollHeight; }
  scrollTo(0, 0);
}
function tabBadge(k, n) { const b = $('#tb-' + k); if (!b) return; b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
function renderStudent() {
  const s = S, t = s.team;
  if (!t && s.me.wasIn && s.status !== 'closed') {
    const ak = store.get('pq_disb') || {}, kk = s.code + s.me.wasIn;
    if (!ak[kk]) { ak[kk] = 1; store.set('pq_disb', ak); stopPoll(); closeExtras(); store.del('pq_student'); toast('Преподаватель расформировал вашу команду. Выберите новую или играйте соло.', 6000); return wizard('choice'); }
  }
  if (t && s.pool) { const pk = s.code + t.tid; if (growSeen.k === pk && s.pool.length > growSeen.n) feed('grow:' + pk + ':' + s.pool.length, '📌 В команду добавлено задач: ' + (s.pool.length - growSeen.n) + (t.captain === ME.mid ? ' — распределите их!' : ''), 'teams'); growSeen = { k: pk, n: s.pool.length }; }
  $('#hdr').innerHTML = `<div class="h1"><b>${esc(s.me.fio)}</b> <span class="muted">${esc(s.me.group)} · ${s.code}</span></div>
    <div class="h2">${t ? `${t.solo ? '🧑‍💻 соло' : '👥 ' + esc(t.name)} · <b class="rt">${t.rating || 0}%</b> <span class="muted">${t.pts} б.</span>${t.finished ? ' · 🏁' + t.finished.place : ''}` : esc(STATUS[s.status])}</div>`;
  renderSide(s); renderMe(s); renderUpgrade(s);
  if (t && t.captain && !t.solo) maybeReveal(s);
  renderChat(s); renderBlitz(s); maybeFinale(s); renderFeed();
  const main = $('#main');
  if (s.status !== 'running') { $('#mylist').innerHTML = ''; main._html = null; }
  if (s.status === 'closed') { main.innerHTML = board(s); return; }
  if (!t) return renderTeams(main, s);
  if (t.solo && s.status !== 'running') { main.innerHTML = `<div class="card"><h3>🧑‍💻 Соло-режим</h3>Ваш личный набор: 15 задач. Ждём, когда преподаватель запустит решение задач…</div>`; return; }
  if (s.status === 'lobby') { main.innerHTML = teamCard(s) + `<div class="card">Ждём, когда преподаватель откроет выборы капитана. <button class="sec" id="leave">Покинуть команду</button></div>`; $('#leave').onclick = e => act({ a: 'leaveTeam', code: ME.code, mid: ME.mid }, e.target); return; }
  if (s.status === 'election' && !t.captain) return renderVote(main, s);
  if (s.status === 'election') { main.innerHTML = teamCard(s) + `<div class="card">Капитан выбран! Ждём старта задач…</div>`; return; }
  if (s.status === 'running') renderRunning(main, s);
}
function renderMe(s) {
  const t = s.team, el = $('#tab-me'); if (!el) return;
  const me = t && t.members.find(m => m.mid === ME.mid), A = t && t.achievements && t.achievements[ME.mid];
  const h = `<div class="card"><h3>👤 ${esc(s.me.fio)}</h3><div class="muted">Группа ${esc(s.me.group)} · комната <b>${s.code}</b></div>
    <p>Мои баллы: <b>${s.me.pts}</b>${me && me.bonus ? ` <span class="muted">(в т.ч. бонус ${me.bonus})</span>` : ''}</p>
    ${t ? `<p>${t.solo ? 'Соло' : 'Команда «' + esc(t.name) + '»'}: рейтинг <b>${t.rating || 0}%</b> · ${t.pts} б.${t.rank ? ' · место ' + t.rank : ''}</p>${rHelp()}` : ''}
    ${A ? `<h4>Мои достижения</h4>${A.map(a => `<div class="ach"><b>🏅 ${esc(a.t)}</b><span>${esc(a.d)}</span></div>`).join('')}` : ''}
    ${t && t.finished ? '<button id="b-fin" class="wide">🏆 Финальный экран</button>' : ''}
    <button class="sec wide" id="logout">Выйти из комнаты</button></div>${t && !t.solo ? teamCard(s) : ''}`;
  if (el._h === h) return; el._h = h; el.innerHTML = h;
  $('#b-fin') && ($('#b-fin').onclick = () => showFinale(S));
  $('#logout').onclick = async () => { if (await askConfirm('Выйти из комнаты на этом устройстве?')) { store.del('pq_student'); stopPoll(); closeExtras(); document.body.classList.remove('student'); wizard('choice'); } };
}
function renderSide(s) {
  const total = (s.pool && s.pool.length) || 50, mine = s.team && s.team.tid;
  const rows = s.teams.filter(t => t.members.length).sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.pts || 0) - (a.pts || 0)).map(t => {
    const tot = t.total || total, sv = t.solved || 0, pct = Math.round(100 * sv / tot);
    return `<div class="sd-team ${t.tid === mine ? 'mine' : ''}"><div class="sd-name">${t.tid === mine ? '⭐ ' : ''}${t.solo ? '<span class="pill solo">Соло</span> ' + esc(t.members[0].fio) : esc(t.name) + ` <span class="muted">${t.members.length}/${s.maxTeam}</span>`}</div>
      <div class="bar"><i style="width:${pct}%"></i></div><div class="sd-r"><b>${t.rating || 0}%</b> <span class="muted">· ${sv}/${tot} задач · ${t.pts || 0} б.${t.place ? ' · 🏁' + t.place : ''}</span></div></div>`;
  }).join('');
  const h = `<div class="card"><h3>🏆 Рейтинг команд (${s.teams.filter(t => t.members.length).length})</h3>${rHelp()}${rows || '<div class="muted">Пока нет команд</div>'}</div>`;
  if ($('#side')._h !== h) { $('#side').innerHTML = h; $('#side')._h = h; }
}
function teamCard(s) {
  const t = s.team;
  return `<div class="card"><h3>Команда «${esc(t.name)}» <span class="pill" title="Дайте этот код товарищам">код команды: <b class="tcode">${teamCode(s.code, t.tid)}</b></span></h3>${t.members.map(m => `<div>${m.mid === t.captain ? '★ <b>' : ''}${esc(m.fio)}${m.mid === t.captain ? '</b> (капитан)' : ''} <span class="muted">${esc(m.group)} · ${m.pts} б.</span></div>`).join('')}</div>`;
}
function renderTeams(main, s) {
  main.innerHTML = `<div class="card"><h3>Выберите команду</h3><button class="sec" id="tback">← Назад</button> <span class="muted">Список обновляется автоматически</span></div>
    <div class="grid">${s.teams.map(t => `<div class="team"><h3>${esc(t.name)}</h3>${t.members.map(m => '<div>' + esc(m.fio) + ' · ' + (m.pts || 0) + ' б.</div>').join('')}<p><b>${t.pts || 0} б.</b> · ${t.rating || 0}%</p>
      <div class="muted">Участников: <b>${t.members.length}/${s.maxTeam}</b></div>${t.solo ? '<span class="pill solo">Соло</span>' : `<button data-join="${t.tid}" ${t.members.length >= s.maxTeam ? 'disabled' : ''}>${t.members.length >= s.maxTeam ? 'Заполнена' : 'Вступить'}</button>`}</div>`).join('') || '<div class="card">Команд пока нет. Вернитесь назад и создайте свою!</div>'}</div>`;
  $('#tback').onclick = () => { stopPoll(); store.del('pq_student'); wizard('choice'); };
  main.querySelectorAll('[data-join]').forEach(b => b.onclick = e => act({ a: 'joinTeam', code: ME.code, mid: ME.mid, tid: b.dataset.join }, e.target));
}
function renderVote(main, s) {
  const t = s.team;
  main.innerHTML = `<div class="card"><h3>Выборы капитана команды «${esc(t.name)}»</h3>
    <div>До конца голосования: <span class="timer" data-deadline="${s.deadline}"></span></div>
    <p>Проголосовали: ${t.members.filter(m => m.voted).length} из ${t.members.length}. Можно голосовать за себя. Голос можно изменить до конца выборов.</p>
    ${t.members.map(m => `<button class="${s.me.vote === m.mid ? '' : 'sec'}" data-vote="${m.mid}">${s.me.vote === m.mid ? '✔ ' : ''}${esc(m.fio)}</button>`).join('')}</div>`;
  main.querySelectorAll('[data-vote]').forEach(b => b.onclick = e => act({ a: 'vote', code: ME.code, mid: ME.mid, cand: b.dataset.vote }, e.target));
}

// ---------- анимация выборов ----------
function maybeReveal(s) {
  const t = s.team, k = 'pq_rev_' + s.code + '_' + t.tid;
  if (store.get(k)) return; store.set(k, 1);
  const name = mid => (t.members.find(m => m.mid === mid) || {}).fio || '?';
  const pool = (t.tied && t.tied.length ? t.tied : [t.captain]);
  const cand = t.members.length > 1 ? t.members.map(m => m.mid) : [t.captain];
  const seq = []; for (let i = 0; i < 40; i++) seq.push(cand[i % cand.length]); seq.push(t.captain); for (let i = 0; i < 4; i++) seq.push(cand[i % cand.length]);
  $('#rv-title').textContent = pool.length > 1 ? `Ничья (${pool.length} кандидата)! Крутим рулетку…` : 'Выбираем капитана…';
  $('#rv-strip').innerHTML = seq.map((m, i) => `<div class="rv-card" ${i === 40 ? 'id="rv-win"' : ''}>${esc(name(m))}</div>`).join('');
  $('#rv-tally').innerHTML = ''; $('#rv-close').hidden = true; $('#reveal').hidden = false;
  const strip = $('#rv-strip'), W = 170, win = $('.rv-window').clientWidth;
  strip.style.transition = 'none'; strip.style.transform = 'translateX(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    strip.style.transition = 'transform 5s cubic-bezier(.12,.75,.2,1)';
    strip.style.transform = `translateX(${-(40 * W + W / 2 - win / 2) + (Math.random() * 60 - 30)}px)`;
  }));
  setTimeout(() => {
    $('#rv-win').classList.add('win');
    $('#rv-title').textContent = '★ Капитан: ' + name(t.captain) + ' ★';
    if (t.tally) $('#rv-tally').innerHTML = '<p>' + t.members.map(m => `${esc(m.fio)}: <b>${t.tally[m.mid] || 0}</b>`).join(' · ') + '</p>';
    $('#rv-close').hidden = false;
    if (window.confetti) { confetti({ particleCount: 180, spread: 100, origin: { y: .6 } }); setTimeout(() => confetti({ particleCount: 120, angle: 60, spread: 70, origin: { x: 0 } }), 300); setTimeout(() => confetti({ particleCount: 120, angle: 120, spread: 70, origin: { x: 1 } }), 500); }
  }, 5300);
  $('#rv-close').onclick = () => $('#reveal').hidden = true;
}

// ---------- запрет вставки ----------
const PASTE_MSG = 'Вставка отключена — пишите сами 🙂';
function pc(tid) { const k = 'pq_paste_' + (ME && ME.code) + '_' + tid; const v = store.get(k) || { p: 0, b: 0 }; return { v, save: () => store.set(k, v) }; }
function notePaste(tid) { const c = pc(tid); c.v.p++; c.save(); toast(PASTE_MSG); }
function noteBig(tid) { const c = pc(tid); c.v.b++; c.save(); }
function guardInput(el, tid) {
  const block = e => { e.preventDefault(); e.stopPropagation(); notePaste(tid); };
  el.addEventListener('paste', block); el.addEventListener('drop', block);
  el.addEventListener('dragover', e => e.preventDefault());
  el.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (((e.ctrlKey || e.metaKey) && (k === 'v' || k === 'м')) || (e.shiftKey && e.key === 'Insert')) block(e); });
  el.addEventListener('beforeinput', e => {
    if (/^insertFrom(Paste|Drop|Yank)/.test(e.inputType)) return block(e);
    if (e.data && e.data.length > 30) noteBig(tid);
  });
  let last = el.value.length;
  el.addEventListener('input', () => { if (el.value.length - last > 30) noteBig(tid); last = el.value.length; });
}
function guardCM(cm, tid) {
  cm.setOption('dragDrop', false);
  const keys = cm.getOption('extraKeys') || {};
  ['Ctrl-V', 'Cmd-V', 'Shift-Insert'].forEach(k => keys[k] = () => notePaste(tid));
  cm.setOption('extraKeys', keys);
  cm.on('beforeChange', (_, ch) => {
    if (ch.origin === 'paste' || ch.origin === 'drop') { ch.cancel(); notePaste(tid); return; }
    if (ch.origin !== 'setValue' && ch.text.join('\n').length > 30) noteBig(tid);
  });
  const w = cm.getWrapperElement();
  ['paste', 'drop'].forEach(ev => w.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); if (ev === 'drop') notePaste(tid); }, true));
}
const pasteInfo = tid => { const v = pc(tid).v; return v.p + '/' + v.b; };
const withPasteNote = (src, tid) => { const v = pc(tid).v; return v.p || v.b ? src + `\n# [вставки: ${v.p}, крупные вводы: ${v.b}]` : src; };

// ---------- задачи ----------
let taskCards = {};
const ST = { skipped: 'провалена ✘ · пропуск', assigned: 'в работе', solved: 'решена ✔', failed: 'не решена ✘', review: 'на проверке 📝' };
const CLOSED = x => x && ['solved', 'failed', 'review', 'skipped'].includes(x.st);
function renderRunning(main, s) {
  const t = s.team, isCap = t.captain === ME.mid && !t.solo, name = mid => (t.members.find(m => m.mid === mid) || {}).fio || '—';
  const keep = main.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
  if (!keep) {
    let html = '';
    if (isCap) {
      const rows = s.pool.map(id => {
        const x = t.tasks[id] || {}, tk = TASK[id] || { title: id, cat: '' };
        const sel = !CLOSED(x) ? `<select data-assign="${id}"><option value="">— не назначена —</option>${t.members.map(m => `<option value="${m.mid}" ${x.to === m.mid ? 'selected' : ''}>${esc(m.fio)}</option>`).join('')}</select>` : `<span class="muted">${esc(name(x.to))}</span>`;
        return `<div class="pcard"><div><span class="pill ${tk.cat}">${catLabel(tk)}</span> ${esc(tk.title)} <span class="muted">${tk.pts} б.</span></div><div class="prow">${sel}<span class="st-${x.st || ''}">${x.to || x.st ? ST[x.st] || '' : ''}</span></div></div>`;
      }).join('');
      const na = s.pool.filter(id => !(t.tasks[id] || {}).to).length;
      const isCode = id => (TASK[id] || {}).kind === 'code', nCode = s.pool.filter(isCode).length, per = Math.round(nCode / t.members.length * 10) / 10;
      const load = t.members.map(m => { const my = s.pool.filter(id => (t.tasks[id] || {}).to === m.mid), c = my.filter(isCode).length;
        return `<span class="ld ${c > Math.ceil(nCode / t.members.length) ? 'over' : ''}">${esc(m.fio.split(' ')[0])}: ${my.length} (⌨️ ${c})</span>`; }).join('');
      html = `<details class="card" id="pooldet" ${main._open ? 'open' : ''}><summary><b>★ Распределение задач</b> <span class="muted">пул ${s.pool.length} · не назначено ${na}</span></summary>
        <div class="caphint">⚖️ Честно: задач с кодом ⌨️ — ${nCode}, т.е. ~${per} на человека (≈3–4). Раздайте их поровну, остальные — без кода.</div><div class="loads">${load}</div>${rows}</details>`;
    } else if (!t.solo) html = `<div class="muted cap">Задачи распределяет капитан ★ ${esc(name(t.captain))}</div>`;
    if (main._html !== html) { main.innerHTML = html; main._html = html; const d = $('#pooldet'); if (d) d.ontoggle = () => main._open = d.open; }
    main.querySelectorAll('[data-assign]').forEach(sel => sel.onchange = () => act({ a: 'assign', code: ME.code, mid: ME.mid, task: sel.dataset.assign, to: sel.value }).catch(() => {}));
  }
  const store_ = $('#cardstore'), mine = s.pool.filter(id => (t.tasks[id] || {}).to === ME.mid);
  Object.keys(taskCards).forEach(id => { if (!mine.includes(id)) { if (openTid === id) closeTask(); taskCards[id].el.remove(); delete taskCards[id]; } });
  mine.forEach(id => { if (!taskCards[id]) taskCards[id] = makeCard(TASK[id], store_); updateCard(taskCards[id], t.tasks[id]); });
  notifyAssign(s, mine);
  // список своих задач: открытые сверху, закрытые ниже
  const open = mine.filter(id => !CLOSED(t.tasks[id])), closed = mine.filter(id => CLOSED(t.tasks[id]));
  const cnt = { solved: 0, failed: 0, review: 0, skipped: 0 }; closed.forEach(id => cnt[t.tasks[id].st]++);
  const li = id => { const x = t.tasks[id], tk = TASK[id]; return `<button class="tcard st-b-${x.st === 'skipped' ? 'failed' : x.st}" data-open="${id}"><span class="tc-top"><span class="pill ${tk.cat}">${catLabel(tk)}</span><span class="tc-st st-${x.st === 'skipped' ? 'failed' : x.st}">${taskCards[id].el.querySelector('.newb') ? '<span class="newb">НОВАЯ</span>' : ''}${ST[x.st] || ''}</span></span><span class="tc-t">${esc(tk.title)}</span><span class="muted">${x.st === 'skipped' ? 0 : tk.pts} б.${x.att ? ' · попыток: ' + x.att : ''}</span></button>`; };
  const lh = `<h2 class="lh">Мои задачи <span class="muted">${open.length} открыто · ✅ ${cnt.solved} · ❌ ${cnt.failed + cnt.skipped}${cnt.review ? ' · 📝 ' + cnt.review : ''}</span></h2>
    ${open.map(li).join('') || (closed.length ? '<div class="card muted">Все ваши задачи закрыты 🎉</div>' : `<div class="card muted" id="notasks">${t.solo ? '' : 'Капитан ещё не назначил вам задачи.'}</div>`)}
    ${closed.length ? `<h3 class="lh2">Закрытые</h3>${closed.map(li).join('')}` : ''}`;
  const ml = $('#mylist'); if (ml._h !== lh) { ml.innerHTML = lh; ml._h = lh; ml.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openTask(b.dataset.open)); }
  tabBadge('tasks', document.querySelectorAll('#cardstore .newb, #taskview .newb').length);
  if (openTid && taskCards[openTid]) { renderTaskTools(s); const x = t.tasks[openTid]; $('#tv-st').textContent = ST[x.st] || ''; }
}
let openTid = null;
function openTask(id) {
  const c = taskCards[id]; if (!c) return;
  closeTask(true);
  newWorker().catch(() => {});
  let tv = $('#taskview'); if (!tv) { tv = document.createElement('div'); tv.id = 'taskview'; document.body.appendChild(tv); }
  tv.innerHTML = `<div class="tv-h"><button class="sec" id="tv-back">← Назад</button><b class="tv-t">${esc(c.tk.title)}</b><span id="tv-st" class="muted"></span></div><div id="task-team-live"></div><div id="tv-body"></div><div id="task-actions"></div>`;
  $('#tv-body').appendChild(c.el); tv.hidden = false; openTid = id; document.body.classList.add('tv-open');
  if (c.open) c.open(); const nb = document.querySelector(`[data-open="${id}"] .newb`); if (nb) nb.remove();
  $('#tv-back').onclick = () => closeTask();
  if (c.ed) setTimeout(() => c.ed.refresh(), 30);
  renderUpgrade(S); tv.scrollTop = 0; history.pushState({ tv: 1 }, '');
}
function closeTask(silent) {
  const tv = $('#taskview'); if (!tv || tv.hidden) return;
  const c = openTid && taskCards[openTid]; if (c) $('#cardstore').appendChild(c.el);
  tv.hidden = true; openTid = null; document.body.classList.remove('tv-open');
}
window.addEventListener('popstate', () => { closeTask(); const h = $('#helpmodal'); if (h) h.remove(); });
const KEYROW = [['Tab', '    '], [':', ':'], ['( )', '()', 1], ['[ ]', '[]', 1], ['"', '""', 1], ['=', ' = '], ['#', '# '], ['⏎', '\n']];
function makeCard(tk, box) {
  const el = document.createElement('div'); el.className = 'card task'; el.dataset.tid = tk.id;
  const left = { mc: 1, num: 2, text: 2, order: 2 }[tk.kind];
  el.innerHTML = `<h3><span class="pill ${tk.cat}">${catLabel(tk)}</span> ${esc(tk.title)} <span class="muted">${tk.pts} б.</span></h3><div class="desc">${tk.desc}</div>
    ${tk.kind === 'code' ? `<textarea></textarea><div class="keyrow">${KEYROW.map((k, i) => `<button class="sec" data-k="${i}" tabindex="-1">${k[0]}</button>`).join('')}</div><div class="btnrow"><button class="sec run">▶ Запустить</button><button class="send">✔ Проверить и сдать</button></div><pre class="out"></pre>`
      : tk.kind === 'order' ? `<ol class="order">${tk.options.map((o, i) => `<li data-i="${i}"><button class="sec up">↑</button><button class="sec dn">↓</button><code>${esc(o).replace(/ /g, '&nbsp;')}</code></li>`).join('')}</ol><button class="send wide">Проверить порядок</button> <span class="muted">Попыток: ${left}</span>`
      : tk.kind === 'free' ? `<textarea class="freeans" rows="6" placeholder="Ваш ответ (минимум пару предложений)"></textarea><button class="send wide">Отправить на проверку</button> <span class="muted">Проверит преподаватель, бонус до 3 баллов</span>`
      : tk.kind === 'mc' ? `<div class="mc">${tk.options.map((o, i) => `<label><input type="radio" name="o_${tk.id}" value="${i}"> ${esc(o)}</label>`).join('')}</div><button class="send wide">Ответить</button> <span class="muted">Попыток: ${left}</span>`
      : `<input class="ans" placeholder="Ваш ответ" autocomplete="off" autocapitalize="off" ${tk.kind === 'num' && tk.cat === 'prog' ? 'inputmode="numeric"' : ''}> <button class="send wide">Ответить</button> <span class="muted">Попыток: ${left}</span>`}
    <div class="sub"></div><div class="res"></div>`;
  box.appendChild(el);
  const c = { el, tk }, ak = 'pq_ans_' + ME.code + '_' + tk.id, saveAns = v => store.set(ak, v);
  c.ans = () => store.get(ak);
  if (tk.kind === 'code') {
    c.ed = CodeMirror.fromTextArea(el.querySelector('textarea'), { mode: 'python', lineNumbers: true, indentUnit: 4, lineWrapping: true, inputStyle: 'contenteditable', extraKeys: { Tab: cm => cm.replaceSelection('    '), 'Shift-Tab': 'indentLess' } });
    const draft = store.get('pq_code_' + ME.code + '_' + tk.id); c.ed.setValue(draft || tk.starter); guardCM(c.ed, tk.id);
    let dt = null, lastSent = null;
    const sync = () => { const v = c.ed.getValue(); if (v === lastSent) return; lastSent = v; api({ a: 'draft', code: ME.code, mid: ME.mid, task: tk.id, src: v }, true).catch(() => {}); };
    c.ed.on('change', () => { store.set('pq_code_' + ME.code + '_' + tk.id, c.ed.getValue()); clearTimeout(dt); dt = setTimeout(sync, 4000); });
    c.sync = sync;
    el.querySelectorAll('.keyrow [data-k]').forEach(b => {
      b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
      const ins = () => { const k = KEYROW[+b.dataset.k], cm = c.ed; if (cm.getOption('readOnly')) return; cm.focus(); cm.replaceSelection(k[1], 'end', '+key'); if (k[2]) { const p = cm.getCursor(); cm.setCursor({ line: p.line, ch: p.ch - 1 }); } };
      b.addEventListener('touchend', e => { e.preventDefault(); ins(); }); b.addEventListener('click', ins);
    });
    const out = el.querySelector('.out');
    el.querySelector('.run').onclick = async e => { c.runs = (c.runs || 0) + 1; e.target.disabled = true; out.textContent = wReady ? 'Выполняем код…' : 'Подготавливаем Python…'; const r = await runPy(c.ed.getValue()); out.textContent = r.out + (r.msg ? '\n' + r.msg : ''); e.target.disabled = false; };
    el.querySelector('.send').onclick = async e => {
      const checkedSource = c.ed.getValue(); c.busy = true; updateCard(c, S.team.tasks[tk.id]); c.runs = (c.runs || 0) + 1; e.target.disabled = true; out.textContent = wReady ? 'Проверяем тесты…' : 'Подготавливаем Python…';
      const r = await runPy(checkedSource, tk.tests, !caseStrict(tk)); out.textContent = r.out + (r.msg ? '\n' + r.msg : '') + (r.ok ? '\n✔ Все тесты пройдены' : '');
      if (!r.ok) { if (!r.infrastructure) { c.failedChecks = (c.failedChecks || 0) + 1; store.set('pq_fail_' + ME.code + '_' + tk.id, c.failedChecks); api({ a: 'codeFailed', code: ME.code, mid: ME.mid, task: tk.id }, true).catch(() => {}); } c.busy = false; updateCard(c, S.team.tasks[tk.id]); e.target.disabled = false; return; }
      out.textContent += '\nСохраняем результат…';
      try { await act({ a: 'submit', code: ME.code, mid: ME.mid, task: tk.id, passed: true, src: withPasteNote(checkedSource, tk.id), paste: pasteInfo(tk.id), runs: c.runs, checkFailures: c.failedChecks || store.get('pq_fail_' + ME.code + '_' + tk.id) || 0 }); out.textContent += '\n✔ Ответ сохранён'; } catch (x) { out.textContent += '\n⚠ Не сохранено. Повторите сдачу: решение осталось в редакторе.'; e.target.disabled = false; } finally { c.busy = false; if (S.team?.tasks[tk.id]) updateCard(c, S.team.tasks[tk.id]); }
    };
  } else {
    if (tk.kind === 'order') el.querySelectorAll('.order li').forEach(li => {
      li.querySelector('.up').onclick = () => li.previousElementSibling && li.parentNode.insertBefore(li, li.previousElementSibling);
      li.querySelector('.dn').onclick = () => li.nextElementSibling && li.parentNode.insertBefore(li.nextElementSibling, li);
    });
    el.querySelectorAll('.ans, .freeans').forEach(x => guardInput(x, tk.id));
    if (tk.kind === 'free') { const ta = el.querySelector('.freeans'), k = 'pq_free_' + ME.code + '_' + tk.id; ta.value = store.get(k) || ''; ta.oninput = () => store.set(k, ta.value); }
    const fb = r => toast(r.correct ? '✔ Верно!' : r.left ? '✘ Неверно, осталось попыток: ' + r.left : '✘ Неверно, попытки закончились');
    el.querySelector('.send').onclick = async e => {
      if (tk.kind === 'free') {
        const txt = el.querySelector('.freeans').value.trim(); if (txt.length < 10) return toast('Напишите развёрнутый ответ');
        if (!await askConfirm('Отправить ответ преподавателю? Изменить будет нельзя.')) return;
        try { await act({ a: 'submit', code: ME.code, mid: ME.mid, task: tk.id, answer: txt, paste: pasteInfo(tk.id) }, e.target); saveAns(txt); toast('📝 Отправлено на проверку'); } catch (x) {} return;
      }
      let ans, shown;
      if (tk.kind === 'order') { const L = [...el.querySelectorAll('.order li')]; ans = L.map(li => li.dataset.i).join(','); shown = L.map(li => tk.options[+li.dataset.i]).join(' → '); }
      else if (tk.kind === 'mc') { ans = (el.querySelector('input[type=radio]:checked') || {}).value; shown = ans != null ? tk.options[+ans] : ''; }
      else { ans = el.querySelector('.ans').value.trim(); shown = ans; }
      if (ans == null || ans === '') return toast('Выберите или введите ответ');
      if (tk.kind === 'mc' && !await askConfirm('Попытка одна. Отправить ответ?')) return;
      try { const r = await act({ a: 'submit', code: ME.code, mid: ME.mid, task: tk.id, answer: ans, paste: pasteInfo(tk.id) }, e.target); const L = c.ans() || []; L.push((r.correct ? '✔ ' : '✘ ') + shown); saveAns(L); fb(r); } catch (x) {}
    };
  }
  return c;
}
function updateCard(c, x) {
  const done = CLOSED(x);
  c.el.querySelector('.res').innerHTML = done ? `<p class="st-${x.st === 'skipped' ? 'failed' : x.st}">${x.st === 'solved' ? '✔ Задача решена! +' + c.tk.pts + ' б.' : x.st === 'review' ? '📝 На проверке у преподавателя' : x.st === 'skipped' ? '✘ Задание провалено: пропуск, 0 баллов' : '✘ Попытки закончились — передайте задание или завершите за 0'}</p>` : (x.att ? `<p class="muted">Попыток использовано: ${x.att}</p>` : '');
  const a = c.ans(), sub = c.el.querySelector('.sub');
  const sh = done && a && c.tk.kind !== 'code' ? `<div class="myans"><b>Ваш ответ:</b> ${Array.isArray(a) ? a.map(esc).join('<br>') : esc(a)}</div>` : !done && Array.isArray(a) && a.length ? `<div class="myans muted">Было: ${a.map(esc).join('; ')}</div>` : '';
  if (sub._h !== sh) { sub.innerHTML = sh; sub._h = sh; }
  c.el.classList.toggle('closed', done);
  c.el.querySelectorAll('button.send, input, .run, textarea, .order button, .keyrow button').forEach(b => b.disabled = done || !!c.busy);
  if (c.ed) c.ed.setOption('readOnly', done || c.busy ? 'nocursor' : false);
}
function board(s) {
  const b = (s.board || []).slice().sort((a, b) => b.rating - a.rating || a.rank - b.rank);
  return `<div class="card"><h2>Игра завершена</h2><p>Ваши баллы: <b>${s.me.pts}</b>${s.team ? ' · команда «' + esc(s.team.name) + '»: <b>' + s.team.pts + '</b>' : ''}</p>
    ${rHelp()}<table><tr><th>#</th><th>Команда</th><th>Чел.</th><th>Решено</th><th>Рейтинг</th><th>Баллы</th><th>Место финиша</th></tr>${b.map((t, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(t.name)}</td><td>${t.n}</td><td>${t.solved}/${t.total}</td><td><b>${t.rating}%</b></td><td class="muted">${t.pts}</td><td>${t.rank}</td></tr>`).join('')}</table></div>`;
}
// ---------- события, тосты ----------
const tTitle = id => { const tk = TASK[id]; if (!tk) return id; const n = S && S.pool ? S.pool.indexOf(id) : -1; return (n >= 0 ? '№' + (n + 1) + ' ' : '') + '«' + tk.title + '»'; };
function onEvents(ev) { ev.forEach(onEvent); }
function onEvent(e) {
  const id = 'ev:' + S.code + ':' + e.id, team = e.team === 'Соло' ? 'соло' : 'команда ' + e.team;
  if (!S.me) { // преподаватель: тоже один тихий слот
    if (e.type === 'finish') notify(id, `🏁 ${/^Соло: /.test(e.team) ? e.team : 'Команда ' + e.team} закончила все задания (место ${e.place})`, { cls: 'fin' });
    return;
  }
  if (e.type === 'first') { if (e.fio !== S.me.fio) feed(id, `⚡ ${e.fio} (${team}) первым решил «${(TASK[e.task] || {}).title || e.task}»`); }
  else if (e.type === 'finish') { if (!(S.team && S.team.tid === e.tid)) feed(id, `🏁 ${/^Соло: /.test(e.team) ? e.team : 'Команда ' + e.team} закончила все задания (место ${e.place})`); }
}
function closeExtras() { ['#blitz', '#finale', '#blbadge', '#taskview', '#helpmodal'].forEach(q => { const x = $(q); if (x) x.remove(); }); }
const hhmm = at => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const REACT = ['👍', '😂', '🔥', '❓', '✅'];

// ---------- уведомления о назначении ----------
let prevMine = null;
function notifyAssign(s, mine) {
  const t = s.team, sk = 'pq_seen_' + s.code + '_' + ME.mid; let seen = store.get(sk);
  if (!seen) { seen = mine.slice(); store.set(sk, seen); }
  if (t.solo) { prevMine = mine.slice(); seen = mine; store.set(sk, seen); }
  if (prevMine && !t.solo) {
    const add = mine.filter(id => !prevMine.includes(id)), gone = prevMine.filter(id => !mine.includes(id));
    if (add.length) notify('as:' + s.code + ':' + add.slice().sort().join(','), '📌 Вам назначено задач: ' + add.length, { cls: 'assign', onclick: () => gotoTask(add[0]) });
    if (gone.length) feed('un:' + s.code + ':' + gone.slice().sort().join(',') + ':' + Date.now(), `↩ С вас снято задач: ${gone.length}`, 'tasks');
  }
  prevMine = mine.slice();
  seen = seen.filter(id => mine.includes(id)); store.set(sk, seen);
  const fresh = mine.filter(id => !seen.includes(id));
  mine.forEach(id => { const c = taskCards[id]; if (!c) return; const nb = c.el.querySelector('.newb'), isNew = fresh.includes(id);
    if (isNew && !nb) { const b = document.createElement('span'); b.className = 'newb'; b.textContent = 'НОВАЯ'; c.el.querySelector('h3').prepend(b);
      const open = () => { const v = store.get(sk) || []; if (!v.includes(id)) { v.push(id); store.set(sk, v); } const x = c.el.querySelector('.newb'); if (x) x.remove(); updNewCount(); };
      c.el.addEventListener('pointerdown', open, { once: true }); c.el.addEventListener('focusin', open, { once: true }); c.open = open; }
    if (!isNew && nb) nb.remove(); });
  updNewCount();
}
function updNewCount() { const n = document.querySelectorAll('.task .newb').length; let b = $('#newcnt'); const h = $('#hdr'); if (!h) return; if (!b) { b = document.createElement('span'); b.id = 'newcnt'; b.onclick = () => { const f = document.querySelector('.task .newb'); if (f) gotoTask(f.closest('.task').dataset.tid); }; h.appendChild(b); } b.hidden = !n; b.textContent = '📌 новых задач: ' + n; }

// ---------- чат команды ----------
function chatMsgHtml(m, ro, meMid, tid) {
  if (m.k === 'sys') return `<div class="msg k-sys"><span class="muted">${hhmm(m.at)}</span> ${esc(m.txt)}</div>`;
  const tidAttr = tid ? `data-tid="${tid}"` : '';
  const re = m.re || {};
  const rx = ro ? Object.keys(re).map(em => `<span class="rx on">${em} ${re[em].length}</span>`).join('')
    : REACT.map(em => `<button class="rx ${(re[em] || []).includes(meMid) ? 'on' : ''} ${re[em] ? 'has' : ''}" data-rx="${em}" data-msg="${m.id}">${em}${re[em] ? ' ' + re[em].length : ''}</button>`).join('');
  const link = m.task ? ` <a href="#" class="tlink" data-goto="${m.task}" ${tidAttr}>→ ${esc(tTitle(m.task))}</a>` : '';
  return `<div class="msg ${m.mid === meMid ? 'me' : ''} k-${m.k}"><div class="mh"><b>${esc(m.fio)}</b> <span class="muted">${hhmm(m.at)}</span></div><div class="mt">${esc(m.txt)}${link}</div><div class="rxs">${rx}</div></div>`;
}
function renderChat(s) {
  const t = s.team, tab = $('#tab-chat'); if (!tab) return;
  if (!t || t.solo || s.status === 'lobby') { if (tab._mode !== 'off') { tab._mode = 'off'; tab.innerHTML = `<div class="card muted">${t && t.solo ? 'В соло-режиме чата нет.' : 'Чат команды откроется, когда начнётся игра.'}</div>`; } tabBadge('chat', 0); return; }
  if (tab._mode !== 'on') {
    tab._mode = 'on';
    tab.innerHTML = `<div id="chatpanel"><div id="ch-list"></div>
      <div class="ch-q"><select id="ch-task"></select><button class="sec" id="ch-help">🆘 Помогите с задачей</button><button class="sec" data-q="done">✅ Готово</button><button class="sec" data-q="look">👀 Сейчас посмотрю</button></div>
      <div class="ch-in"><input id="ch-txt" maxlength="200" placeholder="Сообщение (до 200 символов)" autocomplete="off"><button id="ch-send">➤</button></div></div>`;
    guardInput($('#ch-txt'), 'chat');
    $('#ch-send').onclick = e => { const v = $('#ch-txt').value.trim(); if (v) chatSend('text', v, null, e.target).then(ok => ok && ($('#ch-txt').value = '')); };
    $('#ch-txt').onkeydown = e => { if (e.key === 'Enter') $('#ch-send').click(); };
    $('#ch-help').onclick = e => { const id = $('#ch-task').value; if (!id) return toast('Помощь можно попросить только по своей открытой задаче'); chatSend('help', 'Помогите с задачей ' + tTitle(id), id, e.target); };
    tab.querySelectorAll('[data-q]').forEach(b => b.onclick = e => chatSend(b.dataset.q, b.dataset.q === 'done' ? 'Готово ✅' : 'Сейчас посмотрю 👀', null, e.target));
    tab.addEventListener('click', chatClicks);
  }
  // помощь — только по своим назначенным и ещё открытым задачам
  const ids = (s.pool || []).filter(id => { const x = t.tasks[id]; return x && x.to === ME.mid && !CLOSED(x); });
  const sel = $('#ch-task'), opts = (ids.length ? '<option value="">— моя открытая задача —</option>' : '<option value="">нет открытых задач</option>') + ids.map(id => `<option value="${id}">${esc(tTitle(id))}</option>`).join('');
  if (sel._o !== opts && document.activeElement !== sel) { const v = sel.value; sel.innerHTML = opts; sel._o = opts; sel.value = ids.includes(v) ? v : (ids[0] || ''); }
  $('#ch-help').disabled = !ids.length;
  const chat = t.chat || [], html = chat.map(m => chatMsgHtml(m, false, ME.mid)).join('') || '<div class="muted">Пока тихо. Напишите команде!</div>';
  const list = $('#ch-list');
  if (list._h !== html) { const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40; list.innerHTML = html; list._h = html; if (atEnd || !list._init) list.scrollTop = list.scrollHeight; list._init = 1; }
  // тихо: новые сообщения → Лента + счётчик «Чат»; прерывает только просьба о помощи (один раз)
  const ck = 'pq_chatseen_' + s.code + '_' + t.tid, cs = SS.get(ck);
  if (cs == null) SS.set(ck, chat.length ? chat[chat.length - 1].id : 0);
  else { chat.filter(m => m.id > cs && m.mid !== ME.mid).forEach(m => {
      if (m.k === 'help') notify('help:' + s.code + ':' + t.tid + ':' + m.id, `🆘 ${m.fio}: ${tTitle(m.task)}`, { cls: 'help', onclick: () => gotoTask(m.task) });
      feed('ch:' + t.tid + ':' + m.id, (m.k === 'sys' ? '🤖 ' : '💬 ' + m.fio + ': ') + m.txt, 'chat'); });
    if (chat.length) SS.set(ck, Math.max(cs, chat[chat.length - 1].id)); }
  if (TAB === 'chat' && !document.hidden) markRead();
  const rk = 'pq_chatread_' + s.code + '_' + t.tid, read = store.get(rk) || 0;
  tabBadge('chat', chat.filter(m => m.id > read && m.mid !== ME.mid).length);
}
async function chatSend(k, txt, task, btn) { try { await act({ a: 'chat', code: ME.code, mid: ME.mid, k, txt, task }, btn); pollNow(); return true; } catch (e) { return false; } }
function chatClicks(e) {
  const rx = e.target.closest('[data-rx]'); if (rx) { act({ a: 'react', code: ME.code, mid: ME.mid, msg: +rx.dataset.msg, emoji: rx.dataset.rx }).then(() => pollNow()).catch(() => {}); return; }
  const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); gotoTask(g.dataset.goto, g.dataset.tid); }
}
function markRead() { const t = S && S.team; if (!t || !t.chat) return; const last = t.chat.length ? t.chat[t.chat.length - 1].id : 0; store.set('pq_chatread_' + S.code + '_' + t.tid, last); tabBadge('chat', 0); }
function gotoTask(id, tid) {
  if (!S.me) return openHelp(id, tid);                     // учитель
  const c = taskCards[id];
  if (c) { if (TAB !== 'tasks') setTab('tasks'); openTask(id); return; }
  openHelp(id);
}
// просмотр чужой задачи (товарищ по ссылке «Помогите» / учитель): условие, статус, попытки, текущий код исполнителя
async function openHelp(id, tid) {
  const tk = TASK[id]; if (!tk) return;
  let m = $('#helpmodal'); if (m) m.remove();
  m = document.createElement('div'); m.id = 'helpmodal';
  m.innerHTML = `<div class="hm-box"><div class="tv-h"><button class="sec" id="hm-x">← Назад</button><b class="tv-t">Помощь: ${esc(tk.title)}</b></div>
    <div class="hm-body"><div><span class="pill ${tk.cat}">${catLabel(tk)}</span> <span class="muted">${tk.pts} б.</span></div><div id="hm-meta" class="muted">Загрузка…</div>
    <div class="desc">${tk.desc}</div>${tk.kind === 'mc' ? `<ol class="opts">${tk.options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : tk.kind === 'order' ? `<ol class="opts">${tk.options.map(o => `<li><code>${esc(o)}</code></li>`).join('')}</ol>` : ''}
    <div id="hm-code"></div>
    ${S.me ? `<div class="hm-reply"><div class="btnrow"><button class="sec" data-hq="look">👀 Сейчас посмотрю</button></div><div class="ch-in"><input id="hm-txt" maxlength="200" placeholder="Подсказка в чат команды" autocomplete="off"><button id="hm-send">➤</button></div></div>` : '<p class="muted">Только просмотр</p>'}</div></div>`;
  document.body.appendChild(m); history.pushState({ hm: 1 }, '');
  $('#hm-x').onclick = () => m.remove();
  if (S.me) {
    guardInput($('#hm-txt'), 'chat');
    const send = (k, txt, btn) => chatSend(k, txt, null, btn).then(ok => { if (ok) { toast('Отправлено в чат'); if (k === 'text') $('#hm-txt').value = ''; } });
    m.querySelector('[data-hq]').onclick = e => send('look', 'Сейчас посмотрю 👀 ' + tTitle(id), e.target);
    $('#hm-send').onclick = e => { const v = $('#hm-txt').value.trim(); if (v) send('text', v, e.target); };
    $('#hm-txt').onkeydown = e => { if (e.key === 'Enter') $('#hm-send').click(); };
  }
  const load = async () => {
    try {
      const r = await api(S.me ? { a: 'peek', code: S.code, mid: ME.mid, task: id } : { a: 'peek', code: S.code, key: (store.get('pq_teacher') || {}).key, tid, task: id });
      if (!document.body.contains(m)) return;
      $('#hm-meta').innerHTML = `Исполнитель: <b>${esc(r.to || '—')}</b> · статус: <b class="st-${r.st || ''}">${ST[r.st] || 'не начата'}</b> · попыток: ${r.att}`;
      const src = r.draft ? r.draft.src : (tk.kind === 'code' ? tk.starter : null);
      $('#hm-code').innerHTML = tk.kind === 'code' ? `<div class="muted">${r.draft ? 'Текущий код исполнителя (обновлён ' + hhmm(r.draft.at) + ')' : 'Исполнитель ещё не писал код — показан шаблон'}:</div><pre class="code">${esc(src)}</pre>` : '';
    } catch (e) { $('#hm-meta').textContent = '⚠ ' + e.message; }
  };
  load(); const iv = setInterval(() => document.body.contains(m) ? load() : clearInterval(iv), 6000);
}

// ---------- блиц ----------
function blitzBoard(b) {
  const mine = b.mine ? (b.mine.ok ? `✅ Верно! +${b.mine.pts} б.` : '❌ Неверно') : 'Вы не успели ответить';
  return `<h2>⚡ Блиц #${b.n}: итоги</h2><p><b>${mine}</b></p><table class="lb"><tr><th>#</th><th>Игрок</th><th>Время</th><th>Очки</th></tr>${(b.top || []).map((r, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(r.fio)}</td><td>${r.sec} с</td><td><b>+${r.pts}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Никто не ответил верно</td></tr>'}</table><button id="bl-x">Закрыть</button>`;
}
function openBlitzBoard(b) {
  let ov = $('#blitz'); if (!ov) { ov = document.createElement('div'); ov.id = 'blitz'; document.body.appendChild(ov); }
  ov._p = 'board' + b.n; ov.innerHTML = `<div class="bl-box">${blitzBoard(b)}</div>`; $('#bl-x').onclick = () => ov.remove();
}
function blitzBadge(b) {
  let bd = $('#blbadge');
  if (!b) { if (bd) bd.remove(); return; }
  if (!bd) { bd = document.createElement('div'); bd.id = 'blbadge'; document.body.appendChild(bd); }
  const h = `⚡ Блиц: ответ принят, итоги через <span data-deadline="${b.end}"></span>`;
  if (bd._h !== h) { bd.innerHTML = h; bd._h = h; }
}
function renderBlitz(s) {
  const b = s.blitz, ov0 = $('#blitz');
  if (!b || !s.team || !TASK[b.task]) { if (ov0) ov0.remove(); blitzBadge(null); return; }
  const ended = !!b.top, tk = TASK[b.task];
  if (ended) {
    blitzBadge(null);
    if (ov0 && ov0._p !== 'board' + b.n && !ov0._closing) ov0.remove();
    const tk2 = 'pq_blitzt_' + s.code + '_' + b.n;
    if (!store.get(tk2)) { store.set(tk2, 1); const mine = b.mine ? (b.mine.ok ? `✅ +${b.mine.pts}` : '❌ мимо') : 'без ответа'; const w = b.top[0];
      feed('blz:' + s.code + ':' + b.n, `⚡ Блиц #${b.n} окончен: ${mine}${w ? ' · 🥇 ' + w.fio : ''}`); }
    return;
  }
  if (b.mine) {                                   // ответил: коротко результат → бейдж в углу
    blitzBadge(b);
    if (ov0 && ov0._p !== 'res' + b.n && !ov0._closing) {
      ov0._p = 'res' + b.n; ov0._closing = 1;
      ov0.remove(); toast(b.mine.ok ? `✅ Блиц: верно, +${b.mine.pts}` : '❌ Блиц: неверно');
    }
    return;
  }
  const phase = 'q' + b.n;
  if (ov0 && ov0._p === phase) { const n = ov0.querySelector('.bl-n'); if (n) n.textContent = b.answers || 0; return; }
  // не открываем окно сами: маленький тост + плашка «Ответить»
  notify('blitz:' + s.code + ':' + b.n, `⚡ Блиц #${b.n}! Нажмите, чтобы ответить`, { cls: 'blitz', vibrate: true, onclick: () => openBlitzQ(S) });
  let bd = $('#blbadge'); if (!bd) { bd = document.createElement('div'); bd.id = 'blbadge'; document.body.appendChild(bd); }
  const bh = `⚡ Блиц #${b.n}: ответить · <span data-deadline="${b.end}"></span>`;
  if (bd._h !== bh) { bd.innerHTML = bh; bd._h = bh; } bd.onclick = () => openBlitzQ(S);
}
function openBlitzQ(s) {
  const b = s.blitz; if (!b || b.top || b.mine || !TASK[b.task]) return; const tk = TASK[b.task], phase = 'q' + b.n;
  blitzBadge(null);
  let ov = $('#blitz'); if (!ov) { ov = document.createElement('div'); ov.id = 'blitz'; document.body.appendChild(ov); }
  ov._p = phase;
  const inp = tk.kind === 'mc' ? `<div class="mc">${tk.options.map((o, i) => `<label><input type="radio" name="bl" value="${i}"> ${esc(o)}</label>`).join('')}</div>` : `<input class="ans" id="bl-ans" placeholder="Ваш ответ" autocomplete="off">`;
  ov.innerHTML = `<div class="bl-box"><h2>⚡ Блиц #${b.n}!</h2><div class="bl-timer" data-deadline="${b.end}"></div><p class="muted">У каждого свой вопрос. Первые верные: 3 / 2 / 1 балл. Попытка одна!</p><h3>${esc(tk.title)}</h3><p>${tk.desc}</p>${inp}<button id="bl-go">Ответить</button> <button class="sec" id="bl-later">Позже</button> <span class="muted">Ответили: <span class="bl-n">${b.answers || 0}</span></span></div>`;
  if ($('#bl-ans')) { guardInput($('#bl-ans'), 'blitz' + b.n); $('#bl-ans').focus(); $('#bl-ans').onkeydown = e => { if (e.key === 'Enter') $('#bl-go').click(); }; }
  $('#bl-later').onclick = () => { ov.remove(); renderBlitz(S); };
  $('#bl-go').onclick = async e => {
    const ans = tk.kind === 'mc' ? (ov.querySelector('input[type=radio]:checked') || {}).value : $('#bl-ans').value.trim();
    if (ans == null || ans === '') return toast('Введите ответ');
    try { await act({ a: 'blitzAnswer', code: ME.code, mid: ME.mid, answer: ans, paste: pasteInfo('blitz' + b.n) }, e.target); pollNow(); } catch (x) {}
  };
}

// ---------- финал команды ----------
function maybeFinale(s) {
  const t = s.team; if (!t || !t.finished || !t.achievements) return;
  const k = 'pq_fin_' + s.code + '_' + t.tid; if (store.get(k)) return; store.set(k, 1); showFinale(s);
}
function showFinale(s) {
  const t = s.team; if (!t || !t.finished) return;
  let ov = $('#finale'); if (!ov) { ov = document.createElement('div'); ov.id = 'finale'; document.body.appendChild(ov); }
  const A = t.achievements || {}, medal = ['🥇', '🥈', '🥉'][t.finished.place - 1] || '🏅';
  const mem = t.members.map(m => `<div class="fm"><div class="fm-n">${m.mid === t.captain && !t.solo ? '★ ' : ''}${esc(m.fio)} <span class="muted">${m.pts} б.</span></div>${(A[m.mid] || []).map(a => `<div class="ach"><b>🏅 ${esc(a.t)}</b><span>${esc(a.d)}</span></div>`).join('')}</div>`).join('');
  ov.innerHTML = `<div class="fin-box"><div class="fin-medal">${medal}</div><h1>${t.solo ? 'Вы прошли все задания!' : 'Команда «' + esc(t.name) + '» прошла все задания!'}</h1>
    <h2>Место: ${t.finished.place} · ${t.pts} баллов</h2><div class="fin-grid">${mem}</div><button id="fin-x">Ура! 🎉</button></div>`;
  $('#fin-x').onclick = () => ov.remove();
  if (window.confetti) { const f = (d, o) => setTimeout(() => confetti(o), d); f(0, { particleCount: 200, spread: 120, origin: { y: .6 } }); f(400, { particleCount: 120, angle: 60, spread: 70, origin: { x: 0 } }); f(700, { particleCount: 120, angle: 120, spread: 70, origin: { x: 1 } }); f(1300, { particleCount: 150, spread: 160, origin: { y: .3 } }); }
}

// ---------- учитель: блиц, финиши, чаты ----------
const openChats = {};
function tBlitz(s) {
  const b = s.blitz; if (!b) return '';
  const tk = TASK[b.task] || { title: b.task }, live = Date.now() + clockOff < b.end;
  return `<div class="card blitzcard"><h3>⚡ Блиц #${b.n}: ${esc(tk.title)} ${live ? '· осталось <span class="timer" data-deadline="' + b.end + '"></span>' : '· завершён'}</h3>
    <table class="lb"><tr><th>#</th><th>Игрок</th><th>Время</th><th>Очки</th></tr>${(b.top || []).map((r, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(r.fio)}</td><td>${r.sec} с</td><td>+${r.pts}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Верных ответов пока нет</td></tr>'}</table></div>`;
}
function tFinished(s) {
  const f = s.teams.filter(t => t.finished).sort((a, b) => a.finished.place - b.finished.place); if (!f.length) return '';
  return `<div class="card"><h3>🏁 Финишировали</h3><table><tr><th>Место</th><th>Команда</th><th>Время</th><th>Достижения</th></tr>${f.map(t => `<tr><td>${['🥇', '🥈', '🥉'][t.finished.place - 1] || t.finished.place}</td><td>${t.solo ? 'Соло: ' + esc(t.members[0].fio) : esc(t.name)}</td><td>${hhmm(t.finished.at)}</td>
    <td>${t.members.map(m => `<div><b>${esc(m.fio)}</b>: ${((t.achievements || {})[m.mid] || []).map(a => `<span class="pill ach-p" title="${esc(a.d)}">${esc(a.t)}</span>`).join(' ')}</div>`).join('')}</td></tr>`).join('')}</table></div>`;
}
function tFinish(t) { return ''; }
function tChat(t) {
  if (t.solo) return ''; const ch = t.chat || [];
  return `<details data-chat="${t.tid}" class="tchat"><summary>💬 Чат (${ch.length})</summary><div class="ch-ro">${ch.map(m => chatMsgHtml(m, true, null, t.tid)).join('') || '<div class="muted">Сообщений нет</div>'}</div></details>`;
}

document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.rhelp')) toast(RATING_HELP, 10000); });

'use strict';

// Shared, accessible confirmations do not block polling or browser controls.
function askConfirm(message) {
  return new Promise(resolve => {
    const old = $('#confirm14'); if (old) return resolve(false);
    const dialog = document.createElement('dialog'); dialog.id = 'confirm14';
    dialog.innerHTML = `<form method="dialog"><h2>Подтверждение</h2><p>${esc(message).replace(/\n/g,'<br>')}</p><div class="actions14"><button value="cancel" class="sec">Отмена</button><button value="ok">Подтвердить</button></div></form>`;
    document.body.appendChild(dialog);
    dialog.onclose = () => { const ok = dialog.returnValue === 'ok'; dialog.remove(); resolve(ok); };
    dialog.showModal();
  });
}

function setTheme14(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('pq_theme',theme); } catch(e) {}
  document.querySelectorAll('[data-theme-toggle]').forEach(b => { b.textContent = theme === 'dark' ? '☀ Светлая' : '☾ Тёмная'; b.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'); });
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = theme === 'dark' ? '#090d15' : '#f4f6fa';
}
function clearRoomUI14() {
  S = null; ME = null; const b = $('#rank-toggle14'); if (b) b.textContent = '🏆 Рейтинг';
  const net = $('#net'); if (net) net.textContent = ''; renderRank14(null);
}
function chrome14() {
  let tools = $('#global-tools14'); if (tools) return;
  tools = document.createElement('div'); tools.id = 'global-tools14';
  tools.innerHTML = '<button class="sec" data-theme-toggle></button><button class="sec" id="fullscreen14" aria-label="Переключить полноэкранный режим">⛶ На весь экран</button><button id="rank-toggle14" aria-haspopup="dialog" aria-expanded="false">🏆 Рейтинг</button>';
  document.body.appendChild(tools);
  tools.querySelector('[data-theme-toggle]').onclick = () => setTheme14(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#fullscreen14').onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else toast('На этом устройстве полноэкранный режим недоступен'); }
    catch(e) { toast('Браузер не разрешил полный экран. Игра продолжает работать.'); }
  };
  $('#rank-toggle14').onclick = openRank14;
  document.addEventListener('fullscreenchange', () => { $('#fullscreen14').textContent = document.fullscreenElement ? '⛶ Оконный режим' : '⛶ На весь экран'; });
  setTheme14(document.documentElement.dataset.theme || 'light');
}
let rankOpener14 = null;
function openRank14() {
  let dialog = $('#rank14');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'rank14';
    dialog.innerHTML = '<div class="drawer-head14"><div><span class="eyebrow14">ИГРА · ПРЯМО СЕЙЧАС</span><h2>Таблица лидеров</h2></div><button class="sec" id="rank-close14" aria-label="Закрыть рейтинг">✕</button></div><div id="rank-rows14"></div><p class="muted">Обновляется автоматически при наличии связи · примерно раз в 2 секунды.</p>';
    document.body.appendChild(dialog);
    $('#rank-close14').onclick = () => dialog.close();
    dialog.addEventListener('click',e => { if (e.target === dialog) { const r=dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
    dialog.onclose = () => { $('#rank-toggle14').setAttribute('aria-expanded','false'); if (rankOpener14 && rankOpener14.isConnected) rankOpener14.focus(); };
  }
  rankOpener14 = document.activeElement; renderRank14(S); dialog.showModal(); $('#rank-toggle14').setAttribute('aria-expanded','true');
}
function renderRank14(s) {
  const el = $('#rank-rows14'); if (!el) return;
  if (!s || !s.teams) { el.innerHTML = '<p class="muted">Войдите в комнату, чтобы увидеть рейтинг.</p>'; return; }
  const teams = s.teams.filter(t=>t.members.length).slice().sort((a,b)=>(a.rank || 999)-(b.rank || 999));
  const h = teams.map((t,i)=>{
    const name = t.solo ? t.members[0].fio : t.name, points = t.pts ?? t.raw ?? 0;
    const pct = Math.max(0,Math.min(100,t.rating || 0));
    return `<article class="rank-card14 ${s.me && s.me.team===t.tid?'mine14':''}"><div class="rank-num14">${['🥇','🥈','🥉'][i] || i+1}</div><div class="rank-info14"><b>${esc(name)}</b><div class="bar"><i style="width:${pct}%"></i></div><span class="muted">${t.solved ?? t.score?.solved ?? 0}/${t.total || 0} задач · ${t.members.length} чел.</span></div><div class="rank-score14"><strong>${t.rating || 0}%</strong><span>${points} б.</span></div></article>`;
  }).join('') || '<p class="muted">Команды ещё собираются.</p>';
  if (el._h !== h) { el.innerHTML=h; el._h=h; }
}
function renderAwards14(s) {
  const el = $('#tab-achievements'); if (!el) return;
  const me=s.me, st=me.streak || {current:0,best:0,bonus:0};
  const awards=s.team?.achievements?.[ME.mid] || [];
  const milestones=[3,5,10].map(n=>`<article class="award14 ${st.best>=n?'earned14':''}"><span>${st.best>=n?'🔥':'◇'}</span><b>${n} подряд</b><p>Решите ${n} заданий подряд с первой попытки.</p><progress max="${n}" value="${Math.min(n,st.best)}"></progress><small>${Math.min(n,st.best)}/${n}</small></article>`).join('');
  const h=`<div class="hero14"><span class="eyebrow14">ВАШ ПРОГРЕСС</span><h2>Достижения</h2><p>Успех складывается из маленьких шагов.</p><div class="stats14"><div><strong>${st.current}</strong><span>сейчас подряд</span></div><div><strong>${st.best}</strong><span>лучшая серия</span></div><div><strong>+${st.bonus}</strong><span>бонус серии / 5</span></div></div></div><p class="muted">Каждые 3 верных решения подряд с первой попытки: +1 балл, максимум +5 за игру. Ошибка, передача или «нет ответа» сбрасывает текущую серию. Блиц в серию не входит.</p><div class="awards14">${milestones}</div><div class="card"><h3>Награды за игру</h3>${awards.length?awards.map(a=>`<div class="ach"><b>🏅 ${esc(a.t)}</b><span>${esc(a.d)}</span></div>`).join(''):'<p class="muted">Решайте задачи — здесь появятся ваши награды.</p>'}<p class="muted">Награды во время игры предварительные; итоговые определяются при завершении.</p></div>`;
  if(el._h!==h){el.innerHTML=h;el._h=h;}
}
function teamLive14(s) {
  const t=s.team; if(!t) return '';
  const st=s.me.streak || {current:0};
  return `<div class="team-live14"><div><span class="eyebrow14">${t.solo?'ЛИЧНЫЙ РЕЗУЛЬТАТ':'ВАША КОМАНДА'}</span><b>${esc(t.name)}</b></div><strong>${t.pts} б.</strong><span>${t.rating}% · #${t.rank || '—'}</span><span class="streak14">🔥 ${st.current} подряд</span></div>${!t.solo?`<details class="roster14"><summary>Состав команды · ${t.members.length} участника</summary>${t.members.map(m=>`<div><span>${m.mid===t.captain?'★ ':''}${esc(m.fio)}</span><b>${m.pts} б.</b></div>`).join('')}</details>`:''}`;
}
function renderTaskTools(s) {
  const el=$('#task-actions'); if(!el || !openTid || !s.team) return;
  const id=openTid,x=s.team.tasks[id]; if(!x) return;
  const can=s.status==='running' && x.to===ME.mid && !['solved','review','skipped'].includes(x.st);
  const peers=s.team.members.filter(m=>m.mid!==ME.mid);
  const h=can?`<div class="card task-tools14"><h3>Застряли на задании?</h3>${peers.length && !x.transfers?`<label>Передать сокоманднику<select id="transfer-to14"><option value="">Выберите участника</option>${peers.map(m=>`<option value="${esc(m.mid)}">${esc(m.fio)}</option>`).join('')}</select></label><button class="sec" id="transfer14">Передать задание</button><p class="muted">Одна передача на задание. История попыток сохраняется.</p>`:x.transfers?'<p class="muted">Задание уже передано вам. Можно решить его или завершить за 0.</p>':''}<button class="sec" id="skip14">Пропустить — провал, 0 баллов</button></div>`:'';
  if(el._h===h)return; el._h=h; el.innerHTML=h;
  const transfer=$('#transfer14'); if(transfer)transfer.onclick=async()=>{
    const to=$('#transfer-to14').value; if(!to)return toast('Выберите сокомандника');
    if(!await askConfirm('Передать задание выбранному участнику? Текущая серия прервётся.'))return;
    try{await act({a:'transfer',code:ME.code,mid:ME.mid,task:id,to},transfer);closeTask();toast('Задание передано');}catch(e){}
  };
  const skip=$('#skip14'); if(skip)skip.onclick=async()=>{
    if(!await askConfirm('Пропустить задание? Оно будет засчитано как проваленное: 0 баллов, серия прервётся. Вернуть его в работу будет нельзя.'))return;
    try{await act({a:'skip',code:ME.code,mid:ME.mid,task:id},skip);toast('Задание засчитано как проваленное: пропуск, 0 баллов');}catch(e){}
  };
}
function renderFocus14(s) {
  const el=$('#tab-me'); if(!el)return;
  let panel=$('#focus-status14'); if(!panel){panel=document.createElement('div');panel.id='focus-status14';panel.className='card';el.appendChild(panel);}
  const f=s.me.focus || {},h=`<h3>Режим внимания ${s.focusEnabled?'включён':'выключен'}</h3><p>Вне вкладки: ${Math.round((f.awayMs || 0)/1000)} с · штраф: <b>−${f.penalty || 0} б.</b></p>${s.focusEnabled?'<p class="muted">После возвращения: первые 10 секунд без штрафа, затем −1 за каждые полные 30 секунд. Максимум −5 за игру, итог не ниже нуля. Выход из полного экрана сам по себе не штрафуется.</p>':''}`;
  if(panel.innerHTML!==h)panel.innerHTML=h;
}
function renderUpgrade(s) {
  chrome14(); renderRank14(s); renderAwards14(s); renderFocus14(s);
  if(!s?.me)return;
  const btn=$('#rank-toggle14'); btn.textContent=s.team?`🏆 #${s.team.rank || '—'} · ${s.team.pts} б.`:'🏆 Рейтинг';
  const live=$('#task-team-live'); if(live){const h=teamLive14(s);if(live._h!==h){const open=live.querySelector('details')?.open;live.innerHTML=h;live._h=h;if(open && live.querySelector('details'))live.querySelector('details').open=true;}}
  renderTaskTools(s);
  if(s.focusEnabled && s.status==='running' && !SS.get('focus_notice_'+s.code)) {
    SS.set('focus_notice_'+s.code,true); toast('Режим внимания включён. Правила штрафов — во вкладке «Моё».',4000);
  }
  if(s.status!=='running' || !s.focusEnabled){SS.set('focus_pending14',null);}
}

// Server timestamps and event IDs avoid duplicate charges after reload/retry.
let focusStart14 = null, focusReturning14 = false;
async function returnFocus14() {
  const pending=SS.get('focus_pending14'); if(!pending || focusReturning14 || document.hidden)return;
  if(!ME || pending.code!==ME.code || pending.mid!==ME.mid)return;
  focusReturning14=true;
  try {
    if(focusStart14)await focusStart14;
    const r=await act({a:'focus',code:ME.code,mid:ME.mid,id:pending.id,phase:'end'});
    SS.set('focus_pending14',null); if(r.deducted)toast(`Вне вкладки ${r.seconds} с. Списано ${r.deducted} б.; всего −${r.penalty}.`,4000);
  }catch(e){}finally{focusReturning14=false;focusStart14=null;}
}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){returnFocus14();pollNow();return;}
  if(!ME || !S?.me || S.status!=='running' || !S.focusEnabled || SS.get('focus_pending14'))return;
  const id=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
  SS.set('focus_pending14',{id,code:ME.code,mid:ME.mid});
  focusStart14=api({a:'focus',code:ME.code,mid:ME.mid,id,phase:'start'},true).catch(()=>{});
});
setInterval(()=>{if(!document.hidden)returnFocus14();},10000);

const teacherRender14=renderTeacher;
renderTeacher=function(T){
  teacherRender14(T);chrome14();renderRank14(S);
  const s=S;let settings=$('#teacher-focus14');
  if(!settings){settings=document.createElement('section');settings.id='teacher-focus14';settings.className='card';$('#app').appendChild(settings);}
  settings.innerHTML=`<h3>Режим внимания</h3>${s.status==='lobby'?`<label class="check14"><input type="checkbox" id="focus-enabled14" ${s.focusEnabled?'checked':''}> Учитывать уход со страницы и применять штрафы</label>`:`<p>${s.focusEnabled?'Включён':'Выключен'} · выбирается до начала игры</p>`}<p class="muted">10 секунд без штрафа, затем −1 за каждые полные 30 секунд отсутствия, максимум −5 за игру.</p>${s.teams.flatMap(t=>t.members).map(m=>`<div class="focus-row14"><span>${esc(m.fio)}</span><span>🔥 ${m.streak?.current || 0} · вне вкладки ${Math.round((m.focus?.awayMs || 0)/1000)} с · −${m.focus?.penalty || 0} б.</span></div>`).join('')}`;
  const check=$('#focus-enabled14');if(check)check.onchange=()=>act({a:'focusSettings',code:T.code,key:T.key,enabled:check.checked},check).catch(()=>{});
};
const teacherBlitz14=tBlitz;
tBlitz=function(s){
  const h=teacherBlitz14(s),b=s.blitz;if(!b?.questions)return h;
  return h+`<details class="card"><summary>Индивидуальные вопросы блица · ${b.questions.length}</summary>${b.questions.map(q=>`<div class="focus-row14"><span>${esc(q.fio)}</span><span>${esc(TASK[q.task]?.title || q.task)} · ${esc(q.task)}</span></div>`).join('')}</details>`;
};
document.addEventListener('click',e=>{if(e.target.closest?.('.rhelp'))setTimeout(()=>toast('Места — по рейтингу. Рейтинг: процент баллов за задачи + бонусы на участника (до +15) − штраф на участника. Каждые 3 решения с первой попытки: +1, максимум +5 за игру. Итог не ниже нуля.',4000),0);});
chrome14();home();
