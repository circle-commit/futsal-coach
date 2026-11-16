// node --test tests/
// 검수·교정(js/review.js) 계약 테스트. 결과 모양은 pipeline.analyzeFrames 출력과 같게 합성하고,
// 통계는 분석 때와 같은 함수(track.js)로 미리 계산해 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerStats, possession } from '../js/track.js';
import { computeTactics } from '../js/tactics.js';
import { findReviewSegments, swapPlayerSegment } from '../js/review.js';

const DT = 0.1;
const toNaN = v => (v == null ? NaN : v);

/** players: [{ team, at: i => [x,y] | null, hidden?: i => bool }], ball: i => [x,y] | null (null = 모름) */
function makeResult({ n, players, ball = () => null, court = [40, 20] }) {
  const teams = [{ name: 'A', color: '#e33' }, { name: 'B', color: '#33e' }];
  const flat = f => { const a = []; for (let i = 0; i < n; i++) { const p = f(i); a.push(p ? p[0] : null, p ? p[1] : null); } return a; };
  const path = players.map(p => flat(p.at)), hidden = players.map(p => Array.from({ length: n }, (_, i) => (p.hidden?.(i) ? 1 : 0)));
  const b = flat(ball);
  const pz = possession(Float32Array.from(b, toNaN), players.map((p, k) => ({ team: p.team, pos: Float32Array.from(path[k], toNaN) })), DT);
  const num = {};
  const out = players.map((p, id) => {
    num[p.team] = (num[p.team] || 0) + 1;
    const s = playerStats(Float32Array.from(path[id], toNaN), hidden[id], DT);
    return {
      id, team: p.team, label: `${teams[p.team].name} ${num[p.team]}`, distance: s.distance, topSpeed: s.topSpeed, sprints: s.sprints,
      possession: pz.time[id], touches: pz.touches[id], passes: pz.passes.filter(x => x.from === id).length,
      received: pz.passes.filter(x => x.to === id).length, lost: pz.turnovers.filter(x => x.from === id).length,
      path: path[id], hidden: hidden[id],
    };
  });
  let seen = 0; for (let i = 0; i < n; i++) if (b[2 * i] != null) seen++;
  return {
    dt: DT, court, teams, counts: [0, 1].map(t => players.filter(p => p.team === t).length), duration: +((n - 1) * DT).toFixed(1),
    players: out, ball: b, passes: pz.passes, turnovers: pz.turnovers,
    hiddenRate: out.reduce((a, p) => a + p.hidden.reduce((x, y) => x + y, 0) / n, 0) / out.length, ballSeen: seen / n,
    video: { width: 1280, height: 720, corners: [[100, 50], [1180, 50], [1230, 690], [50, 690]] },
  };
}

const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const at = (R, id, i) => [R.players[id].path[2 * i], R.players[id].path[2 * i + 1]];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const pick = p => ({ distance: p.distance, topSpeed: p.topSpeed, sprints: p.sprints, possession: p.possession, touches: p.touches, passes: p.passes, received: p.received, lost: p.lost });
const assertStatsNear = (got, want, msg) => {
  for (const k of ['distance', 'topSpeed', 'possession']) assert.ok(near(got[k], want[k]), `${msg} ${k}: ${got[k]} ≠ ${want[k]}`);
  for (const k of ['sprints', 'touches', 'passes', 'received', 'lost']) assert.equal(got[k], want[k], `${msg} ${k}`);
};

// 자주 생기는 추적 오류: 한 아이를 놓쳤다가 다시 잡을 때 같은 팀 다른 아이와 번호가 바뀜(2.0초).
// 실제로는 아이0은 (5,5), 아이1은 (15,5)에 서 있고, 공은 아이0 → 아이1(패스, 2.0초) → 상대 아이2(뺏김, 4.0초).
const A = [5, 5], B = [15, 5], C = [30, 10];
const idSwitch = () => makeResult({
  n: 60,
  players: [
    { team: 0, at: i => (i < 20 ? A : B) }, // 2.0초부터 아이1의 자리를 따라감 (10m 순간이동)
    { team: 0, at: i => (i < 20 ? B : A) },
    { team: 1, at: () => C },
  ],
  ball: i => (i < 20 ? A : i < 40 ? B : C),
});

