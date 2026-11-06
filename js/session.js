// 수업 결과 화면: 영상·전술 보드·팀 간격·아이 카드·패스 연결
import { $, mount, onLeave, esc, ask, sessionVideos } from './app.js';
import * as store from './store.js';
import { fit, drawCourt, courtHeight, heatCanvas, fmtTime } from './court.js';
import { homography, applyH } from './vision.js';

export async function renderSession(id) {
  mount('t-session');
  let [s, kids] = await Promise.all([store.getSession(id), store.listKids()]);
  if (!s) throw new Error('이 수업 기록을 찾을 수 없어요');
  const R = s.result, P = R.players, [L, W] = R.court, dt = R.dt, N = P[0].path.length / 2, T = R.teams;
  const color = p => T[p.team].color, num = p => p.label.split(' ').pop();
  const label = p => kids.find(k => k.id === s.assign[p.id])?.name || p.label;
  let sel = null; const show = { trail: true, ball: true, heat: false };

  $('#sTitle').textContent = s.title;
  $('#sMeta').textContent = `${s.date} · ${fmtTime(R.duration)} · 아이 ${P.length}명`;
  $('#bDelete').onclick = async () => {
    if (!(await ask(`'${s.title}' 기록을 지울까요? 되돌릴 수 없어요.`, { ok: '지우기' }))) return;
    await store.deleteSession(id); sessionVideos.delete(id); location.hash = '#home';
  };
  $('#assumeNote').textContent = `거리·속도는 코트 ${L}×${W}m 기준 추정치예요. 아이가 가려져 위치를 놓친 시간 ${(R.hiddenRate * 100).toFixed(1)}% · 같은 팀 아이끼리 겹쳤다 떨어지면 번호가 바뀔 수 있어요.`;

  // ---------- 시계: 영상이 있으면 영상 시간, 없으면 보드 자체 재생 ----------
  const v = $('#sv');
  let url = sessionVideos.get(id), ct = 0, playing = false, lastNow = 0;
  const attach = u => { url = u; sessionVideos.set(id, u); v.src = u; $('#videoPanel').hidden = false; $('#linkVideo').hidden = true; };
  if (url) attach(url); else $('#videoPanel').hidden = true;
  $('#fLink').onchange = e => { const f = e.target.files[0]; if (f) attach(URL.createObjectURL(f)); };
  const getT = () => (url ? v.currentTime : ct);
  const setT = t => { t = Math.max(0, Math.min(R.duration, t)); if (url) v.currentTime = t; else ct = t; };
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
  const sp = $('#spread'), M = 30;
  function drawSpread(i) {
    const w = sp.clientWidth, h = 130, ctx = fit(sp, w, h);
    if (!spreadTeams.length) { ctx.fillStyle = '#66706c'; ctx.font = '12px sans-serif'; ctx.fillText('팀마다 2명 이상일 때 보여요', 8, 20); return; }
    const mx = Math.max(...spreadTeams.flatMap(t => spread[t])) * 1.1, Y = val => h - 18 - (val / mx) * (h - 28);
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
    if (value === '__new') {
      const name = await ask('새 아이 이름', { input: '' });
      if (!name) return renderCards();
      const k = { id: store.uid(), name }; await store.putKid(k); kids = await store.listKids(); value = k.id;
    }
    const a = { ...s.assign };
    for (const [pid, kid] of Object.entries(a)) if (kid === value) delete a[pid]; // 한 아이는 한 자리에만
    if (value) a[p.id] = value; else delete a[p.id];
    s = { ...s, assign: a }; await store.putSession(s);
    renderCards(); redraw(); drawPassNets();
  }
  function renderCards() {
    const el = $('#cards'); el.innerHTML = '';
    for (const p of [...P].sort((a, b) => b.distance - a.distance)) {
      const c = document.createElement('div'); c.className = 'card' + (sel === p.id ? ' sel' : '');
      c.tabIndex = 0; c.setAttribute('role', 'button'); c.setAttribute('aria-pressed', sel === p.id);
      const opts = kids.map(k => `<option value="${k.id}" ${s.assign[p.id] === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
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
    if (!url && playing) { ct = Math.min(R.duration, ct + (now - lastNow) / 1000); if (ct >= R.duration) playing = false; }
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
  onLeave(() => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); v.pause(); });
  renderCards(); drawPassNets();
}
