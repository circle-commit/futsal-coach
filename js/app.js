// 화면 전환(#주소)과 홈·아이 명단 화면
import * as store from './store.js';
import { fit, fmtTime } from './court.js';

const view = document.getElementById('view');
let cleanup = null;
export const $ = s => view.querySelector(s);
export function mount(id) {
  cleanup?.(); cleanup = null;
  view.replaceChildren(document.getElementById(id).content.cloneNode(true));
}
export const onLeave = fn => { cleanup = fn; };
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const sessionVideos = new Map(); // 이번 접속에서 연결한 영상 (저장하지 않음)

/** 확인창 (input이 있으면 입력값, 없으면 true/false) */
export function ask(msg, { input = null, ok = '확인' } = {}) {
  const d = document.getElementById('dialog'), inp = document.getElementById('dlgInput'), yes = document.getElementById('dlgYes'), no = document.getElementById('dlgNo');
  document.getElementById('dlgMsg').textContent = msg;
  yes.textContent = ok; inp.hidden = input === null; inp.value = input ?? '';
  d.hidden = false; (input === null ? yes : inp).focus();
  return new Promise(res => {
    const close = v => { d.hidden = true; yes.onclick = no.onclick = inp.onkeydown = d.onkeydown = null; res(v); };
    yes.onclick = () => close(input === null ? true : inp.value.trim() || null);
    no.onclick = () => close(input === null ? false : null);
    inp.onkeydown = e => { if (e.key === 'Enter') yes.click(); };
    d.onkeydown = e => { if (e.key === 'Escape') no.click(); };
  });
}