// 칸마다 값이 달라서 어디가 바뀌었는지 정확히 보이는 결과 (팀0: 0·1·2, 팀1: 3)
const distinct = () => makeResult({
  n: 20,
  players: [0, 1, 2, 3].map(k => ({ team: k < 3 ? 0 : 1, at: i => [2 + 5 * k + i / 100, 3 + k], hidden: i => (i + k) % 4 === 0 })),
});

// ---------------------------------------------------------------- 구간 교환

test('검수 교환: 입력 결과는 그대로 두고 새 결과를 돌려준다', () => {
  const R = idSwitch(), before = structuredClone(R);
  deepFreeze(R); // 안에서 입력을 고치려 하면 TypeError
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 5.9 });
  assert.deepEqual(R, before);
  assert.notEqual(out, R);
  assert.notEqual(out.players, R.players);
  for (const k of [0, 1]) { assert.notEqual(out.players[k].path, R.players[k].path); assert.notEqual(out.players[k].hidden, R.players[k].hidden); }
});

// 가려짐은 경로와 똑같이 정확히 맞바꾼다 (경계 가짜 이동은 가려짐을 고치지 않고 별도 경계 정보로 뺀다는 합의)
const assertHiddenSwapped = (out, R, a, b, i0, i1) => {
  for (const [k, other] of [[a, b], [b, a]]) for (let i = 0; i < R.players[a].hidden.length; i++)
    assert.equal(out.players[k].hidden[i], R.players[i >= i0 && i <= i1 ? other : k].hidden[i], `선수${k} 가려짐 ${i}번 칸`);
};
const hiddenRateOf = R => R.players.reduce((a, p) => a + p.hidden.reduce((x, y) => x + y, 0) / p.hidden.length, 0) / R.players.length;

test('검수 교환: [start,end] 칸만 두 선수의 경로·가려짐을 맞바꾸고, 구간 밖·다른 선수·나머지 정보는 그대로', () => {
  const R = distinct(), n = 20;
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 0.3, end: 0.7 }); // 0.3/0.1 = 2.9999… 이어도 3번 칸부터, 0.7은 7번 칸까지
  for (let i = 0; i < n; i++) {
    const inside = i >= 3 && i <= 7;
    assert.deepEqual(at(out, 0, i), at(R, inside ? 1 : 0, i), `선수0 경로 ${i}번 칸`);
    assert.deepEqual(at(out, 1, i), at(R, inside ? 0 : 1, i), `선수1 경로 ${i}번 칸`);
  }
  assertHiddenSwapped(out, R, 0, 1, 3, 7);
  for (const k of [2, 3]) { assert.deepEqual(out.players[k].path, R.players[k].path); assert.deepEqual(out.players[k].hidden, R.players[k].hidden); }
  assert.deepEqual(out.players.map(p => [p.id, p.team, p.label, p.path.length, p.hidden.length]), R.players.map(p => [p.id, p.team, p.label, p.path.length, p.hidden.length]));
  for (const k of ['dt', 'court', 'teams', 'counts', 'duration', 'ball', 'video', 'ballSeen']) assert.deepEqual(out[k], R[k], k);
  assert.ok(near(out.hiddenRate, hiddenRateOf(out)) && near(out.hiddenRate, R.hiddenRate), `hiddenRate: ${out.hiddenRate} (배열로 다시 센 값 ${hiddenRateOf(out)}, 원래 ${R.hiddenRate})`);
});

test('검수 교환: 같은 구간을 두 번 바꾸면 경로·가려짐이 원래대로 돌아온다', () => {
  const R = idSwitch(), arg = { playerA: 0, playerB: 1, start: 1.5, end: 3.2 };
  const back = swapPlayerSegment(swapPlayerSegment(R, arg), arg);
  for (const k of [0, 1, 2]) { assert.deepEqual(back.players[k].path, R.players[k].path, `선수${k} 경로`); assert.deepEqual(back.players[k].hidden, R.players[k].hidden, `선수${k} 가려짐`); }
  assert.deepEqual(back.ball, R.ball);
});

