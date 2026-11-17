// node --test tests/
// 원본·현재 결과 비교(js/review.js compareReviewResults) 계약 테스트.
// 약속: 모든 선수마다 { id, team, label, before, after, delta }, 지표는 KEYS, delta = after - before.
// 원본·현재 모두 recomputeStats와 같은 기준으로 다시 계산해서 비교한다(저장값 반올림 차이·낡은 값이 섞이지 않게).
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerStats, possession } from '../js/track.js';
import { analyzeFrames } from '../js/pipeline.js';
import { compareReviewResults, swapPlayerSegment, recomputeStats } from '../js/review.js';

const KEYS = ['distance', 'topSpeed', 'sprints', 'possession', 'touches', 'passes', 'received', 'lost'];
const DT = 0.1, toNaN = v => (v == null ? NaN : v);

// 분석 결과(pipeline.analyzeFrames)와 같은 모양의 합성 결과 (review.test.mjs와 같은 방식)
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
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const statsOf = p => Object.fromEntries(KEYS.map(k => [k, p[k]]));

/** 모든 행의 모양과 delta = after - before, 그리고 before/after가 각각 recomputeStats(원본/현재)와 같은지 */
function assertRows(rows, original, current) {
  const B = recomputeStats(original), A = recomputeStats(current);
  assert.ok(Array.isArray(rows), '배열이어야 함');
  assert.deepEqual(rows.map(r => r.id), original.players.map(p => p.id), '선수마다 한 행, 선수 순서');
  rows.forEach((r, k) => {
    assert.equal(r.team, original.players[k].team, `선수${k} 팀`);
    assert.equal(r.label, original.players[k].label, `선수${k} 이름표`);
    for (const key of KEYS) {
      for (const side of ['before', 'after', 'delta']) assert.ok(Number.isFinite(r[side]?.[key]), `선수${k} ${side}.${key} = ${r[side]?.[key]}`);
      assert.ok(near(r.delta[key], r.after[key] - r.before[key]), `선수${k} delta.${key} ≠ after - before`);
      assert.ok(near(r.before[key], B.players[k][key]), `선수${k} before.${key}: ${r.before[key]} ≠ 원본 재계산 ${B.players[k][key]}`);
      assert.ok(near(r.after[key], A.players[k][key]), `선수${k} after.${key}: ${r.after[key]} ≠ 현재 재계산 ${A.players[k][key]}`);
    }
  });
}
const zero = (r, msg) => KEYS.forEach(k => assert.equal(r.delta[k], 0, `${msg} delta.${k} = ${r.delta[k]}`));

// 자주 생기는 추적 오류: 2.0초부터 같은 팀 아이0·1의 번호가 바뀜. 실제로는 아이0 (5,5), 아이1 (15,5)에 서 있고
// 공은 아이0 → 아이1(패스, 2.0초) → 상대 아이2(뺏김, 4.0초)
const A0 = [5, 5], B0 = [15, 5], C0 = [30, 10];
const idSwitch = () => makeResult({
  n: 60,
  players: [{ team: 0, at: i => (i < 20 ? A0 : B0) }, { team: 0, at: i => (i < 20 ? B0 : A0) }, { team: 1, at: () => C0 }],
  ball: i => (i < 20 ? A0 : i < 40 ? B0 : C0),
});

// 실제 파이프라인 결과: 통계는 반올림 전 Float32 위치로 계산되고 경로는 0.01m로 반올림돼 저장됨
function pipelineResult() {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const dets = [];
  for (let t = 0; t <= 120; t += 1 / 7.3 + (rnd() - 0.5) * 0.02) {
    const kid = (k, ph) => [8 + 6 * k + 4 * Math.sin(t / (3 + k) + ph) + (rnd() - 0.5) * 0.08, 5 + 2 * k + 3 * Math.cos(t / (4 + k) + ph) + (rnd() - 0.5) * 0.08];
    dets.push({ t: +t.toFixed(3), players: [[0, 1, 2, 3].map(k => kid(k, 0)).filter(() => rnd() > 0.03), [0, 1, 2, 3].map(k => kid(k, 1.7))], ball: rnd() > 0.2 ? [[...kid(Math.floor(t / 15) % 4, 0), 1]] : [] });
  }
  return analyzeFrames(dets, { court: [40, 20], teams: [{ name: 'A', color: '#e33' }, { name: 'B', color: '#33e' }], width: 1280, height: 720, corners: [[0, 0], [1280, 0], [1280, 720], [0, 720]] });
}

