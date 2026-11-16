// node --test tests/
// classical-v2 추적 시험: 합성 검출(정답을 아는 위치)로 v1과 v2를 비교한다.
// v1 기본값·결과 그대로, v2 결정성, 사이드라인을 따라 실제로 뛰는 아이를 놓치지 않음(코트 안·밖), 가려진 아이를 가장자리 가짜 검출이 낚아채지 않음,
// 가장자리에서 다시 나타난 아이는 여러 장면 확인 뒤 잡고 그 장면들을 채움, 같은 팀 둘이 엇갈릴 때 예측으로 번호 유지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrames, ENGINES, DEFAULT_ENGINE } from '../js/pipeline.js';
import { trackPlayers, TRACK_V2 } from '../js/track.js';

const DT = 0.1, COURT = [40, 20];
const cfg = { width: 1280, height: 720, corners: [[100, 50], [1180, 50], [1230, 690], [50, 690]], court: COURT, teams: [{ name: 'A', color: '#e33333', hue: [350, 10], sat: [100, 255] }, { name: 'B', color: '#3333e3', hue: [220, 250], sat: [100, 255] }] };
/** n장면, 팀마다 아이별 위치 함수(null = 그 장면엔 검출 없음) + 덧붙일 가짜 검출 */
function frames(n, teams, extra = () => [[], []]) {
  return Array.from({ length: n }, (_, i) => {
    const ex = extra(i);
    return { t: +(i * DT).toFixed(1), players: teams.map((kids, t) => [...kids.map(f => f(i)).filter(Boolean), ...(ex[t] || [])]), ball: [] };
  });
}
const track = (fr, engine) => trackPlayers(fr, fr[0].players.map(l => l.length), { engine, court: COURT });
const at = (p, i) => [p.pos[2 * i], p.pos[2 * i + 1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const hiddenCount = p => p.hidden.reduce((a, b) => a + b, 0);
const near = (a, b, tol = 1e-4) => dist(a, b) <= tol;
// 흔한 한 판: 팀A 2명(하나는 x를 따라 움직이는 함수), 팀B 1명 가운데
const still = (x, y) => () => [x, y];

test('기본값은 classical-v2이고 결과가 같다 · 모르는 방식·코트 없는 v2는 거부', () => {
  assert.equal(DEFAULT_ENGINE, 'classical-v2');
  assert.deepEqual([...ENGINES], ['classical-v1', 'classical-v2']);
  const fr = frames(60, [[i => [5 + 0.2 * i, 5], still(20, 10)], [still(30, 15)]], i => [[], i % 7 === 0 ? [[31, 14]] : []]);
  assert.deepEqual(analyzeFrames(fr, cfg), analyzeFrames(fr, cfg, { engine: 'classical-v2' }));
  assert.throws(() => analyzeFrames(fr, cfg, { engine: 'classical-v9' }), /모르는 분석 방식/);
  assert.throws(() => trackPlayers(fr, [2, 1], { engine: 'classical-v2' }), /코트 크기/);
  const v2 = analyzeFrames(fr, cfg, { engine: 'classical-v2' });
  assert.equal(v2.players.length, 3); // 결과 모양은 같음
  assert.deepEqual(Object.keys(v2), Object.keys(analyzeFrames(fr, cfg, { engine: 'classical-v1' })));
});

test('v2는 결정적: 같은 입력이면 같은 출력', () => {
  const fr = frames(120, [[i => [5 + 0.3 * i, 8 + Math.sin(i / 5)], i => (i % 13 < 2 ? null : [30 - 0.2 * i, 12])], [still(20, 3)]], i => [i % 9 === 0 ? [[0.5, 10]] : [], []]);
  assert.deepEqual(analyzeFrames(fr, cfg, { engine: 'classical-v2' }), analyzeFrames(fr, cfg, { engine: 'classical-v2' }));
});

for (const [where, y] of [['코트 안 사이드라인(선에서 0.4m)', 0.4], ['코트 밖(선 밖 0.5m)', -0.5]]) {
  test(`사이드라인을 따라 실제로 뛰는 아이를 놓치지 않음: ${where}, 초속 6m, 1초마다 한 장면씩 안 보임`, () => {
    const n = 50, run = i => (i % 10 === 5 ? null : [2 + 0.6 * i, y]); // 5초 동안 2→32m
    const fr = frames(n, [[run, still(20, 10)], [still(25, 12)]]);
    const P = track(fr, 'classical-v2'), A = P.find(p => near(at(p, 0), [2, y]));
    assert.ok(A, '처음에 뛰는 아이를 잡음');
    // 한 장씩 안 보인 장면은 짧은 틈(0.3초·초속 6m 이하)이라 직선으로 이어 채우고, 다시 나타난 뒤 확인 장면도 채워짐 → 가려진 장면 없음
    assert.equal(hiddenCount(A), 0, `가려진 장면 ${hiddenCount(A)}`);
    for (let i = 0; i < n; i++) assert.ok(near(at(A, i), [2 + 0.6 * i, y]), `${i}번 장면: ${at(A, i)} ≠ ${[2 + 0.6 * i, y]}`);
    const B = P.find(p => p !== A && p.team === 0);
    for (let i = 0; i < n; i++) assert.ok(near(at(B, i), [20, 10]), '가운데 아이와 번호가 바뀌지 않음');
  });
}

test('가려진 아이를 사이드라인의 가짜 검출이 낚아채지 않음 (v1은 낚아챔)', () => {
  // 아이 A가 (20,10)에 서 있다가 2.0~3.4초 안 보임. 그동안 3.0~3.4초에 같은 팀 색 가짜 검출이 사이드라인 (20,0.5)에 계속 보임
  const n = 60, A = i => (i >= 20 && i < 35 ? null : [20, 10]);
  const fake = i => [i >= 30 && i < 35 ? [[20, 0.5]] : [], []];
  const fr = frames(n, [[A, still(5, 15)], [still(30, 5)]], fake);
  const went = P => P.filter(p => p.team === 0).some(p => [...Array(n).keys()].some(i => near(at(p, i), [20, 0.5], 1e-3)));
  assert.equal(went(track(fr, 'classical-v1')), true, 'v1은 1초 넘게 가려지면 9.5m 떨어진 가짜 검출을 잡음 (비교용)');
  const P = track(fr, 'classical-v2');
  assert.equal(went(P), false, 'v2는 예측 경로(1.5m+초속3m×가려진 시간)와 안 맞아 잡지 않음');
  const a = P.find(p => near(at(p, 0), [20, 10]));
  assert.ok(near(at(a, 40), [20, 10]) && a.hidden[40] === 0, '다시 나타난 아이를 다시 잡음');
});

test('가려졌다가 가장자리에서 다시 나타난 아이: 여러 장면 맞으면 잡고 그 장면들도 채움', () => {
  // A가 사이드라인 쪽으로 초속 4m로 가다가 0.5초 안 보이고, 가장자리(선에서 0.5m)에서 다시 나타나 선을 따라 감
  const A = i => (i < 20 ? [10, 9.5 - 0.4 * i] : i < 25 ? null : [10 + 0.4 * (i - 25), 0.5]);
  const fr = frames(50, [[A, still(30, 15)], [still(20, 10)]]);
  const P = track(fr, 'classical-v2'), a = P.find(p => near(at(p, 0), [10, 9.5]));
  assert.equal(hiddenCount(a), 5, `실제로 안 보인 0.5초만 가려짐 (지금 ${hiddenCount(a)})`);
  for (let i = 25; i < 50; i++) assert.ok(near(at(a, i), A(i)), `${i}번 장면 ${at(a, i)} ≠ ${A(i)}`);
  assert.equal(TRACK_V2.confirm, 3);
});

test('같은 팀 둘이 엇갈리며 잠깐 한 덩어리가 돼도 예측으로 번호를 지킴 (v1은 바뀜)', () => {
  // A: 초속 5m로 +x (y=10.0), B: 초속 5m로 −x (y=10.3). 2.0초에 x=15에서 엇갈리고, 그 앞뒤 3장면은 가운데 한 점만 보임
  const xa = i => 5 + 0.5 * i, xb = i => 25 - 0.5 * i, merged = i => i >= 19 && i <= 21;
  const fr = frames(40, [[i => (merged(i) ? [(xa(i) + xb(i)) / 2, 10.15] : [xa(i), 10]), i => (merged(i) ? null : [xb(i), 10.3])], [still(30, 3)]]);
  const ok = P => { const a = P.find(p => near(at(p, 0), [5, 10])); return near(at(a, 39), [xa(39), 10]); };
  assert.equal(ok(track(fr, 'classical-v1')), false, 'v1은 가려진 쪽의 멈춘 자리 때문에 번호가 바뀜 (비교용)');
  assert.equal(ok(track(fr, 'classical-v2')), true, 'v2는 등속 예측으로 원래 아이를 따라감');
});

test('오래 가려진 트랙의 옛 속도로 옆 아이를 끌어오지 않음 (가려진 지 0.5~1초에 속도를 버림)', () => {
  // A: 초속 1m로 동쪽, 2초에 (10,10)에서 멈춤 · B: (10.5,10)에 서 있음 · 2~5초 둘이 한 덩어리(가운데 한 점) · 5초부터 A는 서쪽, B는 동쪽
  // 덩어리 동안 가려진 A의 옛 동쪽 속도를 계속 쓰면 A의 예측이 B 쪽으로 밀려 갈라질 때 번호가 바뀐다(실험으로 확인)
  const n = 80, A = i => { const t = i * DT; return t < 2 ? [8 + t, 10] : t < 5 ? [10, 10] : [10 - (t - 5), 10]; };
  const B = i => { const t = i * DT; return t < 5 ? [10.5, 10] : [10.5 + (t - 5), 10]; };
  const fr = frames(n, [[i => (i >= 20 && i < 50 ? [(A(i)[0] + B(i)[0]) / 2, 10] : A(i)), i => (i >= 20 && i < 50 ? null : B(i))], [still(30, 5)]]);
  const a = track(fr, 'classical-v2').find(p => near(at(p, 0), [8, 10]));
  assert.ok(near(at(a, n - 1), A(n - 1), 1e-3), `A 트랙 끝 ${at(a, n - 1)} (정답 ${A(n - 1)})`);
});

test('v2 인원 세기: 선 밖 0.75m 넘는 관중은 안 세고, 선 밖 0.5m 안을 뛰는 아이는 셈 · 선생님이 적은 인원이 먼저 · v1은 그대로', () => {
  // 팀A: 코트 안 2명 + 선 밖 1.2m 관중(조끼 색 비슷, 늘 보임) · 팀B: 코트 안 1명 + 선 밖 0.4m를 따라 뛰는 아이
  const fr = frames(60, [[still(10, 8), still(20, 12), i => [5 + 0.3 * i, -1.2]], [still(30, 10), i => [3 + 0.5 * i, -0.4]]]);
  assert.deepEqual(analyzeFrames(fr, cfg, { engine: 'classical-v1' }).counts, [3, 2], 'v1은 예전처럼 관중도 셈');
  const v2 = analyzeFrames(fr, cfg, { engine: 'classical-v2' });
  assert.deepEqual(v2.counts, [2, 2]);
  assert.ok(v2.players.every(p => p.path.every((v, k) => k % 2 === 0 || v > -1)), '관중을 따라가는 트랙이 없음');
  const teacher = { ...cfg, teams: [{ ...cfg.teams[0], count: 3 }, cfg.teams[1]] };
  // 선생님이 적은 인원(3)은 그대로 쓰지만, 코트 안에서 3명이 다 보이는 장면이 없으면 관중으로 시작하지 않고 팀 이름을 넣어 알려 줌
  assert.throws(() => analyzeFrames(fr, teacher, { engine: 'classical-v2' }), /'A' 팀 아이 3명이 코트 안에서 한꺼번에 보이는 장면이 없어요.*인원을 실제 인원으로 직접 적어/);
  const teacherB = { ...cfg, teams: [cfg.teams[0], { ...cfg.teams[1], count: 2 }] };
  assert.deepEqual(analyzeFrames(fr, teacherB, { engine: 'classical-v2' }).counts, [2, 2], '선생님이 적은 인원이 먼저');
});

test('짧은 틈 메우기: 0.3초 이하·초속 7m 이하만 직선으로 잇고, 더 길거나 빠른 틈은 가려짐으로 남김 (6~7m 경계 포함)', () => {
  const lin = i => [5 + 0.2 * i, 10]; // 초속 2m
  const gap2 = frames(40, [[i => (i === 10 || i === 11 ? null : lin(i)), still(30, 15)], [still(20, 5)]]);
  const a = track(gap2, 'classical-v2').find(p => near(at(p, 0), lin(0)));
  assert.equal(hiddenCount(a), 0);
  for (const i of [10, 11]) assert.ok(near(at(a, i), lin(i), 1e-4), `${i}번 장면 ${at(a, i)} ≠ ${lin(i)}`);
  const gap4 = frames(40, [[i => (i >= 10 && i < 14 ? null : lin(i)), still(30, 15)], [still(20, 5)]]);
  assert.equal(hiddenCount(track(gap4, 'classical-v2').find(p => near(at(p, 0), lin(0)))), 4, '0.4초 틈은 그대로');
  const jump = frames(40, [[i => (i < 10 ? [10, 10] : i < 12 ? null : [12.4, 10]), still(30, 15)], [still(20, 5)]]); // 0.3초에 2.4m = 초속 8m
  const j = track(jump, 'classical-v2').find(p => near(at(p, 0), [10, 10]));
  assert.equal(hiddenCount(j), 2, '빠른 틈은 메우지 않아 검수에서 보임');
  // 6~7m 경계: 0.3초(앞뒤 보인 장면 사이)에 1.95m = 초속 6.5m는 잇고, 2.25m = 초속 7.5m는 남김
  for (const [d, filled] of [[1.95, true], [2.25, false]]) {
    const fr = frames(40, [[i => (i < 10 ? [10, 10] : i < 12 ? null : [10 + d, 10]), still(30, 15)], [still(20, 5)]]);
    assert.equal(hiddenCount(track(fr, 'classical-v2').find(p => near(at(p, 0), [10, 10]))), filled ? 0 : 2, `초속 ${(d / 0.3).toFixed(1)}m`);
  }
  assert.equal(TRACK_V2.fillSpeed, 7);
  assert.equal(analyzeFrames(gap2, cfg, { engine: 'classical-v1' }).players.find(p => near([p.path[0], p.path[1]], lin(0), 1e-2)).hidden.slice(10, 12).join(), '1,1', 'v1은 그대로 가려짐');
});

test('(QA 재현) 오래 가려진 아이를 코트 밖(선 밖 0.75m 넘게) 비슷한 색 사람이 낚아채지 않음', () => {
  // 팀A: 아이1·아이2는 늘 보이고, 아이3은 사이드라인 가까이 (12,1.0)에 있다가 5.0초에 사라짐. 선 밖 1.2m (12,−1.2)에 비슷한 색 관중이 늘 서 있음
  // 예전에는 다시 잡는 허용 거리가 가려진 시간만큼 끝없이 커져 몇 초 뒤 관중을 따라감
  const spec = [12, -1.2], kid3 = i => (i < 50 ? [12, 1.0] : null);
  const fr = frames(90, [[still(10, 8), still(20, 12), kid3], [still(30, 10)]], () => [[spec], []]); // 9초: 5초 보이고 4초 가려짐 (QA는 8.3초부터 관중을 따라감)
  assert.deepEqual(analyzeFrames(fr, cfg).counts, [3, 1], '인원은 관중을 빼고 셈');
  const P = trackPlayers(fr, [3, 1], { engine: 'classical-v2', court: COURT }), c = P.find(p => near(at(p, 0), [12, 1.0]));
  for (let i = 0; i < 90; i++) assert.ok(!near(at(c, i), spec, 0.3), `${(i / 10).toFixed(1)}초에 관중 자리로 감`);
  assert.equal(c.hidden.slice(50).every(Boolean), true, '사라진 뒤로는 가려짐으로 남음 (검수에서 보임)');
  // 보이던 아이가 선 밖으로 나가는 건 지금처럼 따라감 (선 밖 1.2m까지)
  const out = frames(40, [[i => [12, 2 - 0.1 * i], still(20, 12)], [still(30, 10)]]); // 2m → −1.9m (선 밖 1.9m까지)
  const o = track(out, 'classical-v2').find(p => near(at(p, 0), [12, 2]));
  assert.equal(hiddenCount(o), 0);
  assert.ok(near(at(o, 32), [12, 2 - 3.2], 1e-4), '선 밖 1.2m에서도 보이던 아이는 계속 따라감');
});

test('다시 잡는 반경은 가려진 지 2초까지만 커짐: 오래 가려지면 25m 떨어진 가짜 검출은 안 잡고, 근처에 다시 나타난 아이는 잡음', () => {
  // 팀A 아이가 (5,10)에서 1.0초에 사라졌다 6.0초에 (6,10)에 다시 나타남. 4.0~5.0초에 같은 팀 색 가짜 검출이 코트 안 (30,10)에 보임
  const kid = i => (i < 10 ? [5, 10] : i < 60 ? null : [6, 10]), fake = i => [i >= 40 && i < 50 ? [[30, 10]] : [], []];
  const fr = frames(80, [[kid], [still(20, 3)]], fake);
  const a = track(fr, 'classical-v2').find(p => near(at(p, 0), [5, 10]));
  for (let i = 0; i < 80; i++) assert.ok(!near(at(a, i), [30, 10], 0.5), `${(i / 10).toFixed(1)}초에 25m 떨어진 가짜 검출로 감`);
  assert.ok(near(at(a, 70), [6, 10]) && a.hidden[70] === 0, '근처에 다시 나타난 아이는 다시 잡음');
  assert.equal(TRACK_V2.holdMax, 2);
});

test('(QA 재현) 코트 안에서 모든 팀이 한꺼번에 다 보이는 장면이 없어도 관중으로 시작하지 않고 팀마다 따로 시작', () => {
  // 팀A: 아이1 늘 보임·아이2는 짝수 장면만·선 밖 1.2m 관중 늘 보임 / 팀B: 아이3 늘 보임·아이4는 홀수 장면만
  // → 코트 안에서 두 팀이 한꺼번에 다 보이는 장면이 없다. 예전 v2는 관중까지 쳐서 시작 장면을 찾아 관중이 선수의 처음 자리가 됐음
  const spec = [15, -1.2], k2 = i => (i % 2 === 0 ? [20, 12] : null), k4 = i => (i % 2 === 1 ? [25, 6] : null);
  const fr = frames(60, [[still(10, 8), k2, () => spec], [still(30, 10), k4]]);
  const R = analyzeFrames(fr, cfg, { engine: 'classical-v2' });
  assert.deepEqual(R.counts, [2, 2]);
  assert.ok(R.players.every(p => p.path.every((v, k) => k % 2 === 1 || Math.hypot(v - spec[0], p.path[k + 1] - spec[1]) > 0.3)), '관중 자리에 간 트랙이 없음');
  const a = R.players.filter(p => p.team === 0);
  assert.ok(a.some(p => near([p.path[0], p.path[1]], [10, 8], 1e-2)) && a.some(p => near([p.path[0], p.path[1]], [20, 12], 1e-2)), '팀A는 아이1·아이2로 시작');
  const b = R.players.filter(p => p.team === 1);
  assert.ok(b.some(p => near([p.path[2], p.path[3]], [25, 6], 1e-2)), '팀B는 아이4가 보이는 장면에서 시작해 아이4를 잡음');
});