test('검수 교환: 한 칸 구간(start = end)도 정확히 그 칸만 바꾼다', () => {
  const R = distinct();
  const out = swapPlayerSegment(R, { playerA: 1, playerB: 2, start: 1.2, end: 1.2 });
  for (let i = 0; i < 20; i++) assert.deepEqual(at(out, 1, i), at(R, i === 12 ? 2 : 1, i), `${i}번 칸`);
});

test('검수 교환: 잘못된 선수·다른 팀·잘못된 시간은 거부하고 입력은 그대로', () => {
  const R = distinct(), before = structuredClone(R), ok = { playerA: 0, playerB: 1, start: 0.2, end: 0.8 };
  const bad = {
    '같은 선수': { ...ok, playerB: 0 },
    '없는 선수': { ...ok, playerB: 99 },
    '음수 번호': { ...ok, playerA: -1 },
    '정수 아닌 번호': { ...ok, playerA: 0.5 },
    '선수 빠짐': { playerB: 1, start: 0.2, end: 0.8 },
    '다른 팀': { ...ok, playerB: 3 },
    '시작이 끝보다 늦음': { ...ok, start: 0.8, end: 0.2 },
    '시작 NaN': { ...ok, start: NaN },
    '끝 없음': { playerA: 0, playerB: 1, start: 0.2 },
    '음수 시간': { ...ok, start: -1 },
    '영상 밖 구간': { ...ok, start: 50, end: 60 },
  };
  for (const [why, arg] of Object.entries(bad)) assert.throws(() => swapPlayerSegment(R, arg), Error, why);
  assert.throws(() => swapPlayerSegment(R), Error, '인자 없음');
  assert.deepEqual(R, before);
});

test('검수 교환 실제 사례: 번호가 바뀐 두 아이를 바로잡으면 패스·뺏김·공 소유가 다시 계산된다', () => {
  const R = idSwitch();
  // 고치기 전(추적 오류 그대로): 아이0이 공을 계속 가진 것처럼 보이고 패스가 사라짐
  assert.deepEqual(R.passes, []);
  assert.deepEqual(R.turnovers.map(x => [x.from, x.to, x.t]), [[0, 2, 4]]);
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 5.9 });
  for (let i = 0; i < 60; i++) { assert.deepEqual(at(out, 0, i), A); assert.deepEqual(at(out, 1, i), B); }
  assert.deepEqual(out.passes.map(x => [x.from, x.to, x.t]), [[0, 1, 2]]);
  assert.deepEqual(out.turnovers.map(x => [x.from, x.to, x.t]), [[1, 2, 4]]);
  const [p0, p1, p2] = out.players;
  assert.deepEqual([p0.passes, p0.received, p0.lost, p0.touches], [1, 0, 0, 1]);
  assert.deepEqual([p1.passes, p1.received, p1.lost, p1.touches], [0, 1, 1, 1]);
  assert.ok(near(p0.possession, 2) && near(p1.possession, 2) && near(p2.possession, 2), JSON.stringify(out.players.map(p => p.possession)));
});

test('검수 교환: 경로가 바뀌면 거리·최고 속도·질주도 다시 계산된다 (전체 구간이면 두 선수 통계가 정확히 맞바뀜)', () => {
  const n = 101;
  const k0 = i => [2 + 0.2 * Math.min(i, 50) + 0.5 * Math.max(0, Math.min(i, 70) - 50), 5]; // 2m/s로 5초, 5m/s로 2초 질주, 그다음 섬
  const k1 = i => [30 - 0.1 * i, 15]; // 1m/s로 걸음
  const R = makeResult({ n, players: [{ team: 0, at: k0 }, { team: 0, at: k1 }, { team: 1, at: () => [20, 10] }], ball: i => (i < 30 ? k0(i) : i < 60 ? k1(i) : [20, 10]) });
  assert.ok(R.players[0].sprints >= 1 && R.players[0].distance > R.players[1].distance + 5, '준비: 아이0이 더 많이 뛰고 질주함');
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 0, end: 10 });
  assertStatsNear(pick(out.players[0]), pick(R.players[1]), '새 선수0 = 옛 선수1');
  assertStatsNear(pick(out.players[1]), pick(R.players[0]), '새 선수1 = 옛 선수0');
  assertStatsNear(pick(out.players[2]), pick(R.players[2]), '관련 없는 선수2');
  const swapId = id => (id === 0 ? 1 : id === 1 ? 0 : id);
  assert.deepEqual(out.passes, R.passes.map(x => ({ ...x, from: swapId(x.from), to: swapId(x.to) })));
  assert.deepEqual(out.turnovers, R.turnovers.map(x => ({ ...x, from: swapId(x.from), to: swapId(x.to) })));
});

