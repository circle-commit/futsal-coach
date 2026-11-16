// 로컬 분석 파일 형식 약속 (js/analysis-file.js): 분석 설정 검사, 작업 설정 파일(JOB), 분석 결과 파일(RESULT).
// 기존 화면·파이프라인이 실제로 만드는 값은 받고, 화면을 깨거나(크래시) 스크립트를 넣을 수 있는(XSS) 값은 칸 이름이 든 한국어 오류로 막는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysisConfig, parseAnalysisJob, parseAnalysisFile, JOB_APP, RESULT_APP, FILE_VERSION, ENGINE, RESULT_DT } from '../js/analysis-file.js';
import { analyzeFrames, DT } from '../js/pipeline.js';
import { findReviewSegments, swapPlayerSegment, compareReviewResults } from '../js/review.js';

const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const json = o => JSON.parse(JSON.stringify(o));
// 던진 값이 Error이고 문장이 start로 시작하는지 (실패하면 실제 문장을 보여 줌)
const err = start => e => { assert.ok(e instanceof Error, '오류는 Error'); assert.ok(e.message.startsWith(start), `기대: "${start}…"\n실제: "${e.message}"`); return true; };

// 화면(new.js cfg())이 만드는 모양: colorFromClick의 hue·sat·mid는 반올림이라 360이 나올 수 있고, 인원 칸을 안 건드리면 count가 undefined
const CFG = () => ({
  width: 1280, height: 720, corners: [[104, 168], [1256, 168], [1256, 616], [106.7, 616]], court: [35, 13.7],
  teams: [
    { name: '파랑', color: '#1f8fe0', hue: [184, 220], sat: [130, 255], mid: [202, 200], count: undefined },
    { name: '분홍', color: '#E0367F', hue: [340, 360], sat: [70, 255], mid: [360, 180], count: 4 },
    { name: '빨강', color: '#e33333', hue: [350, 10], sat: [60, 255], count: 0 }, // 0°를 넘는 범위, mid 없음, 0 = 자동
  ],
});
const SESSION = () => ({ title: '3학년 2반 수업', date: '2026-11-14', groupId: 'g1' });
const job = () => ({ app: JOB_APP, version: FILE_VERSION, session: SESSION(), config: CFG(), sourceName: '수업 영상 (1).mp4' });

// 실제 파이프라인 결과: 브라우저처럼 시각이 0.1초 격자에 안 맞고, 마지막 시각도 격자 밖(60.066666초). 공이 아이 사이를 옮겨 다녀 패스·뺏김이 생김.
// 공이 잠깐 안 보이는 장면은 trackBall·resample이 메워서 null이 남지 않으므로, 30~34초는 공을 아예 못 찾은 긴 구간으로 둔다 (결과에 null 칸이 남음)
function pipelineResult() {
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kid = (t, k) => [6 + 9 * (k % 3) + 3 * Math.sin(t / (2 + k)), 4 + 4 * Math.floor(k / 3) + 3 * Math.cos(t / (3 + k))];
  const frame = t => {
    const pos = [0, 1, 2, 3, 4, 5].map(k => kid(t, k)), [bx, by] = pos[Math.floor(t / 4) % 6];
    const seen = rnd() > 0.15 && !(t >= 30 && t < 34);
    return { t, players: [pos.slice(0, 3), pos.slice(3)], ball: seen ? [[bx + 0.3, by, 1]] : [] };
  };
  const dets = [];
  for (let t = 0; t < 60; t += 1 / 7.3 + (rnd() - 0.5) * 0.02) dets.push(frame(+t.toFixed(3)));
  dets.push(frame(60.066666));
  const cfg = { width: 1280, height: 720, corners: [[60, 40], [1220, 50], [1240, 690], [40, 700]], court: [40, 20], teams: [{ name: 'A', color: '#1f8fe0' }, { name: 'B', color: '#e0367f' }] };
  return json(analyzeFrames(dets, cfg));
}
const BASE = pipelineResult();
const resultFile = () => ({
  app: RESULT_APP, version: FILE_VERSION, session: SESSION(), result: structuredClone(BASE),
  analysis: { engine: ENGINE, sourceName: '수업 영상 (1).mp4', frames: 440, elapsedMs: 1234, resumed: false },
});

