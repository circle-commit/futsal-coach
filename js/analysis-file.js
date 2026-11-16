// 로컬 분석 파일 형식 검사 (브라우저·node 공통 순수 함수).
// 웹에서 받는 분석 설정 파일(JOB)과 node 분석 도구가 만드는 분석 결과 파일(RESULT)을 같은 규칙으로 읽는다.
//   JOB    = { app: 'futsal-coach-job', version: 1, session: { title, date, groupId }, config, sourceName? }
//   RESULT = { app: 'futsal-coach-analysis', version: 1, session, result, analysis: { engine: 'classical-v1' | 'classical-v2', ... } }
//   config = pipeline.setup이 받는 설정 { width, height, corners, court, teams }
//   result = pipeline.analyzeFrames 결과 (classical-v1·v2 같은 형식: 0.1초 간격, 선수 좌표는 모든 칸이 숫자(가려지면 hidden=1), 공만 모르는 칸 null 쌍)
// 세 함수 모두 입력을 바꾸지 않는다. 통과하면 아는 칸만 새로 담은 복사본을 돌려주고, 모르는 칸은 버린다
// (analysis만 engine 밖의 칸도 JSON 값 그대로 복사). 틀리면 어느 칸이 왜 틀렸는지 적은 한국어 Error를 던진다.
// data는 JSON.parse한 객체여도 되고 JSON 글자여도 된다. JSON이 아닌 객체도 같은 규칙으로 본다.
// undefined·NaN·Infinity와 배열의 빈 칸은 받지 않는다. 고를 수 있는 칸(mid·count·sourceName)이 undefined면 없는 칸으로 본다.
// 오류 문장에는 파일 속 글자를 넣지 않는다 (화면에 그대로 띄워도 안전하게).
import { homography, applyH } from './vision.js';

export const JOB_APP = 'futsal-coach-job';
export const RESULT_APP = 'futsal-coach-analysis';
export const FILE_VERSION = 1;
export const ENGINE = 'classical-v1'; // 기본 분석 방식
export const ENGINES = Object.freeze(['classical-v1', 'classical-v2']); // 받는 분석 방식 (결과 형식은 같음)
// classical-v1·v2 결과는 언제나 0.1초 간격(pipeline.DT). 다른 간격은 화면 계산(전술 화면 round(1/dt) 등)이 깨질 수 있어 받지 않는다. 새 간격은 새 엔진 버전에서
export const RESULT_DT = 0.1;

const STATS = ['distance', 'topSpeed', 'sprints', 'possession', 'touches', 'passes', 'received', 'lost'];
const COUNTS = new Set(['sprints', 'touches', 'passes', 'received', 'lost']); // 횟수는 0 이상 정수

/** 분석 설정(cfg)을 검사해 깨끗한 복사본을 돌려준다 */
export function validateAnalysisConfig(cfg) {
  return guard('분석 설정이 올바르지 않아요', () => config(cfg, ''));
}

/** 분석 설정 파일(JOB)을 읽는다 */
export function parseAnalysisJob(data) {
  return guard('분석 설정 파일이 올바르지 않아요', () => {
    const d = header(data, JOB_APP, '분석 설정 파일');
    const out = { app: JOB_APP, version: FILE_VERSION, session: session(d.session, 'session'), config: config(d.config, 'config') };
    const src = d.sourceName;
    if (src !== undefined) out.sourceName = text(src, 'sourceName');
    return out;
  });
}

/** 분석 결과 파일(RESULT)을 읽는다. result는 화면·검수·교정에 바로 넣을 수 있는 analyzeFrames 결과 형식 */
export function parseAnalysisFile(data) {
  return guard('분석 결과 파일이 올바르지 않아요', () => {
    const d = header(data, RESULT_APP, '분석 결과 파일');
    return {
      app: RESULT_APP, version: FILE_VERSION, session: session(d.session, 'session'),
      result: result(d.result, 'result'), analysis: analysis(d.analysis, 'analysis'),
    };
  });
}

