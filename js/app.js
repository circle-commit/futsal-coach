// 화면 전환(#주소)과 홈·학교·반·아이 화면
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

// 학교·반 이름표: "한빛초 · 3학년 2반"
export async function orgIndex() {
  const [schools, groups] = await Promise.all([store.listSchools(), store.listGroups()]);
  const school = Object.fromEntries(schools.map(x => [x.id, x])), group = Object.fromEntries(groups.map(g => [g.id, g]));
  const groupLabel = id => (group[id] ? `${school[group[id].schoolId]?.name ?? '?'} · ${group[id].name}` : '반 없음');
  return { schools, groups, school, group, groupLabel };
}
const storeGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

async function home() {
  mount('t-home');
  const [sessions, kids, org] = await Promise.all([store.listSessions(), store.listKids(), orgIndex()]);
  const f = $('#filter');
  f.innerHTML = '<option value="">전체</option>' + org.schools.map(sc => `<optgroup label="${esc(sc.name)}"><option value="s:${sc.id}">${esc(sc.name)} 전체</option>` +
    org.groups.filter(g => g.schoolId === sc.id).map(g => `<option value="g:${g.id}">${esc(g.name)}</option>`).join('') + '</optgroup>').join('');
  f.value = storeGet('futsal-filter') || '';
  if (f.selectedIndex < 0) f.value = '';
  const draw = () => {
    storeSet('futsal-filter', f.value);
    const [k, id] = f.value.split(':');
    const list = sessions.filter(s => !k || (k === 'g' ? s.groupId === id : org.group[s.groupId]?.schoolId === id));
    const el = $('#sessions'); el.innerHTML = '';
    if (!list.length) el.innerHTML = sessions.length ? '<p class="empty">이 학교·반의 수업 기록이 아직 없어요.</p>' : '<p class="empty">아직 분석한 수업이 없어요. 먼저 <a href="#orgs">학교·반</a>을 만들고 <b>새 수업 분석</b>으로 시작해 보세요.</p>';
    for (const s of list) {
      const a = document.createElement('a'); a.className = 'item'; a.href = '#s-' + s.id;
      const named = Object.values(s.assign || {}).filter(x => kids.some(y => y.id === x)).length;
      a.innerHTML = `<div><b>${esc(s.title)}</b><br><span>${esc(org.groupLabel(s.groupId))} · ${esc(s.date)} · ${fmtTime(s.result.duration)} · 아이 ${s.result.players.length}명 (이름 연결 ${named}명)</span></div><span>›</span>`;
      el.append(a);
    }
  };
  f.onchange = draw; draw();
  $('#bExport').onclick = async () => {
    const blob = new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `풋살코치-백업-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('#backupMsg').textContent = '백업 파일을 받았어요.';
  };
  $('#fImport').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!(await ask(`백업의 학교 ${data.schools?.length ?? 0}곳, 아이 ${data.kids?.length ?? 0}명, 수업 ${data.sessions?.length ?? 0}개를 불러올까요? 같은 기록은 백업 내용으로 바뀌어요.`, { ok: '불러오기' }))) return;
      const r = await store.importAll(data);
      await home(); $('#backupMsg').textContent = `학교 ${r.schools}곳, 아이 ${r.kids}명, 수업 ${r.sessions}개를 불러왔어요.`;
    } catch (err) { $('#backupMsg').textContent = '불러오지 못했어요: ' + err.message; }
  };
}

// 학교·반 목록
async function orgs() {
  mount('t-orgs');
  const [org, kids, sessions] = await Promise.all([orgIndex(), store.listKids(), store.listSessions()]);
  const el = $('#orgList');
  if (!org.schools.length) el.innerHTML = '<p class="empty">수업하는 학교를 추가하고, 그 아래에 반을 만들어 주세요.</p>';
  for (const sc of org.schools) {
    const box = document.createElement('div'); box.className = 'school';
    const groups = org.groups.filter(g => g.schoolId === sc.id);
    box.innerHTML = `<div class="school-head"><div><b>${esc(sc.name)}</b> <span>${sc.court ? `코트 ${sc.court[0]}×${sc.court[1]}m` : '코트 크기 아직 없음'}</span></div>
      <div class="row-btns"><button class="btn small" data-a="group">반 추가</button>${sc.id === store.UNSORTED ? '' : '<button class="btn small" data-a="rename">이름 바꾸기</button><button class="btn small danger" data-a="del">지우기</button>'}</div></div>
      <div class="list"></div>`;
    const list = box.querySelector('.list');
    if (!groups.length) list.innerHTML = '<p class="empty">아직 반이 없어요.</p>';
    for (const g of groups) {
      const a = document.createElement('a'); a.className = 'item'; a.href = '#g-' + g.id;
      a.innerHTML = `<b>${esc(g.name)}</b><span>아이 ${kids.filter(k => k.groupIds?.includes(g.id)).length}명 · 수업 ${sessions.filter(s => s.groupId === g.id).length}번 ›</span>`;
      list.append(a);
    }
    box.querySelector('[data-a=group]').onclick = async () => {
      const name = await ask(`${sc.name}에 만들 반 이름 (예: 3학년 2반, 방과후 A반)`, { input: '' });
      if (name) { await store.putGroup({ id: store.uid(), schoolId: sc.id, name }); orgs(); }
    };
    box.querySelector('[data-a=rename]')?.addEventListener('click', async () => {
      const name = await ask('학교 이름', { input: sc.name }); if (name) { await store.putSchool({ ...sc, name }); orgs(); }
    });
    box.querySelector('[data-a=del]')?.addEventListener('click', async () => {
      if (!(await ask(`${sc.name}을(를) 지울까요?`, { ok: '지우기' }))) return;
      try { await store.deleteSchool(sc.id); orgs(); } catch (e) { await ask(e.message, { ok: '확인' }); }
    });
    el.append(box);
  }
  $('#bAddSchool').onclick = async () => {
    const name = await ask('학교 이름', { input: '' });
    if (name) { await store.putSchool({ id: store.uid(), name }); orgs(); }
  };
}

const perMin = (s, p) => p.distance / (s.result.duration / 60);

// 반 한 곳: 아이 명단 + 수업별 비교 표
async function group(id) {
  mount('t-group');
  const [org, kids, sessions] = await Promise.all([orgIndex(), store.listKids(), store.listSessions()]);
  const g = org.group[id];
  if (!g) { $('#gName').textContent = '없는 반이에요'; return; }
  const mine = kids.filter(k => k.groupIds?.includes(id)), ss = sessions.filter(s => s.groupId === id).sort((a, b) => a.date.localeCompare(b.date));
  $('#gSchool').textContent = org.school[g.schoolId]?.name ?? '';
  $('#gName').textContent = g.name;
  $('#gMeta').textContent = `아이 ${mine.length}명 · 수업 ${ss.length}번`;
  // 다른 반 아이는 "이름 (학교 · 반)"으로 골라서 같은 아이로 잇는다
  const others = kids.filter(k => !k.groupIds?.includes(id)), label = k => `${k.name} (${k.groupIds.map(org.groupLabel).join(', ')})`;
  $('#allKids').innerHTML = others.map(k => `<option value="${esc(label(k))}">`).join('');
  $('#gKidForm').onsubmit = async e => {
    e.preventDefault();
    const v = $('#gKidName').value.trim(); if (!v) return;
    const ex = others.find(k => label(k) === v);
    await store.putKid(ex ? { ...ex, groupIds: [...ex.groupIds, id] } : { id: store.uid(), name: v, groupIds: [id] });
    group(id);
  };
  const el = $('#gKids');
  if (!mine.length) el.innerHTML = '<p class="empty">아이를 추가하면 수업 결과에서 이름을 고를 때 이 반 아이들이 먼저 나와요.</p>';
  for (const k of mine) {
    const n = ss.filter(s => Object.values(s.assign || {}).includes(k.id)).length;
    const row = document.createElement('div'); row.className = 'item';
    row.innerHTML = `<a href="#k-${k.id}"><b>${esc(k.name)}</b></a><span>이 반 수업 ${n}번 <button class="link">이 반에서 빼기</button></span>`;
    row.querySelector('button').onclick = async () => {
      if (!(await ask(`${k.name}을(를) ${g.name}에서 뺄까요? 기록은 그대로 남아요.`, { ok: '빼기' }))) return;
      await store.putKid({ ...k, groupIds: k.groupIds.filter(x => x !== id) }); group(id);
    };
    el.append(row);
  }
  const t = $('#gTable');
  if (!ss.length) { t.innerHTML = '<tr><td class="empty">이 반에서 분석한 수업이 아직 없어요.</td></tr>'; }
  else {
    t.innerHTML = `<tr><th>아이</th>${ss.map(s => `<th>${esc(s.date.slice(5))}</th>`).join('')}<th>평균</th></tr>` + mine.map(k => {
      const vals = ss.map(s => { const pid = Object.entries(s.assign || {}).find(([, v]) => v === k.id)?.[0]; return pid == null ? null : { s, v: perMin(s, s.result.players[+pid]) }; });
      const got = vals.filter(Boolean);
      return `<tr><td>${esc(k.name)}</td>${vals.map(x => (x ? `<td class="num"><a href="#s-${x.s.id}">${Math.round(x.v)}</a></td>` : '<td>–</td>')).join('')}<td><b>${got.length ? Math.round(got.reduce((a, x) => a + x.v, 0) / got.length) : '–'}</b></td></tr>`;
    }).join('');
  }
  $('#bGRename').onclick = async () => { const n = await ask('반 이름', { input: g.name }); if (n) { await store.putGroup({ ...g, name: n }); group(id); } };
  $('#bGDel').onclick = async () => {
    if (!(await ask(`${g.name}을(를) 지울까요? 아이들은 다른 반에 그대로 남아요.`, { ok: '지우기' }))) return;
    try { await store.deleteGroup(id); location.hash = '#orgs'; } catch (e) { await ask(e.message, { ok: '확인' }); }
  };
}

// 아이 한 명의 수업별 기록 (여러 반에 걸쳐)
async function kid(id) {
  mount('t-kid');
  const [k, sessions, org] = await Promise.all([store.listKids().then(l => l.find(x => x.id === id)), store.listSessions(), orgIndex()]);
  if (!k) { $('#kName').textContent = '명단에 없는 아이예요'; return; }
  const rows = sessions.flatMap(s => Object.entries(s.assign || {}).filter(([, kid]) => kid === id)
    .map(([pid]) => ({ s, p: s.result.players[+pid] }))).filter(r => r.p).sort((a, b) => a.s.date.localeCompare(b.s.date));
  $('#kName').textContent = k.name;
  $('#kGroups').innerHTML = k.groupIds.map(g => `<a class="chip" href="#g-${g}">${esc(org.groupLabel(g))}</a>`).join('');
  $('#kMeta').textContent = rows.length ? `수업 ${rows.length}번 · 평균 ${Math.round(rows.reduce((a, r) => a + r.p.distance, 0) / rows.length)}m` : '아직 연결된 수업이 없어요. 수업 결과 화면의 이름 칸에서 이 아이를 골라 주세요.';
  const t = $('#kTable');
  t.innerHTML = '<tr><th>날짜</th><th>반</th><th>수업</th><th>뛴 거리</th><th>분당 거리</th><th>최고 속도</th><th>전력질주</th><th>공 소유 (베타)</th><th>패스 (베타)</th></tr>' +
    rows.map(({ s, p }) => `<tr data-href="#s-${s.id}"><td>${esc(s.date)}</td><td>${esc(org.groupLabel(s.groupId))}</td><td>${esc(s.title)}</td><td>${Math.round(p.distance)} m</td><td>${Math.round(perMin(s, p))} m</td><td>${(p.topSpeed * 3.6).toFixed(1)} km/h</td><td>${p.sprints}회</td><td>${p.possession.toFixed(0)}초</td><td>${p.passes}</td></tr>`).join('');
  t.onclick = e => { const r = e.target.closest('tr[data-href]'); if (r) location.hash = r.dataset.href; };
  // 막대그래프: 수업 길이가 달라서 분당 거리로 비교
  const c = $('#kChart'), w = c.clientWidth, h = 200, ctx = fit(c, w, h);
  const vals = rows.map(r => perMin(r.s, r.p)), mx = Math.max(1, ...vals) * 1.15, bw = Math.min(60, (w - 40) / Math.max(1, vals.length) - 10);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#66706c'; ctx.fillText('분당 뛴 거리 (m)', 0, 12);
  vals.forEach((v, i) => {
    const x = 40 + i * (bw + 10), bh = (v / mx) * (h - 50);
    ctx.fillStyle = '#1f7a52'; ctx.fillRect(x, h - 22 - bh, bw, bh);
    ctx.fillStyle = '#1d2321'; ctx.textAlign = 'center'; ctx.fillText(Math.round(v), x + bw / 2, h - 26 - bh);
    ctx.fillStyle = '#66706c'; ctx.fillText(rows[i].s.date.slice(5), x + bw / 2, h - 6);
  });
  $('#bRename').onclick = async () => { const n = await ask('새 이름', { input: k.name }); if (n) { await store.putKid({ ...k, name: n }); kid(id); } };
  $('#bKidDel').onclick = async () => {
    if (!(await ask(`${k.name}을(를) 모든 반 명단에서 뺄까요? 수업 기록 자체는 남고, 이름 연결만 풀려요.`, { ok: '빼기' }))) return;
    await store.deleteKid(id); location.hash = '#orgs';
  };
}

async function route() {
  const h = location.hash || '#home';
  const tab = h.startsWith('#g-') || h.startsWith('#k-') ? '#orgs' : h.startsWith('#s-') ? '#home' : h;
  document.querySelectorAll('.top nav a').forEach(a => a.toggleAttribute('aria-current', a.getAttribute('href') === tab));
  try {
    if (h === '#new') await (await import('./new.js')).renderNew();
    else if (h.startsWith('#s-')) await (await import('./session.js')).renderSession(h.slice(3));
    else if (h === '#orgs' || h === '#kids') await orgs();
    else if (h.startsWith('#g-')) await group(h.slice(3));
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