test('준비: 시험용 결과는 실제 파이프라인 출력이고 경계 상황을 담고 있다', () => {
  const N = BASE.ball.length / 2;
  assert.ok(BASE.duration - (N - 1) * BASE.dt > 0.05, '마지막 시각이 격자 밖');
  assert.ok(BASE.passes.length > 0 && BASE.turnovers.length > 0, '패스·뺏김 있음');
  const unknown = BASE.ball.filter((x, i) => i % 2 === 0 && x === null).length;
  assert.ok(unknown >= 10, `공을 모르는 칸이 30~34초에 남음 (지금 ${unknown}칸)`);
  assert.ok(BASE.ball.every((x, i) => (x === null) === (BASE.ball[i ^ 1] === null)), '모르는 칸은 x·y가 같이 null');
  assert.deepEqual(BASE.counts, [3, 3]);
});

test('설정: 화면이 만드는 설정(360으로 끝나거나 0°를 넘는 색 범위, mid·count 없음, count undefined)을 받고 같은 값의 새 복사본을 돌려준다', () => {
  const c = deepFreeze(CFG()), out = validateAnalysisConfig(c);
  assert.deepEqual(out, json(c), 'JSON에 저장한 것과 같음 (undefined count는 없는 칸)');
  assert.equal('count' in out.teams[0], false);
  assert.notEqual(out, c); assert.notEqual(out.corners[0], c.corners[0]); assert.notEqual(out.teams[1].hue, c.teams[1].hue);
  // 예전 샘플 설정 모양: mid·count 없음
  const old = { width: 1280, height: 720, court: [35, 13.7], corners: [[104, 168], [1256, 168], [1256, 616], [106.7, 616]],
    teams: [{ name: '파랑', color: '#1f8fe0', hue: [184, 220], sat: [130, 255] }, { name: '분홍', color: '#e0367f', hue: [280, 358], sat: [70, 255] }] };
  assert.deepEqual(validateAnalysisConfig(old), old);
  // 모르는 칸은 버림
  const extra = validateAnalysisConfig({ ...CFG(), fps: 30, teams: [{ ...CFG().teams[0], note: 'x' }] });
  assert.deepEqual(Object.keys(extra), ['width', 'height', 'corners', 'court', 'teams']);
  assert.deepEqual(Object.keys(extra.teams[0]), ['name', 'color', 'hue', 'sat', 'mid']);
});

test('설정: 틀린 크기·모서리·코트·팀 색 범위·인원은 칸 이름이 든 한국어 오류로 거부한다', () => {
  const bad = [
    ['width', c => { c.width = 1280.5; }], ['width', c => { c.width = 0; }], ['width', c => { delete c.width; }],
    ['height', c => { c.height = NaN; }], ['height', c => { c.height = '720'; }],
    ['corners', c => { c.corners.pop(); }],
    ['corners[1][0]', c => { c.corners[1][0] = 1281; }], // 화면 밖
    ['corners[0][1]', c => { c.corners[0][1] = -1; }],
    ['corners[2][1]', c => { c.corners[2][1] = null; }],
    ['corners', c => { [c.corners[1], c.corners[2]] = [c.corners[2], c.corners[1]]; }], // 누른 순서가 꼬임 (나비 모양)
    ['corners', c => { c.corners = [[100, 100], [600, 100], [1100, 100], [100, 600]]; }], // 세 점이 한 줄
    ['corners', c => { c.corners = [[100, 100], [1100, 100], [500, 300], [100, 600]]; }], // 오목
    ['corners', c => { c.corners = [[100, 100], [100, 100], [1100, 600], [100, 600]]; }], // 두 점이 겹침
    ['corners', c => { c.corners = [[100, 100], [600, 99.9995], [1100, 100], [100, 600]]; }], // 볼록하지만 거의 한 줄 (꺾인 넓이 1px² 미만 = 사실상 삼각형)
    ['court', c => { c.court = [35]; }], ['court[0]', c => { c.court = [0, 13.7]; }], ['court[1]', c => { c.court = [35, -2]; }],
    ['teams', c => { c.teams = []; }], ['teams', c => { c.teams = [...c.teams, ...c.teams]; }], // 0개, 6개
    ['teams[0].name', c => { c.teams[0].name = ' '; }], ['teams[0].name', c => { c.teams[0].name = 7; }],
    ['teams[1].color', c => { c.teams[1].color = '#fff'; }], ['teams[1].color', c => { c.teams[1].color = 'blue'; }],
    ['teams[0].hue[1]', c => { c.teams[0].hue[1] = 361; }], ['teams[0].hue[0]', c => { c.teams[0].hue[0] = -1; }], ['teams[0].hue', c => { c.teams[0].hue = [184]; }],
    ['teams[0].sat[1]', c => { c.teams[0].sat[1] = 256; }], ['teams[0].sat', c => { c.teams[0].sat = [200, 100]; }],
    ['teams[0].mid[0]', c => { c.teams[0].mid = [400, 100]; }], ['teams[0].mid', c => { c.teams[0].mid = null; }],
    ['teams[1].count', c => { c.teams[1].count = 16; }], ['teams[1].count', c => { c.teams[1].count = 2.5; }],
    ['teams[1].count', c => { c.teams[1].count = -1; }], ['teams[1].count', c => { c.teams[1].count = null; }],
  ];
  for (const [at, mut] of bad) {
    const c = CFG(); mut(c);
    assert.throws(() => validateAnalysisConfig(deepFreeze(c)), err(`분석 설정이 올바르지 않아요: ${at}: `), at);
  }
  for (const x of [null, undefined, [], 'cfg', 3]) assert.throws(() => validateAnalysisConfig(x), err('분석 설정이 올바르지 않아요: 객체여야 해요'));
});