// ---------- 공통 ----------
class Bad extends Error {}
const bad = (at, msg) => { throw new Bad(at ? `${at}: ${msg}` : msg); };
function guard(prefix, fn) {
  try { return fn(); } catch (e) { throw new Error(`${prefix}: ${e instanceof Bad ? e.message : '읽는 중 문제가 생겼어요 (' + (e?.message ?? e) + ')'}`, { cause: e }); }
}
const sub = (at, k) => (at ? `${at}.${k}` : k);
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = v => (v === undefined ? '없음' : v === null ? 'null' : typeof v === 'number' ? String(v) : typeof v === 'string' ? '글자' : Array.isArray(v) ? '배열' : typeof v === 'object' ? '객체' : typeof v);
const fmt = x => String(+x.toFixed(3));
// 배열 칸마다 f (빈 칸도 건너뛰지 않음: map·forEach는 빈 칸을 건너뛰어서 쓰지 않는다)
const each = (a, f) => Array.from({ length: a.length }, (_, i) => f(a[i], i));

function obj(v, at) { if (!isObj(v)) bad(at, `객체여야 해요 (지금: ${show(v)})`); return v; }
function list(v, at, len) {
  if (!Array.isArray(v)) bad(at, `배열이어야 해요 (지금: ${show(v)})`);
  if (len != null && v.length !== len) bad(at, `길이가 ${len}개여야 하는데 ${v.length}개예요`);
  return v;
}
function num(v, at, { min = -Infinity, max = Infinity, int = false, above } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(at, `유한한 숫자여야 해요 (지금: ${show(v)})`);
  if (int && !Number.isInteger(v)) bad(at, `정수여야 해요 (지금: ${v})`);
  if (above != null && !(v > above)) bad(at, `${fmt(above)}보다 커야 해요 (지금: ${v})`);
  if (v < min || v > max) bad(at, `${max === Infinity ? `${fmt(min)} 이상이어야` : `${fmt(min)}~${fmt(max)} 사이여야`} 해요 (지금: ${v})`);
  return v;
}
function text(v, at) {
  if (typeof v !== 'string') bad(at, `글자여야 해요 (지금: ${show(v)})`);
  if (!v.trim()) bad(at, '비어 있으면 안 돼요');
  return v;
}
// 화면에서 style 속성에 그대로 들어가는 색이라 #rrggbb만 받는다 (vision.hsvToRgb 출력 형식)
function hex(v, at) { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) bad(at, '색은 #1f8fe0처럼 #와 16진수 6자리여야 해요'); return v; }
function day(v, at) {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v), d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) bad(at, '날짜는 2026-05-12처럼 실제 있는 날(YYYY-MM-DD)이어야 해요');
  return v;
}

function header(data, app, what) {
  let d = data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { bad('', 'JSON 파일이 아니거나 중간에 잘렸어요'); } }
  if (!isObj(d)) bad('', `${what} 형식이 아니에요 (지금: ${show(d)})`);
  const a = d.app;
  if (a !== app) {
    bad('app', a === JOB_APP ? '분석 설정 파일이에요. 분석을 마친 결과 파일을 넣어 주세요'
      : a === RESULT_APP ? '분석 결과 파일이에요. 분석 설정 파일을 넣어 주세요'
      : a === 'futsal-coach' ? '백업 파일이에요. 홈 화면의 백업 불러오기로 넣어 주세요'
      : `이 앱의 ${what}이 아니에요`);
  }
  if (d.version !== FILE_VERSION) bad('version', `${FILE_VERSION}판 파일만 읽을 수 있어요 (지금: ${show(d.version)})`);
  return d;
}

function session(s, at) {
  obj(s, at);
  return { title: text(s.title, sub(at, 'title')), date: day(s.date, sub(at, 'date')), groupId: text(s.groupId, sub(at, 'groupId')) };
}