async function home() {
  mount('t-home');
  const [sessions, kids] = await Promise.all([store.listSessions(), store.listKids()]);
  const el = $('#sessions');
  if (!sessions.length) el.innerHTML = '<p class="empty">아직 분석한 수업이 없어요. 위의 <b>새 수업 분석</b>으로 시작해 보세요.</p>';
  for (const s of sessions) {
    const a = document.createElement('a'); a.className = 'item'; a.href = '#s-' + s.id;
    const named = Object.values(s.assign || {}).filter(k => kids.some(x => x.id === k)).length;
    a.innerHTML = `<div><b>${esc(s.title)}</b><br><span>${esc(s.date)} · ${fmtTime(s.result.duration)} · 아이 ${s.result.players.length}명 (이름 연결 ${named}명)</span></div><span>›</span>`;
    el.append(a);
  }
  $('#bExport').onclick = async () => {
    const blob = new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `풋살코치-백업-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('#backupMsg').textContent = '백업 파일을 받았어요.';
  };
  $('#fImport').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!(await ask(`백업의 아이 ${data.kids?.length ?? 0}명, 수업 ${data.sessions?.length ?? 0}개를 불러올까요? 같은 기록은 백업 내용으로 바뀌어요.`, { ok: '불러오기' }))) return;
      const r = await store.importAll(data);
      await home(); $('#backupMsg').textContent = `아이 ${r.kids}명, 수업 ${r.sessions}개를 불러왔어요.`;
    } catch (err) { $('#backupMsg').textContent = '불러오지 못했어요: ' + err.message; }
  };
}

async function kids() {
  mount('t-kids');
  const [list, sessions] = await Promise.all([store.listKids(), store.listSessions()]);
  const el = $('#kidList');
  if (!list.length) el.innerHTML = '<p class="empty">아이 이름을 추가하면 수업 결과에서 골라 연결할 수 있어요.</p>';
  for (const k of list) {
    const n = sessions.filter(s => Object.values(s.assign || {}).includes(k.id)).length;
    const a = document.createElement('a'); a.className = 'item'; a.href = '#k-' + k.id;
    a.innerHTML = `<b>${esc(k.name)}</b><span>수업 ${n}번 기록 ›</span>`;
    el.append(a);
  }
  $('#kidForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#kidName').value.trim(); if (!name) return;
    await store.putKid({ id: store.uid(), name }); kids();
  };
}

// 아이 한 명의 수업별 기록
async function kid(id) {
  mount('t-kid');
  const [k, sessions] = await Promise.all([store.listKids().then(l => l.find(x => x.id === id)), store.listSessions()]);
  if (!k) { $('#kName').textContent = '명단에 없는 아이예요'; return; }
  const rows = sessions.flatMap(s => Object.entries(s.assign || {}).filter(([, kid]) => kid === id)
    .map(([pid]) => ({ s, p: s.result.players[+pid] }))).filter(r => r.p).sort((a, b) => a.s.date.localeCompare(b.s.date));
  $('#kName').textContent = k.name;
  $('#kMeta').textContent = rows.length ? `수업 ${rows.length}번 · 평균 ${Math.round(rows.reduce((a, r) => a + r.p.distance, 0) / rows.length)}m` : '아직 연결된 수업이 없어요. 수업 결과 화면의 이름 칸에서 이 아이를 골라 주세요.';
  const t = $('#kTable');
  t.innerHTML = '<tr><th>날짜</th><th>수업</th><th>뛴 거리</th><th>분당 거리</th><th>최고 속도</th><th>전력질주</th><th>공 소유 (베타)</th><th>패스 (베타)</th></tr>' +
    rows.map(({ s, p }) => `<tr data-href="#s-${s.id}"><td>${esc(s.date)}</td><td>${esc(s.title)}</td><td>${Math.round(p.distance)} m</td><td>${Math.round(p.distance / (s.result.duration / 60))} m</td><td>${(p.topSpeed * 3.6).toFixed(1)} km/h</td><td>${p.sprints}회</td><td>${p.possession.toFixed(0)}초</td><td>${p.passes}</td></tr>`).join('');
  t.onclick = e => { const r = e.target.closest('tr[data-href]'); if (r) location.hash = r.dataset.href; };
  // 막대그래프: 수업 길이가 달라서 분당 거리로 비교
  const c = $('#kChart'), w = c.clientWidth, h = 200, ctx = fit(c, w, h);
  const vals = rows.map(r => r.p.distance / (r.s.result.duration / 60)), mx = Math.max(1, ...vals) * 1.15, bw = Math.min(60, (w - 40) / Math.max(1, vals.length) - 10);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#66706c'; ctx.fillText('분당 뛴 거리 (m)', 0, 12);
  vals.forEach((v, i) => {
    const x = 40 + i * (bw + 10), bh = (v / mx) * (h - 50);
    ctx.fillStyle = '#1f7a52'; ctx.fillRect(x, h - 22 - bh, bw, bh);
    ctx.fillStyle = '#1d2321'; ctx.textAlign = 'center'; ctx.fillText(Math.round(v), x + bw / 2, h - 26 - bh);
    ctx.fillStyle = '#66706c'; ctx.fillText(rows[i].s.date.slice(5), x + bw / 2, h - 6);
  });
  $('#bRename').onclick = async () => { const n = await ask('새 이름', { input: k.name }); if (n) { await store.putKid({ ...k, name: n }); kid(id); } };
  $('#bKidDel').onclick = async () => {
    if (!(await ask(`${k.name}을(를) 명단에서 뺄까요? 수업 기록 자체는 남고, 이름 연결만 풀려요.`, { ok: '빼기' }))) return;
    for (const s of sessions) {
      const a = Object.fromEntries(Object.entries(s.assign || {}).filter(([, v]) => v !== id));
      if (Object.keys(a).length !== Object.keys(s.assign || {}).length) await store.putSession({ ...s, assign: a });
    }
    await store.deleteKid(id); location.hash = '#kids';
  };
}

async function route() {
  const h = location.hash || '#home';
  document.querySelectorAll('.top nav a').forEach(a => a.toggleAttribute('aria-current', a.getAttribute('href') === h));
  try {
    if (h === '#new') (await import('./new.js')).renderNew();
    else if (h.startsWith('#s-')) await (await import('./session.js')).renderSession(h.slice(3));
    else if (h === '#kids') await kids();
    else if (h.startsWith('#k-')) await kid(h.slice(3));
    else await home();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<section class="panel"><h1>문제가 생겼어요</h1><p class="err">${esc(e.message)}</p><a class="btn" href="#home">처음으로</a></section>`;
  }
  scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