test('JOB: 웹이 만드는 작업 설정 파일을 객체·JSON 글자 모두 읽고, 모르는 칸은 버린다', () => {
  const j = deepFreeze(job()), out = parseAnalysisJob(j);
  assert.deepEqual(out, json(j));
  assert.deepEqual(parseAnalysisJob(JSON.stringify(j)), out);
  const { sourceName, ...noSrc } = job();
  assert.equal('sourceName' in parseAnalysisJob(noSrc), false, 'sourceName은 고를 수 있는 칸');
  assert.equal('sourceName' in parseAnalysisJob({ ...noSrc, sourceName: undefined }), false);
  const extra = parseAnalysisJob({ ...job(), extra: 1, session: { ...SESSION(), kids: ['이름'] } });
  assert.deepEqual(Object.keys(extra), ['app', 'version', 'session', 'config', 'sourceName']);
  assert.deepEqual(Object.keys(extra.session), ['title', 'date', 'groupId']);
});

test('JOB: app·version·날짜·제목·반·원본 이름과 설정을 엄격히 보고, 잘린 JSON 글자도 한국어 오류로 거부한다', () => {
  const bad = [
    ['app', j => { j.app = 'futsal-coach'; }], ['app', j => { j.app = RESULT_APP; }], ['app', j => { delete j.app; }], // 백업·결과 파일, app 없음
    ['version', j => { j.version = '1'; }], ['version', j => { j.version = 2; }],
    ['session', j => { j.session = null; }], ['session.title', j => { j.session.title = ''; }],
    ['session.date', j => { j.session.date = '2026-2-3'; }], ['session.date', j => { j.session.date = '2026-02-30'; }],
    ['session.date', j => { j.session.date = '2026-13-01'; }], ['session.date', j => { j.session.date = 20261114; }],
    ['session.groupId', j => { delete j.session.groupId; }], ['sourceName', j => { j.sourceName = 3; }],
    ['config', j => { delete j.config; }], ['config.teams[0].color', j => { j.config.teams[0].color = 'red'; }],
    ['config.corners', j => { const c = j.config.corners; [c[1], c[2]] = [c[2], c[1]]; }], // 누른 순서가 꼬임
  ];
  for (const [at, mut] of bad) {
    const j = job(); mut(j);
    assert.throws(() => parseAnalysisJob(deepFreeze(j)), err(`분석 설정 파일이 올바르지 않아요: ${at}: `), at);
  }
  const text = JSON.stringify(job());
  for (const cut of [10, text.length >> 1, text.length - 1]) assert.throws(() => parseAnalysisJob(text.slice(0, cut)), err('분석 설정 파일이 올바르지 않아요: JSON 파일이 아니거나 중간에 잘렸어요'));
  for (const x of [null, [], 42]) assert.throws(() => parseAnalysisJob(x), err('분석 설정 파일이 올바르지 않아요: 분석 설정 파일 형식이 아니에요'));
});