test('비교: 같은 결과면 선수마다 한 행(id·팀·이름표)이고 모든 지표 delta 0, delta = after - before', () => {
  const R = idSwitch(), rows = compareReviewResults(R, structuredClone(R));
  assertRows(rows, R, R);
  rows.forEach(r => zero(r, `선수${r.id}`));
});

test('비교: 저장된 통계가 낡았거나 틀려도 경로가 같으면 delta 0 (두 쪽 모두 같은 기준으로 다시 계산)', () => {
  const R = idSwitch(), stale = structuredClone(R);
  stale.players.forEach(p => Object.assign(p, { distance: 999, topSpeed: 50, sprints: 7, possession: -5, touches: 9, passes: 42, received: 3, lost: 8 }));
  stale.passes = []; stale.turnovers = [];
  for (const [a, b] of [[stale, R], [R, stale], [stale, stale]]) {
    const rows = compareReviewResults(a, b);
    assertRows(rows, a, b);
    rows.forEach(r => zero(r, `선수${r.id}`));
    rows.forEach((r, k) => assert.deepEqual(r.before, { ...r.before, ...statsOf(recomputeStats(R).players[k]) }, `선수${k} before는 저장값(999 등)이 아니라 재계산값`));
  }
});

test('비교: 실제 파이프라인 결과는 다시 계산해도 저장값과 같은 숫자이고(분석 직후·다시 계산이 같은 함수·같은 0.01m 입력), 교정과 관계없는 아이는 delta 정확히 0', () => {
  const R = pipelineResult(), re = recomputeStats(R);
  // 분석 직후 저장값 = 다시 계산값 (예전엔 분석 직후만 반올림 전 위치로 세서 달랐음)
  R.players.forEach((p, k) => assert.deepEqual(statsOf(re.players[k]), statsOf(p), `선수${k} 저장값 = 다시 계산값`));
  assert.deepEqual([re.passes, re.turnovers, re.hiddenRate], [R.passes, R.turnovers, R.hiddenRate]);
  const cur = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 40, end: 70 });
  const rows = compareReviewResults(R, cur);
  assertRows(rows, R, cur);
  rows.slice(2).forEach(r => zero(r, `관계없는 선수${r.id}`));
  assert.ok(rows.slice(0, 2).some(r => r.delta.distance !== 0), '교정한 두 아이는 거리가 달라져야 함');
});

test('비교 실제 사례: 번호를 바로잡으면 패스·뺏김·공 소유·터치 변화가 아이별로 보인다', () => {
  const R = idSwitch(), cur = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 5.9 });
  const rows = compareReviewResults(R, cur);
  assertRows(rows, R, cur);
  const pick = r => [r.delta.possession, r.delta.touches, r.delta.passes, r.delta.received, r.delta.lost].map(v => +v.toFixed(6));
  assert.deepEqual(pick(rows[0]), [-2, 0, 1, 0, -1], '아이0: 공을 4초 → 2초, 패스 1번 보냄, 뺏김 1 → 0');
  assert.deepEqual(pick(rows[1]), [2, 1, 0, 1, 1], '아이1: 공 2초·터치 1번 생김, 패스 1번 받음, 뺏김 1');
  zero(rows[2], '상대 아이2');
  assert.deepEqual([rows[0].before.lost, rows[0].after.lost, rows[1].after.received], [1, 0, 1]);
});