// ---------- 코트·모서리 ----------
function court(v, at) { const q = list(v, at, 2); return [num(q[0], `${at}[0]`, { above: 0 }), num(q[1], `${at}[1]`, { above: 0 })]; }

/** 화면 px 모서리 4개 (좌상·우상·우하·좌하): 화면 안, 꼬이지 않은 볼록 사각형, 화면↔코트 변환이 제대로 계산될 것 */
function corners(v, at, w, h, [L, W]) {
  const cs = each(list(v, at, 4), (pt, i) => {
    const q = list(pt, `${at}[${i}]`, 2);
    return [num(q[0], `${at}[${i}][0]`, { min: 0, max: w }), num(q[1], `${at}[${i}][1]`, { min: 0, max: h })];
  });
  // 이웃한 세 점마다 같은 쪽으로 꺾여야 한다 (사각형에서 네 번 모두 같은 쪽이면 꼬이지 않은 볼록 사각형). 넓이가 거의 0이면 한 줄
  const tiny = 1e-6 * w * h; let turn = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = cs[i], [bx, by] = cs[(i + 1) % 4], [cx, cy] = cs[(i + 2) % 4];
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (!(Math.abs(cr) > tiny)) bad(at, '모서리 세 점이 한 줄에 있거나 두 점이 겹쳐요');
    if (turn && Math.sign(cr) !== turn) bad(at, '네 모서리가 볼록한 사각형이 아니에요 (누른 순서가 꼬였거나 오목해요)');
    turn = Math.sign(cr);
  }
  const rect = [[0, 0], [L, 0], [L, W], [0, W]];
  let Hm, Hp;
  try { Hm = homography(cs, rect); Hp = homography(rect, cs); } catch { bad(at, '이 모서리로는 화면↔코트 변환을 만들 수 없어요'); }
  for (let i = 0; i < 4; i++) {
    const [u, q] = applyH(Hm, cs[i][0], cs[i][1]), [x, y] = applyH(Hp, L * (i === 1 || i === 2), W * (i >= 2));
    if (![...Hm, ...Hp, u, q, x, y].every(Number.isFinite) || Math.hypot(u - rect[i][0], q - rect[i][1]) > 1e-6 * (L + W) || Math.hypot(x - cs[i][0], y - cs[i][1]) > 1e-6 * (w + h)) {
      bad(at, '이 모서리로는 화면↔코트 변환이 제대로 계산되지 않아요');
    }
  }
  return cs;
}

// ---------- 설정 ----------
const hue = (v, at) => num(v, at, { min: 0, max: 360 }); // 360은 0°와 같은 색 (colorFromClick 반올림으로 나올 수 있음)
const sat = (v, at) => num(v, at, { min: 0, max: 255 });

function config(c, at) {
  obj(c, at);
  const width = num(c.width, sub(at, 'width'), { int: true, min: 1 }), height = num(c.height, sub(at, 'height'), { int: true, min: 1 });
  const ct = court(c.court, sub(at, 'court'));
  const cs = corners(c.corners, sub(at, 'corners'), width, height, ct);
  const ts = list(c.teams, sub(at, 'teams'));
  if (ts.length < 1 || ts.length > 4) bad(sub(at, 'teams'), `팀은 1~4개여야 해요 (지금: ${ts.length}개)`);
  return { width, height, corners: cs, court: ct, teams: each(ts, (t, i) => teamConfig(t, `${sub(at, 'teams')}[${i}]`)) };
}