test('RESULT: 실제 파이프라인 결과를 그대로 읽고(JSON 글자도), 읽은 결과로 검수 후보·교정·전후 비교가 돈다', () => {
  const f = deepFreeze(resultFile()), out = parseAnalysisFile(f);
  assert.deepEqual(out, json(f), 'analysis의 다른 칸까지 그대로');
  assert.deepEqual(parseAnalysisFile(JSON.stringify(f)), out);
  const v2 = resultFile(); v2.analysis.engine = 'classical-v2'; // 같은 결과 형식의 v2 분석 방식도 받음
  assert.equal(parseAnalysisFile(deepFreeze(v2)).analysis.engine, 'classical-v2');
  const R = out.result;
  assert.ok(Array.isArray(findReviewSegments(R)));
  const [a, b] = R.players.filter(p => p.team === 0);
  const sw = swapPlayerSegment(R, { playerA: a.id, playerB: b.id, start: 10, end: 20 });
  assert.equal(compareReviewResults(R, sw).length, R.players.length);
});

test('RESULT: 기존 출력의 경계값을 받는다 (공 소유가 영상 길이보다 김, 마지막 칸과 영상 길이 1칸 미만 차이, 공 모르는 칸 null 쌍, 마지막 칸 패스). 선수 좌표 null은 classical-v1에서 거부', () => {
  const ok = mut => { const f = resultFile(); mut(f.result); return parseAnalysisFile(deepFreeze(f)); };
  const N = BASE.ball.length / 2, dt = BASE.dt, last = (N - 1) * dt;
  ok(R => { R.players[0].possession = N * dt; }); // 마지막 칸까지 세서 duration + dt 가까이 될 수 있음
  ok(R => { R.ball[4] = null; R.ball[5] = null; }); // 공을 모르는 칸
  ok(R => { R.duration = last + 0.999 * dt; });
  ok(R => { R.duration = last - 0.999 * dt; });
  ok(R => { R.duration = last; });
  ok(R => { R.passes[0].t = +(N * dt).toFixed(1); });
  const no = (at, mut) => { const f = resultFile(); mut(f.result); assert.throws(() => parseAnalysisFile(deepFreeze(f)), err(`분석 결과 파일이 올바르지 않아요: ${at}: `), at); };
  no('result.ball', R => { R.duration = last + 1.001 * dt; });
  no('result.ball', R => { R.duration = last - 1.001 * dt; });
  no('result.passes[0].t', R => { R.passes[0].t = N * dt + 0.2; });
  // 선수 좌표는 classical-v1에서 늘 숫자(가려지면 hidden=1). null을 받으면 전술 계산이 0으로 봐 틀린 지표를 내므로 거부하고 원본 결과 파일을 다시 쓰라고 알린다
  assert.ok(BASE.players.every(p => p.path.every(v => typeof v === 'number' && Number.isFinite(v))), '실제 파이프라인 선수 경로는 모두 숫자');
  for (const mut of [R => { R.players[1].path[4] = null; R.players[1].path[5] = null; }, R => { R.players[1].path[5] = null; }]) {
    const f = resultFile(); mut(f.result);
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), e => {
      err('분석 결과 파일이 올바르지 않아요: result.players[1].path[4]: 선수 좌표가 비어 있어요')(e);
      assert.match(e.message, /classical-v1.*지원하지 않아요.*원본 결과 파일을 다시 가져와/); return true;
    });
  }
});

test('RESULT: classical-v1·v2 결과 간격은 파이프라인과 같은 0.1초만 받는다 (2·3·0.05초 등은 거부: 전술 화면 round(1/dt)=0 무한 반복 방지)', () => {
  assert.equal(RESULT_DT, DT, '브라우저·CLI가 쓰는 pipeline.DT와 같아야 실제 출력이 통과');
  assert.equal(parseAnalysisFile(JSON.stringify(resultFile())).result.dt, 0.1);
  for (const dt of [2, 3, 0.05, 0.2, 0.1 + 1e-9, '0.1']) {
    const f = resultFile(); f.result.dt = dt;
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), err('분석 결과 파일이 올바르지 않아요: result.dt: '), String(dt));
  }
});

test('RESULT: 화면 style에 그대로 들어가는 팀 색은 #rrggbb만 받고, 이름표·팀 이름은 글자만 받는다 (오류 문장에 파일 글자를 옮기지 않음)', () => {
  const evil = ['red', '#fff', '#12345g', '#1f8fe0;background:url(https://x.example/a)', '"><img src=x onerror=alert(1)>', 'url(javascript:alert(1))', '#1f8fe0 ', 0x1f8fe0, null];
  for (const color of evil) {
    const f = resultFile(); f.result.teams[1].color = color;
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), e => {
      err('분석 결과 파일이 올바르지 않아요: result.teams[1].color: ')(e);
      assert.ok(!/<img|url\(|onerror/.test(e.message), '오류 문장에 파일 글자 없음');
      return true;
    }, String(color));
  }
  for (const [at, mut] of [['result.players[2].label', R => { R.players[2].label = 12; }], ['result.players[2].label', R => { R.players[2].label = ''; }],
    ['result.teams[0].name', R => { R.teams[0].name = { toString: () => 'A' }; }], ['result.teams[0]', R => { R.teams[0] = '#1f8fe0'; }]]) {
    const f = resultFile(); mut(f.result);
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), err(`분석 결과 파일이 올바르지 않아요: ${at}: `), at);
  }
});

