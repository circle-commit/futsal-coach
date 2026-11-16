// 새 수업 분석: 영상 고르기 → 코트 모서리 → 팀 색 → 작업 설정 파일 받기(기본: 이 컴퓨터에서 따로 분석) 또는 이 브라우저에서 바로 분석
import { $, mount, onLeave, sessionVideos, ask, esc, orgIndex, downloadJSON } from './app.js';
import { procSize, frameAt, buildBackground, runAnalysis } from './analyzer.js';
import { setup, teamGate, DEFAULT_ENGINE } from './pipeline.js';
import { detect, colorFromClick } from './vision.js';
import { fmtTime } from './court.js';
import * as store from './store.js';

const CORNER = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

// 로컬 분석 안내에 보여 줄 예시 명령. 엔진 담당의 분석 도구(경로·인수 순서)와 맞아야 하며, 바뀌면 여기만 고친다.
const LOCAL_TOOL = 'tools/analyze.mjs';
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX 셸 작은따옴표: 공백·따옴표·$·백틱이 든 파일 이름도 글자 그대로
const localCommand = (video, job, out) => ['node', LOCAL_TOOL, shq(video), shq(job), shq(out)].join(' ');
// 파일 이름에 못 쓰는 글자·공백은 _로 (한글은 그대로)
const safeName = s => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60);