function teamConfig(t, at) {
  obj(t, at);
  const hs = list(t.hue, `${at}.hue`, 2), ss = list(t.sat, `${at}.sat`, 2), mid = t.mid, count = t.count;
  const out = {
    name: text(t.name, `${at}.name`), color: hex(t.color, `${at}.color`),
    hue: [hue(hs[0], `${at}.hue[0]`), hue(hs[1], `${at}.hue[1]`)], // 앞이 뒤보다 크면 0°를 넘어가는 범위 (빨강·분홍)
    sat: [sat(ss[0], `${at}.sat[0]`), sat(ss[1], `${at}.sat[1]`)],
  };
  if (out.sat[0] > out.sat[1]) bad(`${at}.sat`, '채도 범위는 작은 값이 앞이어야 해요');
  if (mid !== undefined) { const m = list(mid, `${at}.mid`, 2); out.mid = [hue(m[0], `${at}.mid[0]`), sat(m[1], `${at}.mid[1]`)]; }
  if (count !== undefined) out.count = num(count, `${at}.count`, { int: true, min: 0, max: 15 }); // 0 = 자동
  return out;
}

// ---------- 결과 ----------
function result(r, at) {
  obj(r, at);
  const dt = num(r.dt, `${at}.dt`, { above: 0 }), duration = num(r.duration, `${at}.duration`, { above: 0 });
  if (dt !== RESULT_DT) bad(`${at}.dt`, `지금 분석 방식(${ENGINES.join('·')}) 결과는 ${RESULT_DT}초 간격만 읽을 수 있어요 (지금: ${dt})`);
  const ct = court(r.court, `${at}.court`);
  const tl = list(r.teams, `${at}.teams`);
  if (tl.length < 1 || tl.length > 4) bad(`${at}.teams`, `팀은 1~4개여야 해요 (지금: ${tl.length}개)`);
  const teams = each(tl, (t, i) => { obj(t, `${at}.teams[${i}]`); return { name: text(t.name, `${at}.teams[${i}].name`), color: hex(t.color, `${at}.teams[${i}].color`) }; });
  const counts = each(list(r.counts, `${at}.counts`, teams.length), (c, i) => num(c, `${at}.counts[${i}]`, { int: true, min: 0 }));
  // 칸 수 N은 공·선수 경로 길이로 정한다. 마지막 칸 시각 (N-1)·dt와 영상 길이는 1칸 미만 차이까지 괜찮다 (브라우저 시각은 격자에 딱 맞지 않음)
  const rb = list(r.ball, `${at}.ball`);
  if (!rb.length || rb.length % 2) bad(`${at}.ball`, `길이가 2 이상 짝수여야 해요 (지금: ${rb.length}개)`);
  const N = rb.length / 2;
  if (!(Math.abs(duration - (N - 1) * dt) < dt + 1e-6)) bad(`${at}.ball`, `${N}칸이면 영상 길이가 약 ${fmt((N - 1) * dt)}초여야 하는데 duration이 ${fmt(duration)}초예요 (파일이 잘렸을 수 있어요)`);
  const ball = coords(rb, `${at}.ball`, N, { allowNull: true });
  const pl = list(r.players, `${at}.players`);
  if (!pl.length) bad(`${at}.players`, '아이가 한 명도 없어요');
  const players = each(pl, (q, i) => player(q, i, `${at}.players[${i}]`, N, teams.length));
  counts.forEach((c, t) => {
    const n = players.filter(p => p.team === t).length;
    if (n !== c) bad(`${at}.counts[${t}]`, `${t}번 팀 아이가 ${n}명인데 ${c}명으로 적혀 있어요`);
  });
  const tMax = N * dt + 0.05 + 1e-6; // 패스 시각 = 공 소유 구간 끝 칸(최대 N) × dt를 0.1초로 반올림
  const events = key => each(list(r[key], `${at}.${key}`), (e, i) => event(e, `${at}.${key}[${i}]`, players.length, tMax));
  const passes = events('passes'), turnovers = events('turnovers');
  const hiddenRate = num(r.hiddenRate, `${at}.hiddenRate`, { min: 0, max: 1 }), ballSeen = num(r.ballSeen, `${at}.ballSeen`, { min: 0, max: 1 });
  const vd = obj(r.video, `${at}.video`);
  const vw = num(vd.width, `${at}.video.width`, { int: true, min: 1 }), vh = num(vd.height, `${at}.video.height`, { int: true, min: 1 });
  const video = { width: vw, height: vh, corners: corners(vd.corners, `${at}.video.corners`, vw, vh, ct) };
  return { dt, court: ct, teams, counts, duration, players, ball, passes, turnovers, hiddenRate, ballSeen, video };
}