test('RESULT: 길이가 잘리거나 어긋난 파일을 거부한다 (한 아이 경로·가려짐·공 경로, 모두 같이 잘림, 잘린 JSON 글자)', () => {
  const cut = (R, n) => { R.ball.length = 2 * n; R.players.forEach(p => { p.path.length = 2 * n; p.hidden.length = n; }); };
  const cases = [
    ['result.players[2].path', R => { R.players[2].path.length -= 2; }],
    ['result.players[0].path', R => { R.players[0].path.pop(); }],
    ['result.players[1].hidden', R => { R.players[1].hidden.length -= 1; }],
    ['result.ball', R => { R.ball.length -= 20; }], // 공만 잘림 → 칸 수가 영상 길이와 안 맞음
    ['result.ball', R => { R.ball.pop(); }],
    ['result.ball', R => cut(R, 50)], // 모두 같은 길이로 잘려도 영상 길이와 안 맞음
    ['result.players', R => { R.players = []; }],
  ];
  for (const [at, mut] of cases) {
    const f = resultFile(); mut(f.result);
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), err(`분석 결과 파일이 올바르지 않아요: ${at}: `), at);
  }
  const text = JSON.stringify(resultFile());
  for (const n of [5, text.length >> 1, text.length - 2]) assert.throws(() => parseAnalysisFile(text.slice(0, n)), err('분석 결과 파일이 올바르지 않아요: JSON 파일이 아니거나 중간에 잘렸어요'));
});

test('RESULT: JSON이 아닌 값(NaN·undefined·빈 칸)과 틀린 숫자·참조·비율·영상 모서리·머리 정보를 거부한다', () => {
  const R0 = BASE;
  assert.ok(R0.ball[10] !== null || R0.ball[12] !== null, '준비');
  const k = R0.ball[10] !== null ? 10 : 12;
  const cases = [
    ['result.dt', R => { R.dt = 0; }], ['result.duration', R => { R.duration = -1; }], ['result.court[1]', R => { R.court[1] = 0; }],
    ['result.teams', R => { R.teams = []; }], ['result.teams', R => { R.teams = Array(5).fill(R.teams[0]); }],
    ['result.players[0].path[6]', R => { R.players[0].path[6] = NaN; }],
    ['result.players[0].path[6]', R => { R.players[0].path[7] = undefined; }],
    ['result.players[0].path[6]', R => { delete R.players[0].path[6]; }], // 빈 칸
    ['result.players[0].path[6]', R => { R.players[0].path[6] = null; }], // 선수 x만 null
    ['result.players[0].path[6]', R => { R.players[0].path[6] = '3.2'; }],
    [`result.ball[${k}]`, R => { R.ball[k + 1] = null; }],
    ['result.players[1].hidden[3]', R => { R.players[1].hidden[3] = 2; }], ['result.players[1].hidden[3]', R => { R.players[1].hidden[3] = true; }],
    ['result.players[1].hidden[3]', R => { delete R.players[1].hidden[3]; }], ['result.players[1]', R => { delete R.players[1]; }], // 빈 칸 (화면이 P[1]에서 깨짐)
    ['result.players[0].distance', R => { R.players[0].distance = -0.5; }], ['result.players[0].topSpeed', R => { R.players[0].topSpeed = Infinity; }],
    ['result.players[0].possession', R => { R.players[0].possession = NaN; }], ['result.players[0].sprints', R => { R.players[0].sprints = 1.5; }],
    ['result.players[0].lost', R => { delete R.players[0].lost; }],
    ['result.players[3].id', R => { R.players[3].id = 4; }], ['result.players[0].team', R => { R.players[0].team = 2; }],
    ['result.counts[0]', R => { R.counts[0] += 1; }], ['result.counts', R => { R.counts.push(0); }],
    ['result.passes[0].from', R => { R.passes[0].from = R.players.length; }], ['result.passes[0].to', R => { R.passes[0].to = 0.5; }],
    ['result.passes[0].t', R => { R.passes[0].t = -0.1; }], ['result.turnovers[0].t', R => { R.turnovers[0].t = R.duration + 1; }],
    ['result.passes', R => { R.passes = {}; }],
    ['result.hiddenRate', R => { R.hiddenRate = 1.2; }], ['result.ballSeen', R => { R.ballSeen = -0.01; }],
    ['result.video', R => { delete R.video; }], ['result.video.width', R => { R.video.width = 1280.5; }],
    ['result.video.corners', R => { R.video.corners[2] = [...R.video.corners[1]]; }],
    ['result.video.corners[1][0]', R => { R.video.corners[1][0] = R.video.width + 1; }],
  ];
  for (const [at, mut] of cases) {
    const f = resultFile(); mut(f.result);
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), err(`분석 결과 파일이 올바르지 않아요: ${at}: `), at);
  }
  const head = [
    ['app', f => { f.app = JOB_APP; }], ['app', f => { f.app = 'futsal-coach'; }], ['version', f => { f.version = 1.1; }],
    ['session.date', f => { f.session.date = '2026-11-31'; }], ['session.groupId', f => { f.session.groupId = ''; }],
    ['result', f => { f.result = null; }], ['analysis', f => { delete f.analysis; }],
    ['analysis.engine', f => { f.analysis.engine = 'classical-v3'; }], ['analysis.engine', f => { delete f.analysis.engine; }],
    ['analysis', f => { f.analysis.elapsedMs = NaN; }], ['analysis', f => { f.analysis.when = new Date(0); }],
  ];
  for (const [at, mut] of head) {
    const f = resultFile(); mut(f);
    assert.throws(() => parseAnalysisFile(deepFreeze(f)), err(`분석 결과 파일이 올바르지 않아요: ${at}: `), at);
  }
});