// 두 아이 모두 6초 내내 제자리. 3m 떨어진 둘을 2.0~3.9초만 바꾸면 경계마다 3m 점프가 생긴다
// (0.5초 평균을 거치면 6m/s → 질주로 잘못 셀 수 있는 크기. 9m/s 넘는 큰 튐만 원래 규칙으로 빠짐)
const standingApart = () => makeResult({ n: 60, players: [{ team: 0, at: () => [10, 10] }, { team: 0, at: () => [13, 10] }, { team: 1, at: () => [30, 10] }] });

test('교환 경계: 떨어져 서 있던 두 아이를 맞바꿔도 경계의 순간 점프가 뛴 거리·최고 속도·질주로 잡히지 않는다', () => {
  const out = swapPlayerSegment(standingApart(), { playerA: 0, playerB: 1, start: 2, end: 3.9 });
  assert.deepEqual(at(out, 0, 25), [13, 10], '경로는 실제로 바뀌어야 함');
  for (const k of [0, 1]) {
    const p = out.players[k];
    assert.ok(p.distance < 0.5 && p.sprints === 0 && p.topSpeed < 1, `선수${k}: ${JSON.stringify(pick(p))}`);
  }
});

test('교환 경계: 전술 화면 "뛴 거리 순위"(computeTactics 누적 거리)에도 경계 점프가 들어가지 않는다', () => {
  const t = computeTactics(swapPlayerSegment(standingApart(), { playerA: 0, playerB: 1, start: 2, end: 3.9 }));
  for (const k of [0, 1]) assert.ok(t.cum[k][59] < 0.5, `전술 누적 거리 선수${k}: ${t.cum[k][59].toFixed(2)}m (실제로는 제자리)`);
});

test('null 공: 공 위치를 모르는 칸(null)을 (0,0)으로 보지 않는다', () => {
  // 공은 1초 동안만 보이고 나머지는 null. 코트 구석 (0.3,0.3)에 상대 아이가 서 있다
  const R = makeResult({
    n: 60,
    players: [{ team: 0, at: () => [10, 10] }, { team: 0, at: () => [14, 10] }, { team: 1, at: () => [0.3, 0.3] }],
    ball: i => (i >= 10 && i < 20 ? [10, 10] : null),
  });
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 1, end: 1.9 });
  assert.equal(out.players[2].possession, 0, '구석 아이가 null 공을 가진 것으로 계산됨');
  assert.equal(out.players[2].touches, 0);
  assert.ok(out.passes.concat(out.turnovers).every(x => x.from !== 2 && x.to !== 2), JSON.stringify(out.turnovers));
  assert.ok(near(out.players[1].possession, 1), '공은 1초 동안 선수1 자리(10,10)에 있었음');
  assert.deepEqual(out.ball, R.ball, 'null은 null로 남아야 함 (0·NaN 아님)');
});

test('null 좌표: 경로에 위치 모름(null) 칸이 있어도 교환·재계산이 NaN·가짜 이동·가짜 공 소유를 만들지 않는다', () => {
  // 아이0은 2.5~2.9초 위치를 모름(null, 가려짐). 그동안 공은 코트 구석 (0.4,0.4)에 혼자 있음.
  // 두 아이를 0.2m 옆에 둬서 경계 점프(경계 보호 테스트가 따로 봄)와 섞이지 않게 함
  const R = makeResult({
    n: 60,
    players: [
      { team: 0, at: i => (i >= 25 && i < 30 ? null : [2, 2]), hidden: i => i >= 25 && i < 30 },
      { team: 0, at: () => [2, 2.2] },
      { team: 1, at: () => [30, 10] },
    ],
    ball: i => (i >= 20 && i < 35 ? [0.4, 0.4] : null),
  });
  const out = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 3.9 });
  for (let i = 25; i < 30; i++) assert.deepEqual(at(out, 1, i), [null, null], `${i}번 칸: null이 0이나 NaN으로 바뀜`);
  for (const p of out.players) {
    for (const k of ['distance', 'topSpeed', 'possession']) assert.ok(Number.isFinite(p[k]), `선수${p.id} ${k} = ${p[k]}`);
    assert.equal(p.possession, 0, `선수${p.id}: 위치 모름을 (0,0)으로 봐서 구석 공을 가진 것으로 계산됨`);
  }
  assert.ok(out.players[1].distance < 1, `선수1 거리 ${out.players[1].distance}`);
  assert.doesNotThrow(() => findReviewSegments(out));
});