function player(q, i, at, N, nTeams) {
  obj(q, at);
  const id = num(q.id, `${at}.id`, { int: true });
  if (id !== i) bad(`${at}.id`, `순서대로 ${i}번이어야 해요 (지금: ${id})`);
  const out = { id, team: num(q.team, `${at}.team`, { int: true, min: 0, max: nTeams - 1 }), label: text(q.label, `${at}.label`) };
  for (const k of STATS) out[k] = num(q[k], `${at}.${k}`, { min: 0, int: COUNTS.has(k) }); // 공 소유 시간은 마지막 칸까지 세서 영상 길이보다 길 수 있음
  out.path = coords(q.path, `${at}.path`, N, { allowNull: false }); // classical-v1·v2 선수 경로는 늘 숫자. null을 받으면 전술 계산이 0으로 보고 틀린 지표를 낸다
  out.hidden = each(list(q.hidden, `${at}.hidden`, N), (x, j) => (x === 0 || x === 1 ? x : bad(`${at}.hidden[${j}]`, `0 또는 1이어야 해요 (지금: ${show(x)})`)));
  return out;
}

/** [x0,y0,x1,y1,...]: 칸마다 x·y가 둘 다 유한한 숫자. allowNull이면 둘 다 null(모름)도 받는다 (공만) */
function coords(v, at, N, { allowNull }) {
  const a = list(v, at, 2 * N), out = new Array(2 * N);
  for (let k = 0; k < 2 * N; k += 2) {
    const x = a[k], y = a[k + 1];
    if (allowNull && x === null && y === null) { out[k] = out[k + 1] = null; continue; }
    if (!allowNull && (x === null || y === null)) {
      bad(`${at}[${k}]`, `선수 좌표가 비어 있어요(null). 지금 분석 방식(${ENGINES.join('·')})은 선수 좌표가 빠진 결과를 지원하지 않아요. 분석 도구가 만든 원본 결과 파일을 다시 가져와 주세요`);
    }
    if (!(typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y))) {
      bad(`${at}[${k}]`, `x·y가 둘 다 유한한 숫자${allowNull ? '이거나 둘 다 null이어야' : '여야'} 해요 (지금: ${show(x)}, ${show(y)})`);
    }
    out[k] = x; out[k + 1] = y;
  }
  return out;
}

function event(e, at, nPlayers, tMax) {
  obj(e, at);
  return {
    from: num(e.from, `${at}.from`, { int: true, min: 0, max: nPlayers - 1 }),
    to: num(e.to, `${at}.to`, { int: true, min: 0, max: nPlayers - 1 }),
    t: num(e.t, `${at}.t`, { min: 0, max: tMax }),
  };
}

// analysis: engine은 ENGINES 중 하나 (classical-v1·v2). 나머지 칸(도구 버전·걸린 시간 등)은 JSON 값만 그대로 복사
function analysis(a, at) {
  obj(a, at);
  if (!ENGINES.includes(a.engine)) bad(`${at}.engine`, `지원하는 분석 방식(${ENGINES.join(', ')}) 결과만 읽을 수 있어요`);
  return json(a, at, 0);
}
function json(v, at, depth) {
  if (depth > 32) bad(at, '너무 깊게 겹친 값이 있어요');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return each(v, x => json(x, at, depth + 1));
  if (isObj(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))) return Object.fromEntries(Object.keys(v).map(k => [k, json(v[k], at, depth + 1)]));
  bad(at, `JSON으로 저장할 수 없는 값이 있어요 (지금: ${show(v)})`);
}