test('비교: 전체 구간을 맞바꾸면 두 아이의 거리·최고 속도·질주 변화가 정확히 서로 반대', () => {
  const k0 = i => [2 + 0.2 * Math.min(i, 50) + 0.5 * Math.max(0, Math.min(i, 70) - 50), 5]; // 2m/s로 5초, 5m/s로 2초 질주
  const k1 = i => [30 - 0.1 * i, 15]; // 1m/s로 걸음
  const R = makeResult({ n: 101, players: [{ team: 0, at: k0 }, { team: 0, at: k1 }, { team: 1, at: () => [20, 10] }] });
  const rows = compareReviewResults(R, swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 0, end: 10 }));
  assertRows(rows, R, swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 0, end: 10 }));
  assert.ok(rows[0].before.distance > rows[1].before.distance + 5 && rows[0].before.sprints >= 1, '준비: 아이0이 더 많이 뛰고 질주함');
  for (const k of ['distance', 'topSpeed', 'sprints']) {
    assert.ok(near(rows[0].delta[k], rows[1].before[k] - rows[0].before[k], 1e-6), `아이0 delta.${k}`);
    assert.ok(near(rows[1].delta[k], -rows[0].delta[k], 1e-6), `아이1 delta.${k}는 아이0의 반대`);
  }
  assert.ok(rows[0].delta.distance < -5);
  zero(rows[2], '관계없는 아이2');
});

test('비교: 원본·현재 입력은 그대로 (깊은 동결·스냅숏)', () => {
  const R = idSwitch(), cur = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 5.9 });
  const r0 = structuredClone(R), c0 = structuredClone(cur);
  deepFreeze(R); deepFreeze(cur); // 안에서 고치려 하면 TypeError
  const rows = compareReviewResults(R, cur);
  assert.deepEqual(R, r0); assert.deepEqual(cur, c0);
  rows.forEach((r, k) => { assert.notEqual(r.before, R.players[k]); assert.notEqual(r.after, cur.players[k]); });
});

test('비교: null 공·위치 모름 칸이 있어도 NaN 없이 계산', () => {
  const R = makeResult({
    n: 60,
    players: [
      { team: 0, at: i => (i >= 25 && i < 30 ? null : [2, 2]), hidden: i => i >= 25 && i < 30 },
      { team: 0, at: () => [2, 2.2] },
      { team: 1, at: () => [30, 10] },
    ],
    ball: i => (i >= 20 && i < 35 ? [0.4, 0.4] : null),
  });
  const cur = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 2, end: 3.9 });
  assertRows(compareReviewResults(R, cur), R, cur);
});

test('비교: 선수 수·팀·dt·코트가 다르면 거부(throw)하고 입력은 그대로', () => {
  const R = idSwitch(), snap = structuredClone(R);
  const variant = f => { const x = structuredClone(R); f(x); return x; };
  const bad = {
    '선수 수': variant(x => { x.players.pop(); x.counts = [2, 0]; }),
    '팀': variant(x => { x.players[1].team = 1; }),
    'dt': variant(x => { x.dt = 0.2; }),
    '코트 크기': variant(x => { x.court = [42, 20]; }),
  };
  for (const [why, cur] of Object.entries(bad)) {
    assert.throws(() => compareReviewResults(R, cur), Error, `현재 쪽 ${why} 불일치`);
    assert.throws(() => compareReviewResults(cur, R), Error, `원본 쪽 ${why} 불일치`);
  }
  assert.throws(() => compareReviewResults(R, null), Error, '현재 결과 없음');
  assert.throws(() => compareReviewResults(undefined, R), Error, '원본 결과 없음');
  assert.deepEqual(R, snap);
});

test('비교: 영상 길이(칸 수)가 다른 두 결과는 같은 수업이 아니므로 거부', () => {
  const R = idSwitch(), longer = makeResult({ n: 70, players: [{ team: 0, at: () => A0 }, { team: 0, at: () => B0 }, { team: 1, at: () => C0 }] });
  assert.throws(() => compareReviewResults(R, longer), Error);
});
