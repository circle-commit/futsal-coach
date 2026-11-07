// 전술 분석 화면: 영상 위 팀 영역, 경기장 지도, 맞대결 지표, 영역 그래프, 뛴 거리 순위
import { $, mount, onLeave, esc, sessionVideos, orgIndex } from './app.js';
import * as store from './store.js';
import { fit, drawCourt, courtHeight, fmtTime } from './court.js';
import { homography, applyH } from './vision.js';
import { computeTactics } from './tactics.js';

const hexA = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

export async function renderTactics(id) {
  mount('t-tactics');
  const [s, kids, org] = await Promise.all([store.getSession(id), store.listKids(), orgIndex()]);
  if (!s) throw new Error('이 수업 기록을 찾을 수 없어요');
  const R = s.result, P = R.players, [L, W] = R.court, dt = R.dt, T = R.teams;
  const tc = computeTactics(R), [A, B] = tc.teams, N = tc.N;
  let last = -1;
  const name = p => kids.find(k => k.id === s.assign[p.id])?.name || p.label;
  const num = p => (tc.gk[p.team] === p.id ? 'GK' : p.label.split(' ').pop());
  const col = t => T[t].color;
  $('#tBack').href = '#s-' + id;
  $('#tTeams').innerHTML = [A, B].filter(t => t != null).map(t => `<span class="dot" style="background:${col(t)}"></span>${esc(T[t].name)}`).join(' <i>vs</i> ');
  $('#tSub').textContent = `${org.groupLabel(s.groupId)} · ${s.date}`;
  $('#tMapSize').textContent = `${L} × ${W} m`;

  // ---------- 시계 ----------
  const v = $('#tv'); let url = sessionVideos.get(id), ct = 0, playing = false, lastNow = 0;
  const attach = u => { url = u; sessionVideos.set(id, u); v.src = u; $('#tVideoBox').hidden = false; $('#tLink').hidden = true; last = -1; };
  if (url) attach(url); else $('#tVideoBox').hidden = true;
  $('#tFile').onchange = e => { const f = e.target.files[0]; if (f) attach(URL.createObjectURL(f)); };
  const getT = () => (url ? v.currentTime : ct);
  const setT = t => { t = Math.max(0, Math.min(R.duration, t)); if (url) v.currentTime = t; else ct = t; };
  const clock = $('#tClock'); clock.max = R.duration; clock.oninput = () => setT(+clock.value);
  $('#tPlay').onclick = () => { if (url) (v.paused ? v.play() : v.pause()); else playing = !playing; };

  // ---------- 영상 위 팀 영역 ----------
  const Hp = homography([[0, 0], [L, 0], [L, W], [0, W]], R.video.corners);
  function drawOverlay(i) {
    if (!url) return;
    const ov = $('#tov'), vw = v.clientWidth, vh = v.clientHeight, ctx = fit(ov, vw, vh); ov.style.height = '100%';
    const ar = R.video.width / R.video.height, dw = Math.min(vw, vh * ar), dh = dw / ar, ox = (vw - dw) / 2, oy = (vh - dh) / 2, k = dw / R.video.width;
    const at = ([x, y]) => { const [px, py] = applyH(Hp, x, y); return [ox + px * k, oy + py * k]; };
    for (const t of [A, B]) {
      const h = tc.hulls[t]?.[i]; if (!h || h.length < 3) continue;
      ctx.beginPath(); h.map(at).forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = hexA(col(t), 0.18); ctx.fill(); ctx.strokeStyle = col(t); ctx.lineWidth = 2.5; ctx.stroke();
    }
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of P) {
      const [x, y] = at([p.path[2 * i], p.path[2 * i + 1]]), lab = num(p), w = ctx.measureText(lab).width + 8;
      ctx.fillStyle = col(p.team); ctx.fillRect(x - w / 2, y - 26, w, 16);
      ctx.fillStyle = '#fff'; ctx.fillText(lab, x, y - 18);
    }
  }

  // ---------- 경기장 지도 ----------
  function drawMap(i) {
    const c = $('#tMap'), w = c.clientWidth, ctx = fit(c, w, courtHeight(w, L, W)), { X } = drawCourt(ctx, w, L, W);
    for (const t of [A, B]) {
      const h = tc.hulls[t]?.[i]; if (!h || h.length < 3) continue;
      ctx.beginPath(); h.forEach(([x, y], j) => (j ? ctx.lineTo(X(x), X(y)) : ctx.moveTo(X(x), X(y)))); ctx.closePath();
      ctx.fillStyle = hexA(col(t), 0.22); ctx.fill(); ctx.strokeStyle = col(t); ctx.lineWidth = 2; ctx.stroke();
    }
    const bx = R.ball[2 * i];
    if (bx != null) { ctx.beginPath(); ctx.arc(X(bx), X(R.ball[2 * i + 1]), 4, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); }
    ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of P) {
      const x = X(p.path[2 * i]), y = X(p.path[2 * i + 1]);
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fillStyle = col(p.team); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(num(p), x, y + 0.5);
    }
  }

  // ---------- 맞대결 ----------
  const ROWS = [['폭', 'width', 'm', 1], ['깊이', 'depth', 'm', 1], ['차지한 면적', 'area', 'm²', 0], ['수비 라인', 'defLine', 'm', 1], ['뛴 거리', 'dist', 'km', 2], ['간격', 'compact', 'm', 1]];
  const teamDist = (t, i) => P.filter(p => p.team === t).reduce((a, p) => a + tc.cum[p.id][i], 0) / 1000;
  function drawH2H(i) {
    if (B == null) { $('#tH2H').innerHTML = '<p class="empty">두 팀이 있어야 비교할 수 있어요.</p>'; return; }
    $('#tH2H').innerHTML = ROWS.map(([lab, key, unit, d]) => {
      const a = key === 'dist' ? teamDist(A, i) : tc.metrics[A][key][i], b = key === 'dist' ? teamDist(B, i) : tc.metrics[B][key][i], mx = Math.max(a, b, 1e-6);
      return `<div class="h2h"><b>${a.toFixed(d)} ${unit}</b><div class="h2h-mid"><span>${lab}</span><div class="h2h-bars"><div class="l"><i style="width:${(a / mx) * 100}%;background:${col(A)}"></i></div><div><i style="width:${(b / mx) * 100}%;background:${col(B)}"></i></div></div></div><b>${b.toFixed(d)} ${unit}</b></div>`;
    }).join('');
  }

  // ---------- 점유율 (베타) ----------
  function drawPoss(i) {
    let a = 0, b = 0; for (let k = 0; k <= i; k++) { if (tc.ownerTeam[k] === A) a++; else if (tc.ownerTeam[k] === B) b++; }
    const pa = a + b ? Math.round((a / (a + b)) * 100) : 50;
    $('#tPossA').textContent = pa + '%'; $('#tPossB').textContent = 100 - pa + '%';
    $('#tPossBar').innerHTML = `<i style="width:${pa}%;background:${col(A)}"></i><i style="width:${100 - pa}%;background:${col(B ?? A)}"></i>`;
  }

  // ---------- 영역 그래프 + 공 띠 ----------
  const areaMax = Math.max(1, ...[A, B].filter(t => t != null).flatMap(t => Array.from(tc.metrics[t].area))) * 1.1;
  function drawArea(i) {
    const c = $('#tArea'), w = c.clientWidth, h = 190, ctx = fit(c, w, h), M = 40, top = 8, bot = 44;
    const X = k => M + (k / (N - 1)) * (w - M - 8), Y = a => top + (1 - a / areaMax) * (h - top - bot);
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#8b968f'; ctx.textAlign = 'right';
    const step = areaMax > 400 ? 100 : areaMax > 150 ? 50 : 20;
    for (let a = 0; a < areaMax; a += step) { ctx.fillText(a, M - 6, Y(a) + 3); ctx.fillStyle = '#26302b'; ctx.fillRect(M, Y(a), w - M - 8, 1); ctx.fillStyle = '#8b968f'; }
    ctx.textAlign = 'center';
    for (let m = 0; m * 60 <= R.duration; m++) ctx.fillText(fmtTime(m * 60), X((m * 60) / dt), h - 4);
    for (const t of [A, B]) {
      if (t == null) continue;
      ctx.beginPath(); ctx.strokeStyle = col(t); ctx.lineWidth = 2;
      for (let k = 0; k <= i; k += 2) (k ? ctx.lineTo(X(k), Y(tc.metrics[t].area[k])) : ctx.moveTo(X(k), Y(tc.metrics[t].area[k])));
      ctx.stroke();
      ctx.fillStyle = col(t); ctx.textAlign = 'left'; ctx.fillText(Math.round(tc.metrics[t].area[i]), X(i) + 5, Y(tc.metrics[t].area[i]) + 3); ctx.textAlign = 'center';
    }
    // 공 띠: 1초마다 공을 가진 팀 색
    ctx.fillStyle = '#8b968f'; ctx.textAlign = 'right'; ctx.fillText('공', M - 6, h - bot + 20);
    const per = Math.round(1 / dt);
    for (let k = 0; k <= i; k += per) {
      const own = tc.ownerTeam[k]; if (own !== A && own !== B) continue;
      ctx.fillStyle = col(own); ctx.fillRect(X(k), h - bot + 13, Math.max(1, X(k + per) - X(k) - 1), 9);
    }
    // 공 있을 때 / 없을 때 평균 면적
    $('#tWith').innerHTML = [A, B].filter(t => t != null).map(t => {
      const other = t === A ? B : A; let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
      for (let k = 0; k <= i; k++) { const o = tc.ownerTeam[k], a = tc.metrics[t].area[k]; if (o === t) { s1 += a; n1++; } else if (o === other) { s2 += a; n2++; } }
      return `<div><span class="dot" style="background:${col(t)}"></span> ${esc(T[t].name)}<br><b>${n1 ? Math.round(s1 / n1) : '–'} / ${n2 ? Math.round(s2 / n2) : '–'} m²</b></div>`;
    }).join('');
  }

  // ---------- 뛴 거리 순위 ----------
  function drawTop(i) {
    const top = [...P].sort((a, b) => tc.cum[b.id][i] - tc.cum[a.id][i]).slice(0, 4), mx = Math.max(1, tc.cum[top[0].id][i]);
    $('#tTop').innerHTML = top.map((p, k) => `<div class="top-row"><span>${k + 1}</span><span class="dot" style="background:${col(p.team)}"></span><span class="top-name">${esc(name(p))}</span>
      <div class="top-bar"><i style="width:${(tc.cum[p.id][i] / mx) * 100}%;background:${col(p.team)}"></i></div><b>${Math.round(tc.cum[p.id][i])} m</b></div>`).join('');
  }

  // ---------- 루프 ----------
  let raf = 0;
  function loop(now) {
    if (!url && playing) { ct = Math.min(R.duration, ct + (now - lastNow) / 1000); if (ct >= R.duration) playing = false; }
    lastNow = now;
    const t = getT(), i = Math.max(0, Math.min(N - 1, Math.round(t / dt)));
    $('#tPlay').textContent = (url ? !v.paused : playing) ? '❚❚' : '▶';
    if (document.activeElement !== clock) clock.value = t;
    $('#tTime').textContent = fmtTime(t); $('#tDur').textContent = `/ ${fmtTime(R.duration)}`;
    if (i !== last) { last = i; drawOverlay(i); drawMap(i); drawH2H(i); drawPoss(i); drawArea(i); drawTop(i); }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  const onResize = () => { last = -1; };
  addEventListener('resize', onResize);
  onLeave(() => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); v.pause(); });
}
