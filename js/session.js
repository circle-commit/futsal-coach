// 수업 결과 화면: 영상·전술 보드·팀 간격·검수·교정·아이 카드·패스 연결
import { $, mount, onLeave, esc, ask, sessionVideos, orgIndex, downloadJSON } from './app.js';
import * as store from './store.js';
import { fit, drawCourt, courtHeight, heatCanvas, fmtTime } from './court.js';
import { homography, applyH } from './vision.js';
import { findReviewSegments, swapPlayerSegment, REVIEW_REASONS, REVIEW_RULES } from './review.js';
import * as reviewApi from './review.js'; // compareReviewResults는 엔진에 새로 들어오는 중: 아직 없어도 화면이 깨지지 않게 이름공간으로 읽는다

// 이 화면의 세션 저장·삭제는 한 줄로 세운다: 이름 고르기와 교정·취소·복원·지우기가 서로 덮어쓰지 않게 (다시 그려도 이어짐).
// 줄 안의 작업은 화면이 가진 s가 아니라 저장소의 최신 세션을 다시 읽어 그 위에 고친다. 세션이 지워졌으면 저장하지 않는다(되살리지 않음).
let writing = Promise.resolve();
const queue = job => (writing = writing.then(job, job));
// 저장소의 최신 세션 (없거나 지워졌으면 null). id까지 확인해 엉뚱한 값이 와도 저장하지 않게
const latest = async id => { const x = await store.getSession(id); return x?.id === id ? x : null; };
const HISTORY = 10; // 직전 취소용 결과 스냅샷 최대 개수

/** opts: 교정 저장 뒤 다시 그릴 때 이어 갈 화면 상태 { t: 보던 시각(초), playing, sel: 고른 아이, flash: 알림 }
 * 반환: 다 그렸으면 true, 불러오는 사이 다른 화면으로 가서 그리지 않았으면 false */