export async function renderNew() {
  mount('t-new');
  const st = { url: null, w: 0, h: 0, frame: null, corners: [], teams: [], bg: null, bgP: null, s: null, abort: null, sourceName: '' };
  let left = false, jobBusy = false; // left: 다른 화면으로 감 (불러오는 중에도)
  onLeave(() => { left = true; st.abort?.abort(); });
  const org = await orgIndex();
  if (left) return;
  const video = $('#vid');
  $('#date').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (현지 날짜)

  const step = n => {
    view('[data-step]').forEach(el => { el.hidden = +el.dataset.step !== n; });
    view('#steps li').forEach(li => { li.className = +li.dataset.s === n ? 'on' : +li.dataset.s < n ? 'done' : ''; });
  };
  function view(sel) { return document.querySelectorAll('#view ' + sel); }

  // ---------- 1. 학교·반, 영상 ----------
  const selS = $('#selSchool'), selG = $('#selGroup');
  let lastGroup = null; try { lastGroup = localStorage.getItem('futsal-last-group'); } catch {}
  const schools = () => org.schools.filter(x => x.id !== store.UNSORTED);
  function fillSchools(pick) {
    selS.innerHTML = '<option value="">학교 고르기</option>' + schools().map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('') + '<option value="__new">+ 새 학교…</option>';
    selS.value = pick ?? '';
    fillGroups();
  }
  function fillGroups(pick) {
    const gs = org.groups.filter(g => g.schoolId === selS.value);
    selG.disabled = !selS.value || selS.value === '__new';
    selG.innerHTML = '<option value="">반 고르기</option>' + gs.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('') + (selG.disabled ? '' : '<option value="__new">+ 새 반…</option>');
    selG.value = pick ?? (gs.length === 1 ? gs[0].id : '');
    const sc = org.school[selS.value];
    if (sc?.court) { $('#courtL').value = sc.court[0]; $('#courtW').value = sc.court[1]; }
  }
  selS.onchange = async () => {
    if (selS.value !== '__new') return fillGroups();
    const name = await ask('학교 이름', { input: '' });
    if (!name) return fillSchools();
    const sc = { id: store.uid(), name }; await store.putSchool(sc);
    org.schools.push(sc); org.school[sc.id] = sc; fillSchools(sc.id);
  };
  selG.onchange = async () => {
    if (selG.value !== '__new') return;
    const name = await ask(`${org.school[selS.value].name}에 만들 반 이름 (예: 3학년 2반)`, { input: '' });
    if (!name) return fillGroups();
    const g = { id: store.uid(), schoolId: selS.value, name }; await store.putGroup(g);
    org.groups.push(g); org.group[g.id] = g; fillGroups(g.id);
  };
  fillSchools(org.group[lastGroup] && org.group[lastGroup].schoolId !== store.UNSORTED ? org.group[lastGroup].schoolId : undefined);
  if (org.group[lastGroup] && selS.value) fillGroups(lastGroup);

  async function load(url, name = '') {
    $('#videoErr').textContent = '';
    if (!selG.value || selG.value === '__new') { $('#videoErr').textContent = '학교와 반을 먼저 골라 주세요.'; return; }
    st.groupId = selG.value; st.school = org.school[selS.value]; st.sourceName = name; // 원본 영상 파일 이름 (경로는 브라우저가 알 수 없음)
    if (st.url && !sessionVideos.has(st.url)) URL.revokeObjectURL(st.url);
    st.url = url; video.src = url;
    try {
      await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('이 영상을 열 수 없어요. mp4(H.264)로 바꿔서 다시 넣어 보세요.')); });
    } catch (e) { if (!left) $('#videoErr').textContent = e.message; return; }
    if (left) return; // 이하 떠난 뒤엔 화면을 건드리지 않음 (drawTeams·drawCorners도 left면 바로 끝남)
    [st.w, st.h] = procSize(video);
    // 빈 코트(배경)는 따로 만든 영상으로 미리 계산해 둔다
    const v2 = document.createElement('video'); v2.muted = true; v2.preload = 'auto'; v2.src = url;
    st.bgP = new Promise((res, rej) => { v2.onloadeddata = res; v2.onerror = () => rej(new Error('영상을 읽지 못했어요')); })
      .then(() => buildBackground(v2, p => { st.bgPct = p; drawTeams(); }))
      .then(bg => { st.bg = bg; v2.removeAttribute('src'); drawTeams(); return bg; });
    st.bgP.catch(e => { if (!left) $('#teamHint').textContent = '빈 코트를 만들지 못했어요: ' + e.message; });
    st.frame = await frameAt(video, Math.min(5, video.duration / 2));
    if (left) return;
    // 지난번 이 학교에서 찍은 모서리(화면 비율로 저장)를 불러온다. 드론 위치가 다르면 다시 찍으면 됨
    const c = st.school?.corners;
    st.cornersLoaded = !!c;
    if (c) st.corners = c.map(([x, y]) => [x * st.w, y * st.h]);
    step(2); drawCorners();
  }
  const fileIn = $('#fVideo'), drop = $('#drop');
  fileIn.onchange = () => fileIn.files[0] && load(URL.createObjectURL(fileIn.files[0]), fileIn.files[0].name);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) load(URL.createObjectURL(f), f.name); };
  // 개발용 샘플이 있으면 버튼을 보여 준다
  fetch('samples/sample.mp4', { method: 'HEAD' }).then(r => {
    if (!r.ok || left) return;
    $('#sampleWrap').hidden = false;
    $('#bSample').onclick = () => { load('samples/sample.mp4', 'sample.mp4'); $('#title').value = '샘플 수업'; $('#courtL').value = 35; $('#courtW').value = 13.7; };
  }).catch(() => {});

  // ---------- 2. 코트 모서리 ----------
  const cv = $('#cv');
  const toPx = (c, e) => { const r = c.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * st.w, ((e.clientY - r.top) / r.height) * st.h]; };
  function paintFrame(c) {
    c.width = st.w; c.height = st.h;
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(st.frame), st.w, st.h), 0, 0);
    return ctx;
  }
  function polygon(ctx, color) {
    const k = st.w / 640;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5 * k;
    ctx.beginPath(); st.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (st.corners.length === 4) ctx.closePath();
    ctx.stroke();
    st.corners.forEach(([x, y], i) => {
      ctx.beginPath(); ctx.arc(x, y, 6 * k, 0, 7); ctx.fill();
      ctx.font = `bold ${13 * k}px sans-serif`; ctx.fillText(CORNER[i], x + 8 * k, y - 8 * k);
    });
  }
  function drawCorners() {
    if (left) return;
    const ctx = paintFrame(cv);
    polygon(ctx, '#ffd400');
    const n = st.corners.length;
    $('#cornerHint').textContent = n < 4 ? `코트 라인의 ${CORNER[n]} 모서리를 눌러 주세요 (${n + 1}/4)`
      : st.cornersLoaded ? '지난번 이 학교에서 찍은 모서리를 불러왔어요. 노란 선이 코트 라인과 안 맞으면 다시 찍어 주세요.'
      : '네 모서리를 다 찍었어요. 코트 크기를 확인하고 다음을 눌러 주세요.';
    $('#bCornerNext').disabled = n < 4;
  }
  cv.onclick = e => { if (st.corners.length < 4) { st.corners.push(toPx(cv, e)); drawCorners(); } };
  $('#bCornerReset').onclick = () => { st.corners = []; st.cornersLoaded = false; drawCorners(); };
  const court = () => [+$('#courtL').value, +$('#courtW').value];
  $('#bCornerNext').onclick = async () => {
    const [L, W] = court();
    if (!(L >= 10 && W >= 5)) { $('#cornerHint').textContent = '코트 길이와 폭을 m 단위로 넣어 주세요.'; return; }
    st.s = null; step(3); drawTeams();
  };

  // ---------- 3. 팀 색 ----------
  const cv3 = $('#cv3');
  const cfg = () => ({ width: st.w, height: st.h, corners: st.corners, court: court(), teams: st.teams.map(({ name, color, hue, sat, mid, count }) => ({ name, color, hue, sat, mid, count })) });
  function drawTeams() {
    if (left || !st.frame || $('[data-step="3"]').hidden) return; // 배경 진행·장면 넘기기 콜백이 떠난 뒤에 와도 그리지 않음
    const ctx = paintFrame(cv3), k = st.w / 640;
    polygon(ctx, 'rgba(255,212,0,.6)');
    if (!st.bg) { $('#teamHint').textContent = `빈 코트를 만드는 중이에요 (${Math.round((st.bgPct || 0) * 100)}%). 잠시만 기다려 주세요.`; renderChips([]); return; }
    st.s ??= setup(cfg(), st.bg);
    st.s.det.teams = st.teams.map(teamGate);
    const d = st.teams.length ? detect(st.frame, st.s.det) : { players: [], ball: [] };
    d.players.forEach((list, t) => list.forEach(([x, y]) => {
      ctx.strokeStyle = st.teams[t].color; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.arc(x, y, 14 * k, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * k; ctx.stroke();
    }));
    $('#teamHint').textContent = st.teams.length ? '다른 팀도 그 팀 아이를 한 명씩 눌러 주세요. 다 됐으면 아래에서 작업 설정 파일을 받으세요.' : '팀마다 그 팀 조끼를 입은 아이를 한 명씩 눌러 주세요.';
    renderChips(d.players.map(l => l.length));
    $('#bRun').disabled = !st.teams.length;
    $('#bJob').disabled = jobBusy || !st.teams.length;
  }
  function renderChips(counts) {
    const el = $('#teams'); el.innerHTML = '';
    st.teams.forEach((t, i) => {
      const c = document.createElement('div'); c.className = 'team-chip';
      c.innerHTML = `<span class="dot" style="background:${t.color}"></span><input aria-label="팀 이름" maxlength="10">
        <label>인원 <input type="number" min="1" max="15" class="cnt" placeholder="자동" aria-label="${i + 1}번 팀 인원"></label>
        <span>이 장면 ${counts[i] ?? 0}명</span> <button class="link" aria-label="팀 지우기">지우기</button>`;
      const inp = c.querySelector('input'); inp.value = t.name; inp.oninput = () => { t.name = inp.value.trim() || `팀${i + 1}`; };
      const cnt = c.querySelector('.cnt'); cnt.value = t.count || ''; cnt.oninput = () => { t.count = Math.max(0, Math.round(+cnt.value)) || 0; };
      c.querySelector('button').onclick = () => { st.teams.splice(i, 1); drawTeams(); };
      el.append(c);
    });
    if (st.teams.length < 4) { const p = document.createElement('div'); p.className = 'team-chip pending'; p.textContent = `+ 팀 ${st.teams.length + 1}: 화면에서 그 팀 아이를 누르세요`; el.append(p); }
  }
  cv3.onclick = e => {
    if (!st.bg || st.teams.length >= 4) return;
    const [x, y] = toPx(cv3, e);
    const c = colorFromClick(st.frame, st.bg, st.w, st.h, Math.round(x), Math.round(y), Math.round(0.35 * (st.s?.ppm || 30)));
    if (!c) { $('#teamHint').textContent = '거기서는 조끼 색이 안 잡혀요. 움직이는 아이의 몸 한가운데를 눌러 주세요.'; return; }
    let no = 1; while (st.teams.some(o => o.name === `팀${no}`)) no++;
    const t = { name: `팀${no}`, ...c };
    // 색 중심이 아주 가까우면 같은 팀을 또 누른 것
    const same = st.teams.find(o => Math.abs(((o.mid[0] - t.mid[0] + 540) % 360) - 180) < 12 && Math.abs(o.mid[1] - t.mid[1]) < 30);
    if (same) { $('#teamHint').textContent = `${same.name}과 같은 색이에요. 다른 팀 아이를 눌러 주세요.`; return; }
    st.teams.push(t);
    drawTeams();
  };
  let scrubT = 0;
  $('#scrub').oninput = e => {
    const t = (e.target.value / 1000) * video.duration, my = ++scrubT;
    frameAt(video, t).then(f => { if (!left && my === scrubT) { st.frame = f; drawTeams(); } });
  };

  // 다음 수업을 위해 이 학교의 코트 크기·모서리(화면 비율)와 고른 반을 기억 (작업 설정 파일을 받을 때, 브라우저 분석이 끝날 때)
  async function remember() {
    await store.putSchool({ ...st.school, court: court(), corners: st.corners.map(([x, y]) => [+(x / st.w).toFixed(4), +(y / st.h).toFixed(4)]) });
    try { localStorage.setItem('futsal-last-group', st.groupId); } catch {}
  }

  // ---------- 4a. 작업 설정 파일 받기 (기본): 설정만 담은 JOB 파일 → 이 컴퓨터에서 따로 분석 → 결과 파일을 홈에서 가져오기 ----------
  const jobMsg = (text, err = false) => { const el = $('#jobMsg'); el.textContent = text; el.classList.toggle('err', err); if (err) el.focus({ preventScroll: true }); };
  function showJobDone(job, base) {
    const videoName = job.sourceName || st.sourceName || '수업영상.mp4', jobName = `${base}-작업.json`, out = `${base}-결과.json`;
    const cmd = localCommand(`samples/${videoName}`, `samples/${jobName}`, `samples/${out}`); // 풋살 코치 폴더에서 실행, 세 파일은 samples 폴더(저장소에 안 올라가는 곳)에 모음
    $('#jobName').textContent = jobName; $('#jobVideo').textContent = videoName; $('#jobOut').textContent = `samples/${out}`; $('#jobCmd').textContent = cmd;
    $('#bCopyCmd').onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); jobMsg('명령을 복사했어요. 터미널에 붙여 넣으세요.'); }
      catch { const r = document.createRange(); r.selectNodeContents($('#jobCmd')); getSelection().removeAllRanges(); getSelection().addRange(r); jobMsg('자동으로 복사하지 못했어요. 선택된 명령을 직접 복사해 주세요(⌘C 또는 Ctrl+C).', true); }
    };
    const box = $('#jobDone'); box.hidden = false; box.focus(); // 안내로 포커스·스크롤 (키보드·화면 읽기 사용자)
  }
  $('#bJob').onclick = async () => {
    if (jobBusy || !st.teams.length) return; // 중복 클릭 방지
    jobBusy = true; $('#bJob').disabled = true; jobMsg('작업 설정 파일을 만드는 중…');
    try {
      let parse;
      try { parse = (await import('./analysis-file.js')).parseAnalysisJob; } catch { throw new Error('작업 파일 검사 도구(js/analysis-file.js)를 불러오지 못했어요. 새로고침해 보거나 "이 브라우저에서 바로 분석"을 써 주세요.'); }
      if (typeof parse !== 'function') throw new Error('작업 파일 검사 도구가 아직 준비되지 않았어요.');
      if (left) return; // 불러오는 사이 떠났으면 남의 화면 입력칸을 읽지 않음
      const date = $('#date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('수업 날짜를 넣어 주세요.');
      const title = $('#title').value.trim() || `${date} 수업`;
      const job = parse({ app: 'futsal-coach-job', version: 1, session: { title, date, groupId: st.groupId }, config: cfg(), ...(st.sourceName ? { sourceName: st.sourceName } : {}) }); // 틀리면 한국어 오류
      if (left) return;
      const base = `풋살코치-${safeName(job.session.date)}-${safeName(job.session.title) || '수업'}`;
      downloadJSON(`${base}-작업.json`, job); // 이 컴퓨터로 내려받기만 함 (어디에도 올리지 않음)
      jobMsg('');
      showJobDone(job, base);
      try { await remember(); } catch { /* 코트 기억은 다음 수업 편의라, 실패해도 받은 작업 파일은 그대로 쓸 수 있음 */ }
    } catch (e) { if (!left) jobMsg('작업 설정 파일을 만들지 못했어요: ' + e.message, true); }
    finally { jobBusy = false; if (!left) $('#bJob').disabled = !st.teams.length; }
  };

  // ---------- 4b. 이 브라우저에서 바로 분석 (보조) ----------
  $('#bRun').onclick = async () => {
    const date = $('#date').value, title = $('#title').value.trim() || `${date} 수업`; // 분석 뒤가 아니라 누를 때 읽음 (그사이 화면이 바뀌어도 안전)
    step(4); video.classList.add('show');
    st.abort = new AbortController();
    const t0 = performance.now();
    try {
      const result = await runAnalysis(video, cfg(), st.bg, {
        signal: st.abort.signal,
        onProgress: (p, msg) => {
          if (left) return;
          if (p != null) { st.p = p; $('#bar').style.width = (p * 100).toFixed(1) + '%'; }
          const el = (performance.now() - t0) / 1000, q = st.p || 0;
          $('#runMsg').textContent = msg || `${Math.round(q * 100)}% · 남은 시간 약 ${q > 0.03 ? fmtTime((el / q) * (1 - q)) : '계산 중'}`;
        },
      });
      // 브라우저 분석도 어떤 방식으로 분석했는지 남긴다 (runAnalysis → analyzeFrames 기본값)
      const s = { id: store.uid(), groupId: st.groupId, title, date, createdAt: new Date().toISOString(), result, assign: {}, analysis: { engine: DEFAULT_ENGINE } };
      await store.putSession(s); // 분석이 끝났으면 떠났더라도 결과는 저장해 둔다
      try { await remember(); } catch { /* 코트 기억 실패는 결과 저장과 무관 */ }
      sessionVideos.set(s.id, st.url);
      st.abort = null;
      if (left) return; // 그사이 다른 화면으로 갔으면 끌고 오지 않음
      location.hash = '#s-' + s.id;
    } catch (e) {
      if (left) return; // 떠나서 멈춘 경우(AbortError) 등: 남의 화면을 건드리지 않음
      video.classList.remove('show');
      step(3); drawTeams();
      $('#teamHint').textContent = e.name === 'AbortError' ? '분석을 멈췄어요. 다시 시작할 수 있어요.' : '분석하지 못했어요: ' + e.message;
    }
  };
  $('#bCancel').onclick = () => st.abort?.abort();
  step(1);
}