test('불변·복사: 입력을 바꾸지 않고, 돌려준 값은 입력과 배열·객체를 나눠 쓰지 않으며, 모르는 칸(교정 기록 등)은 버린다', () => {
  const f = resultFile();
  f.result.reviewEdits = [{ playerA: 0, playerB: 1, start: '<img>' }]; f.result.players[0].reviewBreaks = [1, 2]; f.result.extra = 1; f.extra = 2;
  f.analysis.nested = { a: [1, 'b', null, true] };
  const before = JSON.stringify(f); deepFreeze(f);
  const out = parseAnalysisFile(f);
  assert.equal(JSON.stringify(f), before);
  assert.equal('reviewEdits' in out.result, false); assert.equal('reviewBreaks' in out.result.players[0], false);
  assert.equal('extra' in out.result, false); assert.equal('extra' in out, false);
  assert.deepEqual(out.analysis.nested, { a: [1, 'b', null, true] });
  // 입력은 얼려 두었으므로, 돌려준 값이 입력의 배열·객체를 같이 쓰면 아래 고치기가 TypeError로 실패한다
  out.result.players[0].path[0] = 999; out.result.players[0].hidden[0] = 1; out.result.ball[0] = 999; out.result.video.corners[0][0] = 5;
  out.result.teams[0].color = '#000000'; out.result.passes[0].t = 0; out.result.counts[0] = 9; out.result.court[0] = 1;
  out.analysis.nested.a.push(2); out.session.title = 'x';
  assert.equal(JSON.stringify(f), before);
  const j = deepFreeze(job()), oj = parseAnalysisJob(j);
  oj.config.corners[0][0] = 1; oj.config.teams[0].hue[0] = 1; oj.config.court[0] = 1; oj.session.date = 'x';
  assert.deepEqual(j, job());
  // 실패할 때도 입력을 건드리지 않는다 (고치려 했다면 형식 오류가 아니라 TypeError가 났을 것)
  const g = resultFile(); g.result.players[1].path.length -= 2; deepFreeze(g);
  assert.throws(() => parseAnalysisFile(g), err('분석 결과 파일이 올바르지 않아요: result.players[1].path: '));
  // JSON의 "__proto__" 칸은 그냥 칸으로 복사되고, 돌려준 객체나 다른 객체의 프로토타입을 바꾸지 않는다
  const p = parseAnalysisFile(JSON.stringify(resultFile()).replace('"engine":', '"__proto__":{"polluted":1},"engine":'));
  assert.equal(Object.getPrototypeOf(p.analysis), Object.prototype);
  assert.equal(p.analysis.polluted, undefined); assert.equal({}.polluted, undefined);
});