export async function renderSession(id, opts = {}) {
  mount('t-session');
  // 떠남 표시는 불러오기 전에 건다: 불러오는 사이 다른 화면으로 가면 아무것도 그리지 않고 끝낸다
  // (늦게 끝난 쪽이 새 화면을 덮어쓰거나, 정리되지 않은 그리기 반복이 남는 일 방지). stop은 다 그린 뒤 채운다.
  let left = false, stop = null;
  onLeave(() => { left = true; stop?.(); });
  let s, kids, org;
  try { [s, kids, org] = await Promise.all([latest(id), store.listKids(), orgIndex()]); }
  catch (e) { if (left) return false; throw e; }
  if (left) return false;
  if (!s) throw new Error('이 수업 기록을 찾을 수 없어요');
  const R = s.result, P = R.players, [L, W] = R.court, dt = R.dt, N = P[0].path.length / 2, T = R.teams;
  const color = p => T[p.team].color, num = p => p.label.split(' ').pop();
  const label = p => kids.find(k => k.id === s.assign[p.id])?.name || p.label;
  let sel = opts.sel ?? null, busy = false; const show = { trail: true, ball: true, heat: false };

  $('#sTitle').textContent = s.title;
  $('#toTactics').href = '#t-' + id;
  $('#sMeta').textContent = `${org.groupLabel(s.groupId)} · ${s.date} · ${fmtTime(R.duration)} · 아이 ${P.length}명`;
  $('#bDelete').onclick = async () => {
    if (busy || left) return;
    if (!(await ask(`'${s.title}' 기록을 지울까요? 되돌릴 수 없어요.`, { ok: '지우기' })) || busy || left) return;
    busy = true; sync();
    try { await queue(() => store.deleteSession(id)); } // 앞선 저장이 끝난 뒤 지움 → 지운 뒤 저장돼 되살아나지 않음
    catch (e) { if (left) return; busy = false; sync(); await ask('기록을 지우지 못했어요: ' + e.message, { ok: '확인' }); return; }
    sessionVideos.delete(id);
    // left만 보면 안 된다: 주소는 이미 다른 화면인데 라우터가 아직 안 돌았으면 left=false다. 그래서 지금 주소로 정한다.
    // 지운 수업(#s-id·#t-id)이면 홈으로. 다른 주소는 지킨다: 이미 그려진 목록 화면(left)만 다시 그려 지운 기록을 빼고,
    // 아직 안 그려졌으면 곧 라우터가 새로 그린다. 새 분석 같은 작업 중 화면은 건드리지 않음
    const h = location.hash || '#home';
    if (h === '#s-' + id || h === '#t-' + id) location.hash = '#home';
    else if (left && (h === '#home' || h === '#orgs' || h === '#kids' || h.startsWith('#g-') || h.startsWith('#k-'))) dispatchEvent(new HashChangeEvent('hashchange'));
  };
  // ---------- 이 수업만 파일로 보관: 기존 백업(v2) 형식이라 홈의 '백업 불러오기'로 다시 열린다 (IndexedDB 자동 저장은 그대로) ----------
  // 저장·교정·이름 바꾸기·지우기와 같은 줄(queue)에 서서, 앞선 저장이 끝난 최신 기록으로 만든다. busy 동안 다른 버튼은 잠김(중복 클릭 포함)
  const saveMsg = (text, err = false, focus = false) => { const el = $('#saveMsg'); el.textContent = text; el.classList.toggle('err', err); if (focus) el.focus({ preventScroll: true }); };
  // 길이는 helper(sessionBackupFilename)가 UTF-8 255바이트 안으로 맞춘다. 여기서 글자 수로 자르면 이모지가 반쪽 나거나 .json이 잘릴 수 있어 자르지 않음
  // (못 쓰는 글자를 _ 하나로 바꾸는 것은 길이를 늘리지 않음)
  const safeFile = n => { const x = String(n ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim(); return x ? (/\.json$/i.test(x) ? x : x + '.json') : '풋살코치-수업.json'; };
  $('#bSaveFile').onclick = async () => {
    if (busy || left) return;
    busy = true; sync(); saveMsg('파일을 만드는 중…');
    try {
      let mod;
      try { mod = await import('./session-file.js'); } catch { throw new Error('수업 파일 만들기 도구(js/session-file.js)를 불러오지 못했어요. 새로고침해 보거나 홈의 백업 파일 받기를 써 주세요.'); }
      if (typeof mod.buildSessionBackup !== 'function' || typeof mod.sessionBackupFilename !== 'function') throw new Error('수업 파일 만들기 도구가 아직 준비되지 않았어요.');
      let file = null;
      await queue(async () => {
        if (left) return;
        const [session, schools, groups, kids] = await Promise.all([latest(id), store.listSchools(), store.listGroups(), store.listKids()]);
        if (!session) throw new Error('이 수업 기록이 지워져서 저장할 수 없어요.');
        file = { name: safeFile(mod.sessionBackupFilename(session)), data: mod.buildSessionBackup({ session, schools, groups, kids }) };
      });
      if (left || !file) return; // 그사이 다른 화면으로 갔으면 내려받지 않음
      downloadJSON(file.name, file.data);
      saveMsg(`${file.name} 파일로 저장했어요. 다시 열 때는 홈의 백업 불러오기에서 이 파일을 고르세요.`);
    } catch (e) {
      if (!left) saveMsg('분석 결과를 저장하지 못했어요: ' + e.message, true, true);
    } finally {
      if (!left) { busy = false; sync(); }
    }
  };
  // v2는 0.3초 이하로 잠깐 안 보인 틈을 앞뒤로 이어서 셈. 분석 방식을 모르면(예전 기록) 예전 문구
  const gapNote = s.analysis?.engine === 'classical-v2' ? ' (0.3초 이하로 잠깐 안 보인 틈은 앞뒤를 이어서 뺀 값)' : '';
  $('#assumeNote').textContent = `거리·속도는 코트 ${L}×${W}m 기준 추정치예요. 아이가 가려져 위치를 놓친 시간 ${(R.hiddenRate * 100).toFixed(1)}%${gapNote} · 같은 팀 아이끼리 겹쳤다 떨어지면 번호가 바뀔 수 있어요.`;

  // ---------- 시계: 영상이 있으면 영상 시간, 없으면 보드 자체 재생 ----------
  const v = $('#sv');
  let url = sessionVideos.get(id), ct = 0, playing = false, lastNow = null, pendingT = null, resume = null; // lastNow: 직전 프레임 시각 (첫 프레임 전엔 없음)
  const attach = u => { url = u; sessionVideos.set(id, u); v.src = u; $('#videoPanel').hidden = false; $('#linkVideo').hidden = true; $('#rvNoVideo').hidden = true; };
  if (url) attach(url); else $('#videoPanel').hidden = true;
  $('#fLink').onchange = e => { const f = e.target.files[0]; if (f) attach(URL.createObjectURL(f)); };
  const getT = () => pendingT ?? (url ? v.currentTime : ct);
  const setT = t => { t = Math.max(0, Math.min(R.duration, t)); pendingT = null; if (url) v.currentTime = t; else ct = t; };
  if (opts.t != null) { // 교정 저장 뒤 다시 그릴 때: 보던 시각·재생 상태 이어 가기 (영상은 새로 불러오므로 메타데이터가 오면 그 시각으로)
    const t0 = Math.max(0, Math.min(R.duration, opts.t));
    if (url) {
      pendingT = t0;
      // 떠난 뒤에 메타데이터가 와도 화면 밖 영상을 재생하지 않게 (떠날 때 stop()이 이 듣기도 뗀다)
      resume = () => { if (left || pendingT == null) return; v.currentTime = pendingT; pendingT = null; if (opts.playing) v.play().catch(() => {}); };
      v.addEventListener('loadedmetadata', resume, { once: true });
    } else { ct = t0; playing = !!opts.playing; }
  }
  const clock = $('#clock'); clock.max = R.duration;
  clock.oninput = () => setT(+clock.value);
  $('#bPlay').onclick = () => { if (url) (v.paused ? v.play() : v.pause()); else playing = !playing; };
  const idxAt = t => Math.max(0, Math.min(N - 1, Math.round(t / dt)));

  // ---------- 영상 위 표시 ----------
  const Hp = homography([[0, 0], [L, 0], [L, W], [0, W]], R.video.corners); // m → 분석 해상도 px
  const ov = $('#ov');
  function drawOverlay(i) {
    if (!url) return;
    const vw = v.clientWidth, vh = v.clientHeight, ctx = fit(ov, vw, vh);
    ov.style.height = '100%';
    const ar = R.video.width / R.video.height, dw = Math.min(vw, vh * ar), dh = dw / ar, ox = (vw - dw) / 2, oy = (vh - dh) / 2, k = dw / R.video.width;
    const at = (x, y) => { const [px, py] = applyH(Hp, x, y); return [ox + px * k, oy + py * k]; };
    for (const p of P) {
      if (sel != null && sel !== p.id) continue;
      const [x, y] = at(p.path[2 * i], p.path[2 * i + 1]), r = Math.max(8, 0.6 * dw / L);
      ctx.strokeStyle = sel === p.id ? '#fff' : '#ffd400'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
      ctx.font = 'bold 12px sans-serif'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText(sel === p.id ? label(p) : num(p), x + r * 0.8, y - r * 0.8); ctx.shadowBlur = 0;
    }
    const bx = R.ball[2 * i];
    if (show.ball && bx != null) {
      const [x, y] = at(bx, R.ball[2 * i + 1]);
      ctx.strokeStyle = '#3dff7a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    }
  }

  // ---------- 전술 보드 ----------
  const board = $('#board'), heatCache = new Map();
  const heatOf = key => { if (!heatCache.has(key)) heatCache.set(key, heatCanvas(key === 'all' ? P.map(p => p.path) : [P[key].path], L, W)); return heatCache.get(key); };
  function drawBoard(i) {
    const w = board.clientWidth, ctx = fit(board, w, courtHeight(w, L, W)), { X, s: sc, pad } = drawCourt(ctx, w, L, W);
    if (show.heat) ctx.drawImage(heatOf(sel ?? 'all'), pad, pad, L * sc, W * sc);
    for (const p of P) {
      const dim = sel != null && sel !== p.id;
      if (show.trail) {
        ctx.beginPath(); ctx.strokeStyle = color(p); ctx.globalAlpha = dim ? 0.15 : 0.6; ctx.lineWidth = 2;
        for (let k = Math.max(0, i - 30); k <= i; k++) { const x = X(p.path[2 * k]), y = X(p.path[2 * k + 1]); k === Math.max(0, i - 30) ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.3 : 1;
      const x = X(p.path[2 * i]), y = X(p.path[2 * i + 1]);
      ctx.beginPath(); ctx.arc(x, y, sel === p.id ? 11 : 9, 0, 7); ctx.fillStyle = color(p); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(num(p), x, y + 0.5);
      ctx.globalAlpha = 1;
    }
    const bx = R.ball[2 * i];
    if (show.ball && bx != null) {
      ctx.beginPath(); ctx.arc(X(bx), X(R.ball[2 * i + 1]), 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
  document.querySelectorAll('#view [data-tg]').forEach(b => {
    b.onclick = () => { const k = b.dataset.tg; show[k] = !show[k]; b.setAttribute('aria-pressed', show[k]); redraw(); };
  });

  // ---------- 팀 간격 ----------
  const spreadTeams = T.map((_, t) => t).filter(t => P.filter(p => p.team === t).length > 1), spread = {};
  for (const t of spreadTeams) {
    const ps = P.filter(p => p.team === t), raw = [];
    for (let i = 0; i < N; i++) {
      let sum = 0, n = 0;
      for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) { sum += Math.hypot(ps[a].path[2 * i] - ps[b].path[2 * i], ps[a].path[2 * i + 1] - ps[b].path[2 * i + 1]); n++; }
      raw.push(sum / n);
    }
    const pre = [0]; raw.forEach(x => pre.push(pre[pre.length - 1] + x));
    spread[t] = raw.map((_, i) => { const a = Math.max(0, i - 25), b = Math.min(N, i + 26); return (pre[b] - pre[a]) / (b - a); }); // 5초 평균
  }
  // 그래프 높이 기준(모든 팀·장면의 최댓값)은 그릴 때마다가 아니라 여기서 한 번만. 장면 수만큼 긴 배열이라 펼치지(...) 않는다 (긴 영상 RangeError)
  const spreadMax = spreadTeams.reduce((m, t) => spread[t].reduce((x, val) => Math.max(x, val), m), -Infinity);
  const sp = $('#spread'), M = 30;
  function drawSpread(i) {
    const w = sp.clientWidth, h = 130, ctx = fit(sp, w, h);
    if (!spreadTeams.length) { ctx.fillStyle = '#66706c'; ctx.font = '12px sans-serif'; ctx.fillText('팀마다 2명 이상일 때 보여요', 8, 20); return; }
    const mx = spreadMax * 1.1, Y = val => h - 18 - (val / mx) * (h - 28);
    ctx.font = '11px sans-serif';
    for (const y of [0, 5, 10, 15, 20, 25].filter(y => y < mx)) { ctx.fillStyle = '#e3e6e2'; ctx.fillRect(M, Y(y), w - M, 1); ctx.fillStyle = '#66706c'; ctx.fillText(y + 'm', 0, Y(y) + 4); }
    for (let m = 0; m * 60 <= R.duration; m++) ctx.fillText(m + '분', M + ((m * 60) / R.duration) * (w - M) - 6, h - 2);
    for (const t of spreadTeams) {
      ctx.beginPath(); ctx.strokeStyle = T[t].color; ctx.lineWidth = 2;
      spread[t].forEach((val, k) => { const x = M + (k / (N - 1)) * (w - M); k ? ctx.lineTo(x, Y(val)) : ctx.moveTo(x, Y(val)); });
      ctx.stroke();
    }
    ctx.fillStyle = '#1d2321'; ctx.fillRect(M + (i / (N - 1)) * (w - M) - 1, 0, 2, h - 18);
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'right';
    spreadTeams.forEach((t, k) => { ctx.fillStyle = T[t].color; ctx.fillText(`${T[t].name} ${spread[t][i].toFixed(1)}m`, w - 4 - k * 110, 12); });
  }
  sp.onclick = e => { const r = sp.getBoundingClientRect(); setT(((e.clientX - r.left - M) / (r.width - M)) * R.duration); };

  // ---------- 아이 카드 ----------
  const maxD = Math.max(...P.map(p => p.distance));
  $('#teamsSum').innerHTML = T.map((t, k) => {
    const ps = P.filter(p => p.team === k);
    return `<span><span class="dot" style="background:${t.color}"></span> ${esc(t.name)} ${ps.length}명 · 합계 <b>${(ps.reduce((a, p) => a + p.distance, 0) / 1000).toFixed(2)} km</b></span>`;
  }).join('');
  async function assign(p, value) {
    if (busy) return renderCards(); // 교정 저장 중에는 이름을 바꾸지 않음 (서로 덮어쓰기 방지)
    try {
      if (value === '__new') {
        const name = await ask('새 아이 이름', { input: '' });
        if (!name) return renderCards();
        const k = { id: store.uid(), name, groupIds: [s.groupId] }; await store.putKid(k); kids = await store.listKids(); value = k.id; // 이 수업의 반에 넣음
      }
      const picked = kids.find(k => k.id === value);
      if (picked && !picked.groupIds?.includes(s.groupId)) { await store.putKid({ ...picked, groupIds: [...(picked.groupIds || []), s.groupId] }); kids = await store.listKids(); } // 다른 반 아이를 고르면 이 반에도 넣음
      await queue(async () => { // 줄을 서서, 저장소의 최신 세션 위에 이름만 바꿔 저장
        if (left) return; // 그사이 교정으로 화면을 다시 그렸거나 떠났으면 이 오래된 화면의 변경은 버림
        const cur = await latest(id);
        if (!cur) throw new Error('이 수업 기록이 지워졌어요');
        const a = { ...cur.assign };
        for (const [pid, kid] of Object.entries(a)) if (kid === value) delete a[pid]; // 한 아이는 한 자리에만
        if (value) a[p.id] = value; else delete a[p.id];
        const next = { ...cur, assign: a }; await store.putSession(next); s = next;
      });
    } catch (e) { if (!left) rvMsg('이름을 저장하지 못했어요: ' + e.message, true); }
    if (left) return;
    renderCards(); redraw(); drawPassNets(); renderReview(); renderCompare();
  }
  function renderCards() {
    const el = $('#cards'); el.innerHTML = '';
    for (const p of [...P].sort((a, b) => b.distance - a.distance)) {
      const c = document.createElement('div'); c.className = 'card' + (sel === p.id ? ' sel' : '');
      c.tabIndex = 0; c.setAttribute('role', 'button'); c.setAttribute('aria-pressed', sel === p.id);
      // 이 반 아이를 먼저, 다른 반 아이는 반 이름과 함께 아래에
      const opt = k => `<option value="${k.id}" ${s.assign[p.id] === k.id ? 'selected' : ''}>${esc(k.name)}</option>`;
      const mine = kids.filter(k => k.groupIds?.includes(s.groupId)), rest = kids.filter(k => !k.groupIds?.includes(s.groupId));
      const opts = `<optgroup label="${esc(org.group[s.groupId]?.name ?? '이 반')}">${mine.map(opt).join('')}</optgroup>` +
        (rest.length ? `<optgroup label="다른 반">${rest.map(k => `<option value="${k.id}" ${s.assign[p.id] === k.id ? 'selected' : ''}>${esc(k.name)} (${esc(k.groupIds.map(org.groupLabel).join(', '))})</option>`).join('')}</optgroup>` : '');
      c.innerHTML = `<div class="nm"><span class="dot" style="background:${color(p)}"></span>
          <select aria-label="${esc(p.label)} 이름"><option value="">${esc(p.label)}</option>${opts}<option value="__new">+ 새 아이 추가…</option></select></div>
        <div class="row">뛴 거리 <b>${Math.round(p.distance)} m</b></div>
        <div class="bar"><i style="width:${(p.distance / maxD) * 100}%;background:${color(p)}"></i></div>
        <div class="row">최고 속도 <b>${(p.topSpeed * 3.6).toFixed(1)} km/h</b></div>
        <div class="row">전력질주 <b>${p.sprints}회</b></div>
        <div class="row">공 소유 <span class="beta">베타</span> <b>${p.possession.toFixed(0)}초 · ${p.touches}번</b></div>
        <div class="row">패스 보냄/받음 <span class="beta">베타</span> <b>${p.passes} / ${p.received}</b></div>
        <canvas aria-label="${esc(label(p))} 히트맵"></canvas>`;
      const selEl = c.querySelector('select');
      selEl.onclick = e => e.stopPropagation(); selEl.onkeydown = e => e.stopPropagation();
      selEl.onchange = () => assign(p, selEl.value);
      const pick = () => { sel = sel === p.id ? null : p.id; renderCards(); redraw(); };
      c.onclick = pick; c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      el.append(c);
      const cv = c.querySelector('canvas'), w = cv.clientWidth, ctx = fit(cv, w, courtHeight(w, L, W)), { s: sc, pad } = drawCourt(ctx, w, L, W);
      ctx.drawImage(heatOf(p.id), pad, pad, L * sc, W * sc);
    }
    if (busy) el.querySelectorAll('select').forEach(x => { x.disabled = true; });
  }

  // ---------- 검수·교정 ----------
  // 원본(originalResult)은 첫 교정 때 한 번만 보존하고 원본 복원 뒤에도 남긴다. 교정마다 직전 결과를 reviewHistory(최대 10개)에 쌓아
  // 직전 취소에 쓰고, 사용자 교정 기록은 reviewEdits. 원본 복원은 history·edits를 비운다.
  // 저장은 모두 commit()으로: 줄 세워 최신 세션 위에 저장하고, 성공하면 보던 시각 그대로 화면을 다시 그린다(카드·보드·전술이 새 결과로).
  // 저장이 실패하면 세션·화면은 그대로(저장 성공 전에는 아무것도 안 바꿈) 두고 알림만. 결과 객체는 원본·스냅샷이 같이 가리킬 수 있어 제자리 수정 금지.
  const selA = $('#rvA'), selB = $('#rvB'), inS = $('#rvStart'), inE = $('#rvEnd'), msgEl = $('#rvMsg');
  const fmtS = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const nameOf = p => (label(p) === p.label ? p.label : `${label(p)} (${p.label})`);
  const numIn = el => (el.value.trim() === '' ? NaN : +el.value); // 빈 칸은 0초가 아니라 '없음'
  const pickNum = el => (el.value === '' ? NaN : +el.value);
  const setSel = (el, val) => { if ([...el.options].some(o => o.value === String(val))) el.value = String(val); };
  const swappable = T.map((_, t) => P.filter(p => p.team === t).length >= 2);
  let segs = [], segAll = 0, segErr = null, picked = null; // picked: 고른 후보 번호 (이름을 바꿔 목록을 다시 그려도 유지)
  try { segs = findReviewSegments(R); segAll = findReviewSegments(R, { limit: Infinity }).length; } catch (e) { segErr = e.message; }
  const canFix = !segErr && swappable.some(Boolean);
  $('#rvLimits').textContent = `확인해 볼 곳은 심한 순으로 최대 ${REVIEW_RULES.limit}곳까지 보여 주고, 직전 취소는 최근 ${HISTORY}번까지 돼요.`;
  inS.max = inE.max = R.duration;
  function rvMsg(text, err = false, focus = false) { msgEl.textContent = text; msgEl.classList.toggle('err', err); if (focus) msgEl.focus({ preventScroll: true }); }
  function sync() {
    for (const el of [selA, selB, inS, inE, $('#rvStartNow'), $('#rvEndNow'), $('#rvSwap')]) el.disabled = busy || !canFix;
    $('#rvUndo').disabled = busy || !s.reviewHistory?.length;
    $('#rvRestore').disabled = busy || !s.originalResult || !(s.reviewEdits?.length || s.reviewHistory?.length);
    $('#bDelete').disabled = busy;
    $('#bSaveFile').disabled = busy;
    document.querySelectorAll('#cards select').forEach(el => { el.disabled = busy; });
  }
  function fillB(keep) {
    const a = P[pickNum(selA)], ps = a ? P.filter(p => p.team === a.team && p.id !== a.id) : [];
    selB.innerHTML = ps.map(p => `<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');
    if (keep != null) setSel(selB, keep);
  }
  selA.onchange = () => fillB(selB.value);
  function renderReview() {
    $('#rvCount').textContent = segErr ? '' : segAll > segs.length ? `심한 순 ${segs.length}곳 · 전체 ${segAll}곳` : `${segs.length}곳`;
    const list = $('#rvList');
    list.innerHTML = segErr ? `<p class="err">${esc(segErr)}</p>` : segs.length ? '' : '<p class="empty">자동으로 찾은 확인할 곳이 없어요.</p>';
    segs.forEach((g, k) => {
      const p = P[g.playerId], b = document.createElement('button');
      b.type = 'button'; b.className = 'rv-item' + (k === picked ? ' on' : ''); b.setAttribute('aria-pressed', k === picked);
      Object.assign(b.dataset, { k, player: g.playerId, start: g.start, end: g.end, reason: g.reason });
      b.innerHTML = `<span class="rv-t">${fmtS(g.start)}–${fmtS(g.end)}</span><span class="dot" style="background:${color(p)}"></span><b>${esc(nameOf(p))}</b><span class="rv-why ${esc(g.reason)}">${esc(REVIEW_REASONS[g.reason] ?? g.reason)}</span>`;
      b.onclick = () => pickSeg(k);
      list.append(b);
    });
    const a0 = selA.value, b0 = selB.value; // 이름이 바뀌어 다시 그려도 고른 선수는 유지
    selA.innerHTML = T.map((t, k) => (swappable[k] ? `<optgroup label="${esc(t.name)}">${P.filter(p => p.team === k).map(p => `<option value="${p.id}">${esc(nameOf(p))}</option>`).join('')}</optgroup>` : '')).join('');
    setSel(selA, a0); fillB(b0);
    const ed = s.reviewEdits || [];
    $('#rvEditCount').textContent = [ed.length ? `${ed.length}건` : '', s.originalResult ? '원본 보관 중' : ''].filter(Boolean).join(' · ');
    $('#rvEdits').innerHTML = ed.length
      ? ed.map(e => `<li><b>${esc(P[e.playerA] ? nameOf(P[e.playerA]) : e.playerA)} ↔ ${esc(P[e.playerB] ? nameOf(P[e.playerB]) : e.playerB)}</b> · ${fmtS(e.start)}–${fmtS(e.end)}</li>`).join('')
      : '<li>아직 교정하지 않았어요.</li>';
    sync();
  }
  // 후보를 누르면 그 장면으로 가고, 바로잡기 칸에 그 아이와 후보 위치를 채운다. 후보 구간은 "확인할 위치"일 뿐이라
  // 실제로 번호가 바뀐 구간(대개 그때부터 다시 바뀔 때까지)은 사람이 영상을 보고 정한다 — 끝까지 자동으로 늘리지 않음
  function pickSeg(k) {
    const g = segs[k], p = P[g.playerId];
    setT(g.start); picked = k;
    document.querySelectorAll('#rvList .rv-item').forEach(el => { const on = +el.dataset.k === k; el.classList.toggle('on', on); el.setAttribute('aria-pressed', on); });
    if (!canFix || !swappable[p.team]) return rvMsg(`${nameOf(p)}의 팀에는 바꿀 같은 팀 아이가 없어요.`, true);
    if (busy) return;
    setSel(selA, p.id); fillB(selB.value); inS.value = g.start; inE.value = g.end;
    rvMsg('채운 시각은 확인할 위치예요. 영상을 보고 실제로 번호가 바뀐 시작·끝을 직접 맞춰 주세요(현재 시각 버튼).');
  }
  // 영상 시각은 분석 끝보다 길 수 있고, 분석 길이(duration)는 실제 영상 프레임 시각이라 dt 배수가 아닐 수 있다(예: 60.066666초).
  // 그래서 duration으로 자르지 않고 마지막 유효 격자 칸(floor(duration/dt)) 이하의 칸으로 묶어 그 칸 시각을 준다 → 끝에서 눌러도 구간 검사에 안 걸림
  const lastK = Math.max(0, Math.min(N - 1, Math.floor(R.duration / dt + 1e-9)));
  const snapT = () => +(Math.max(0, Math.min(lastK, Math.round(getT() / dt))) * dt).toFixed(3);
  $('#rvStartNow').onclick = () => { inS.value = snapT(); };
  $('#rvEndNow').onclick = () => { inE.value = snapT(); };
  // mutate(최신 세션) → [새 세션, 알림]. 던지면(검사 실패) 저장하지 않는다
  async function commit(mutate) {
    if (busy || left) return; // 중복 클릭·떠난 화면 방지
    busy = true; sync(); rvMsg('저장 중…');
    let flash;
    try {
      await queue(async () => {
        if (left) return;
        const cur = await latest(id); // 화면의 s가 아니라 최신 세션 위에 (이름 변경 등을 덮어쓰지 않게)
        if (!cur) throw new Error('이 수업 기록이 지워져서 저장하지 않았어요');
        const [next, m] = mutate(cur);
        try { await store.putSession(next); } catch (e) { throw new Error('저장하지 못했어요: ' + e.message); }
        s = next; flash = m;
      });
    } catch (e) {
      if (left) return;
      busy = false; sync(); rvMsg(e.message, true, true); return;
    }
    if (left) return; // 그사이 다른 화면으로 갔으면 다시 그리지 않음
    const y = scrollY;
    try { if (await renderSession(id, { t: getT(), playing: url ? !v.paused : playing, sel, flash })) scrollTo(0, y); } // 그사이 떠났으면(false) 남의 화면 스크롤은 그대로
    catch (e) { console.error(e); dispatchEvent(new HashChangeEvent('hashchange')); } // 다시 그리기 실패는 라우터가 오류 화면으로
  }
  $('#rvSwap').onclick = () => {
    const a = pickNum(selA), b = pickNum(selB), start = numIn(inS), end = numIn(inE);
    commit(cur => {
      const next = swapPlayerSegment(cur.result, { playerA: a, playerB: b, start, end }); // 값이 잘못되면 한국어 오류 → 저장 안 함
      const e = next.reviewEdits[next.reviewEdits.length - 1]; // 실제로 바뀐 칸(격자에 맞춘 초)
      return [{
        ...cur, result: next,
        originalResult: cur.originalResult ?? cur.result, // 첫 교정 때 한 번만
        reviewHistory: [...(cur.reviewHistory || []), cur.result].slice(-HISTORY),
        reviewEdits: [...(cur.reviewEdits || []), { type: 'swap', playerA: a, playerB: b, start: e.start, end: e.end, at: new Date().toISOString() }],
      }, `${nameOf(P[a])} ↔ ${nameOf(P[b])}: ${fmtS(e.start)}–${fmtS(e.end)} 경로를 맞바꾸고 통계를 다시 계산했어요.`];
    });
  };
  $('#rvUndo').onclick = () => commit(cur => {
    const h = cur.reviewHistory || [], ed = cur.reviewEdits || [], e = ed[ed.length - 1];
    if (!h.length) throw new Error('취소할 교정이 없어요');
    return [{ ...cur, result: h[h.length - 1], reviewHistory: h.slice(0, -1), reviewEdits: ed.slice(0, -1) },
      e && P[e.playerA] && P[e.playerB] ? `직전 교정(${nameOf(P[e.playerA])} ↔ ${nameOf(P[e.playerB])})을 취소했어요.` : '직전 교정을 취소했어요.'];
  });
  $('#rvRestore').onclick = async () => {
    if (busy || left) return;
    if (!(await ask('자동 분석 원본으로 되돌릴까요? 교정 기록과 직전 취소 기록이 모두 지워져요. 원본은 계속 보관돼요.', { ok: '원본 복원' })) || left) return;
    commit(cur => {
      if (!cur.originalResult) throw new Error('보관된 원본이 없어요');
      return [{ ...cur, result: cur.originalResult, reviewHistory: [], reviewEdits: [] }, '자동 분석 원본으로 되돌렸어요.'];
    });
  };

  // ---------- 교정 전후 비교 ----------
  // 보관한 원본(originalResult)이 있을 때만. 엔진 compareReviewResults(원본, 지금)가 두 결과를 같은 기준(저장된 경로)으로 다시 계산해
  // 선수마다 { id, team, label, before, after, delta }를 준다. 화면은 표시 단위로 반올림한 값끼리 비교해서 "412 → 412 (+1)" 같은 혼란이 없게 한다.
  const cmpFn = reviewApi.compareReviewResults;
  let cmpRows = null, cmpErr = null;
  if (s.originalResult) {
    if (typeof cmpFn !== 'function') cmpErr = '전후 비교 기능을 아직 준비 중이에요. 교정·직전 취소·원본 복원은 그대로 쓸 수 있어요.';
    else {
      try { cmpRows = cmpFn(s.originalResult, R); } catch (e) { cmpErr = '전후 비교를 만들지 못했어요: ' + e.message; }
      if (!cmpErr && !Array.isArray(cmpRows)) cmpErr = '전후 비교 결과의 모양이 예상과 달라요.';
    }
  }
  const nv = v => (typeof v === 'number' ? v : NaN), r1 = v => +nv(v).toFixed(1);
  const COLS = [ // 표시 단위 값 배열 (패스는 보냄/받음 두 값)
    { name: '뛴 거리', unit: 'm', get: x => [Math.round(nv(x.distance))] },
    { name: '최고 속도', unit: 'km/h', dec: 1, get: x => [r1(nv(x.topSpeed) * 3.6)] },
    { name: '전력질주', unit: '회', get: x => [nv(x.sprints)] },
    { name: '공 소유', unit: '초', dec: 1, get: x => [r1(x.possession)] },
    { name: '터치', unit: '번', get: x => [nv(x.touches)] },
    { name: '패스', unit: '보냄/받음', get: x => [nv(x.passes), nv(x.received)] },
  ];
  const fmtN = (v, dec) => (Number.isFinite(v) ? (dec ? v.toFixed(dec) : String(v)) : '–');
  const same = (a, b) => a === b || (!Number.isFinite(a) && !Number.isFinite(b));
  const signed = (d, dec) => (Number.isFinite(d) ? (d > 0 ? '+' : d < 0 ? '−' : '') + fmtN(Math.abs(d), dec) : '–');
  function cmpCell(col, a, b) {
    const shown = vals => vals.map(x => fmtN(x, col.dec)).join('/');
    if (a.every((x, k) => same(x, b[k]))) return `<td>${shown(a)}</td>`;
    return `<td><span class="cmp-v"><span class="sr">원본 </span>${shown(a)}<span aria-hidden="true"> → </span><span class="sr">, 교정 후 </span><b>${shown(b)}</b></span>` +
      ` <span class="cmp-d"><span class="sr">, 변화 </span>${b.map((x, k) => signed(x - a[k], col.dec)).join('/')}</span></td>`;
  }
  function renderCompare() {
    const panel = $('#cmpPanel'), msg = $('#cmpMsg'), wrap = $('#cmpWrap'), sum = $('#cmpSum');
    panel.hidden = !s.originalResult;
    if (panel.hidden) return;
    const say = (t, err = false) => { msg.textContent = t; msg.classList.toggle('err', err); };
    if (cmpErr) { say(cmpErr, true); wrap.hidden = true; sum.textContent = ''; return; }
    const rows = cmpRows.map(r => {
      const before = r?.before || {}, after = r?.after || {}, p = P[r?.id];
      const cells = COLS.map(c => [c.get(before), c.get(after)]);
      const changed = cells.some(([a, b]) => a.some((x, k) => !same(x, b[k])));
      return { r, p, cells, changed, w: Math.abs(nv(after.distance) - nv(before.distance)) || 0 };
    });
    const changed = rows.filter(x => x.changed).sort((a, b) => b.w - a.w || a.r.id - b.r.id);
    sum.textContent = `숫자가 바뀐 아이 ${changed.length}명 · 전체 ${rows.length}명`;
    if (!changed.length) {
      wrap.hidden = true;
      say(s.reviewEdits?.length ? '교정했지만 숫자가 바뀐 아이는 없어요.' : '원본과 차이가 없어요. 지금 결과가 자동 분석 원본 그대로예요.');
      return;
    }
    say(''); wrap.hidden = false;
    const name = x => (x.p ? nameOf(x.p) : String(x.r?.label ?? `선수 ${x.r?.id}`));
    $('#cmpTable').innerHTML = '<caption class="sr">교정 전후 비교. 바뀐 칸은 원본, 교정 후, 변화 순서로 읽어요. 바뀐 아이가 위에 있어요.</caption>' +
      `<thead><tr><th scope="col">아이</th>${COLS.map(c => `<th scope="col">${c.name} <small>${c.unit}</small></th>`).join('')}</tr></thead><tbody>` +
      [...changed, ...rows.filter(x => !x.changed)].map(x => `<tr class="${x.changed ? 'chg' : 'same'}"><th scope="row">` +
        `<span class="dot" style="background:${x.p ? color(x.p) : '#9aa59f'}"></span><span class="cmp-name" title="${esc(name(x))}">${esc(name(x))}</span>` +
        `${x.changed ? '<span class="cmp-badge">바뀜</span>' : ''}</th>${x.cells.map(([a, b], k) => cmpCell(COLS[k], a, b)).join('')}</tr>`).join('') + '</tbody>';
  }

  // ---------- 패스 연결 ----------
  function drawPassNets() {
    const el = $('#passNets'); el.innerHTML = '';
    T.forEach((t, team) => {
      const ps = P.filter(p => p.team === team);
      if (ps.length < 2) return;
      const f = document.createElement('figure'), passes = R.passes.filter(x => P[x.from].team === team);
      f.innerHTML = `<figcaption>${esc(t.name)} · 패스 ${passes.length}번</figcaption><canvas></canvas>`;
      el.append(f);
      const cv = f.querySelector('canvas'), w = cv.clientWidth, ctx = fit(cv, w, courtHeight(w, L, W)), { X } = drawCourt(ctx, w, L, W);
      const mean = p => { let sx = 0, sy = 0; for (let i = 0; i < N; i++) { sx += p.path[2 * i]; sy += p.path[2 * i + 1]; } return [X(sx / N), X(sy / N)]; };
      const at = Object.fromEntries(ps.map(p => [p.id, mean(p)])), cnt = {};
      passes.forEach(x => { const k = [x.from, x.to].sort((a, b) => a - b).join('-'); cnt[k] = (cnt[k] || 0) + 1; });
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [k, n] of Object.entries(cnt)) {
        const [a, b] = k.split('-').map(Number);
        ctx.lineWidth = 1 + n * 1.5; ctx.beginPath(); ctx.moveTo(...at[a]); ctx.lineTo(...at[b]); ctx.stroke();
        ctx.fillText(n, (at[a][0] + at[b][0]) / 2, (at[a][1] + at[b][1]) / 2 - 8);
      }
      for (const p of ps) {
        const [x, y] = at[p.id];
        ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.fillStyle = t.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(num(p), x, y + 0.5);
        ctx.font = '11px sans-serif'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(label(p), x, y + 20); ctx.shadowBlur = 0; ctx.font = 'bold 11px sans-serif';
      }
    });
    if (!el.children.length) el.innerHTML = '<p class="empty">팀마다 2명 이상일 때 보여요.</p>';
  }

  // ---------- 그리기 루프 ----------
  let last = -1, raf = 0;
  function redraw() { last = -1; }
  function loop(now) {
    // 첫 프레임은 기준만 잡는다: 재생 중 교정·취소로 다시 그리면 바로 재생 상태라, 0을 기준으로 두면 페이지가 열린 뒤 시간(now)이 통째로 더해져 끝으로 튐
    if (!url && playing && lastNow != null) { ct = Math.min(R.duration, ct + Math.max(0, now - lastNow) / 1000); if (ct >= R.duration) playing = false; }
    lastNow = now;
    const t = getT(), i = idxAt(t);
    $('#bPlay').textContent = (url ? !v.paused : playing) ? '❚❚' : '▶';
    if (document.activeElement !== clock) clock.value = t;
    $('#clockTxt').textContent = `${fmtTime(t)} / ${fmtTime(R.duration)}`;
    if (i !== last) { last = i; drawBoard(i); drawOverlay(i); drawSpread(i); }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  const onResize = () => { renderCards(); drawPassNets(); redraw(); };
  addEventListener('resize', onResize);
  v.addEventListener('loadedmetadata', redraw);
  stop = () => { // 떠날 때 (맨 위 onLeave가 부름)
    cancelAnimationFrame(raf); removeEventListener('resize', onResize);
    v.removeEventListener('loadedmetadata', redraw); if (resume) v.removeEventListener('loadedmetadata', resume);
    v.pause();
  };
  renderCards(); drawPassNets(); renderReview(); renderCompare();
  if (opts.flash) rvMsg(opts.flash, false, true); // 저장 뒤 다시 그리면 알림으로 포커스 (키보드·화면 읽기 사용자)
  else if (!segErr && !canFix) rvMsg('같은 팀에 아이가 2명 이상일 때만 바꿀 수 있어요.');
  return true;
}