test('저장 형식 유지: 교환 결과는 JSON으로 저장·백업했다 되살려도 같다 (형식 배열·NaN 없음)', () => {
  const out = swapPlayerSegment(idSwitch(), { playerA: 0, playerB: 1, start: 2, end: 5.9 });
  for (const p of out.players) assert.ok(Array.isArray(p.path) && Array.isArray(p.hidden), `선수${p.id} path/hidden은 일반 배열이어야 함`);
  assert.ok(Array.isArray(out.ball) && Array.isArray(out.passes) && Array.isArray(out.turnovers));
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

// ---------------------------------------------------------------- 검수 후보

test('검수 후보: 오래 가려진 구간과 순간이동을 찾아 선수·시간(초)·이유로 알려 주고, 깨끗한 선수는 건드리지 않는다', () => {
  const n = 80;
  const R = makeResult({
    n,
    players: [
      { team: 0, at: () => [5, 5], hidden: i => i >= 30 && i < 50 }, // 3.0~4.9초 가려짐
      { team: 0, at: i => (i < 20 ? [10, 5] : [18, 5]) }, // 2.0초에 8m 순간이동
      { team: 0, at: i => [5 + 0.2 * i, 15] }, // 2m/s로 고르게 달림
      { team: 1, at: () => [30, 10] },
    ],
  });
  deepFreeze(R);
  const segs = findReviewSegments(R);
  assert.ok(Array.isArray(segs));
  for (const s of segs) {
    assert.ok(Number.isInteger(s.playerId) && s.playerId >= 0 && s.playerId < 4, JSON.stringify(s));
    assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.start <= s.end && s.end <= R.duration + 1e-9, JSON.stringify(s));
    assert.ok(typeof s.reason === 'string' && s.reason.length > 0, JSON.stringify(s));
  }
  const hid = segs.filter(s => s.playerId === 0);
  assert.ok(hid.some(s => s.start <= 3.0 + 1e-9 && s.end >= 4.9 - 1e-9 && s.start >= 1.5 && s.end <= 6.5), `가려짐 후보: ${JSON.stringify(hid)}`);
  const jump = segs.filter(s => s.playerId === 1);
  assert.ok(jump.some(s => s.start <= 2.0 + 1e-9 && s.end >= 1.9 - 1e-9 && s.end - s.start <= 3), `순간이동 후보: ${JSON.stringify(jump)}`);
  assert.notEqual(hid[0].reason, jump[0].reason, '가려짐과 순간이동은 이유가 달라야 함');
  assert.deepEqual(segs.filter(s => s.playerId === 2 || s.playerId === 3), [], '깨끗한 선수에 후보가 생김');
});

test('검수 후보 → 교환 → 후보 사라짐: 번호 바뀜이 순간이동 후보로 잡히고, 바로잡으면 사라진다', () => {
  const R = idSwitch();
  const before = findReviewSegments(R);
  for (const k of [0, 1]) assert.ok(before.some(s => s.playerId === k && s.start <= 2.0 + 1e-9 && s.end >= 1.9 - 1e-9), `선수${k} 후보 없음: ${JSON.stringify(before)}`);
  assert.ok(!before.some(s => s.playerId === 2));
  const after = findReviewSegments(swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 5.9 }));
  assert.deepEqual(after, [], `바로잡은 뒤에도 후보가 남음: ${JSON.stringify(after)}`);
});

test('검수 후보: 공이 전부 null이거나 아무 문제 없는 결과도 안전하게 빈 목록', () => {
  const R = makeResult({ n: 40, players: [{ team: 0, at: i => [5 + 0.1 * i, 5] }, { team: 1, at: () => [20, 10] }] });
  assert.deepEqual(findReviewSegments(R), []);
});
