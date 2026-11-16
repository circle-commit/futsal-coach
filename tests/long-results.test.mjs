// 긴 영상 결과 회귀: 장면 수만큼 긴 배열을 Math.max(...배열)로 펼치면 인자 수 한계(V8 기본 스택에서 약 12만 개)를 넘어 RangeError가 난다.
// 로컬 분석은 긴 수업 영상을 다루므로, 활동량(최고 속도)·교정 재계산·전술 계산이 10fps 기준 수 시간 분량에서도 같은 규칙으로 돌아야 한다.
// (결과 화면의 팀 간격 그래프·전술 면적 그래프 최댓값은 DOM 코드라 브라우저에서 따로 확인)
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerStats } from '../js/track.js';
import { recomputeStats, swapPlayerSegment, compareReviewResults } from '../js/review.js';
import { computeTactics } from '../js/tactics.js';

const DT = 0.1;
// track.js movAvg와 같은 순서로 더하는 기준값 (같은 값인지 정확히 비교하려고 따로 둔다)
const movAvg = (a, k) => a.length < k ? [] : a.slice(0, a.length - k + 1).map((_, i) => { let s = 0; for (let j = 0; j < k; j++) s += a[i + j]; return s / k; });
const topSpeedRef = s => { const v1 = movAvg(s.speed, Math.round(1 / DT)); return v1.length ? Math.max(...v1) : 0; }; // 짧은 배열이라 펼쳐도 됨

/** 반지름 r m 원을 도는 경로. speedAt(i): 그 칸의 속도 m/s (각속도를 적분해서 위치가 끊기지 않음) */
function circlePath(n, speedAt, r = 4, cx = 17, cy = 7) {
  const pos = new Float32Array(2 * n);
  let th = 0;
  for (let i = 0; i < n; i++) { pos[2 * i] = cx + r * Math.cos(th); pos[2 * i + 1] = cy + r * Math.sin(th); th += (speedAt(i) / r) * DT; }
  return pos;
}

test('긴 경로: 10시간 분량(36만 칸)에서도 playerStats가 RangeError 없이 같은 규칙으로 최고 속도·질주·거리를 낸다', () => {
  const n = 360000, b0 = 200000, b1 = b0 + 30; // 3초 동안만 초속 5m, 나머지는 초속 2m
  const s = playerStats(circlePath(n, i => (i >= b0 && i < b1 ? 5 : 2)), new Uint8Array(n), DT);
  assert.ok(s.topSpeed > 4.8 && s.topSpeed <= 5.01, `최고 속도 ${s.topSpeed}`); // 1초 평균이라 3초 질주 안에서 거의 5
  assert.equal(s.sprints, 1);
  const want = 2 * (n - 1) * DT + 3 * 3; // 초속 2m로 전체 + 질주 3초 동안 초속 3m 더
  assert.ok(Math.abs(s.distance - want) / want < 0.01, `거리 ${s.distance} (기대 약 ${want})`);
  assert.equal(s.speed.length, n - 5);
  // 최고 속도 = 1초 평균 속도의 최댓값 (펼치지 않고 하나씩 비교한 값이 정의와 정확히 같음)
  let m = -Infinity; for (const x of movAvg(s.speed, 10)) m = Math.max(m, x);
  assert.equal(s.topSpeed, m);
});

test('같은 값: 보통 길이에서는 최고 속도가 예전 계산(Math.max(...1초 평균))과 정확히 같다', () => {
  // 걷기·질주·가려짐·추적 튐(초속 9m 초과)이 섞인 결정적 경로
  const n = 3000, pos = new Float32Array(2 * n), hidden = new Uint8Array(n);
  let x = 10, y = 5, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const fast = i % 400 > 330;
    x += (rnd() - 0.45) * (fast ? 1.1 : 0.3); y += (rnd() - 0.5) * (fast ? 0.8 : 0.2);
    if (i === 1500) x += 6; // 추적 튐
    pos[2 * i] = x; pos[2 * i + 1] = y;
    hidden[i] = i % 700 > 680 ? 1 : 0;
  }
  const s = playerStats(pos, hidden, DT);
  assert.ok(s.topSpeed > 0 && s.sprints > 0, JSON.stringify({ top: s.topSpeed, sprints: s.sprints }));
  assert.ok(Object.is(s.topSpeed, topSpeedRef(s)), `${s.topSpeed} vs ${topSpeedRef(s)}`);
  // 경계: 가만히 있으면 0, 칸이 짧아 1초 평균이 없으면 0, 12칸 미만이면 0
  const still = playerStats(new Float32Array(2 * 200).fill(3), new Uint8Array(200), DT);
  assert.ok(Object.is(still.topSpeed, 0) && Object.is(topSpeedRef(still), 0));
  for (const len of [11, 14]) assert.equal(playerStats(circlePath(len, () => 3), new Uint8Array(len), DT).topSpeed, 0, `${len}칸`);
});

test('긴 결과: 3.6시간 분량(13만 칸) 결과를 교정 재계산·전후 비교·전술 계산해도 오류 없이 값이 나온다', () => {
  const n = 130000, team = (id, t, cx, cy, sp) => {
    const pos = circlePath(n, () => sp, 3, cx, cy);
    return { id, team: t, label: `${t ? '보라' : '파랑'} ${id % 2 + 1}`, path: Array.from(pos, v => Math.round(v * 100) / 100), hidden: new Array(n).fill(0) };
  };
  const players = [team(0, 0, 8, 5, 2), team(1, 0, 8, 9, 2.5), team(2, 1, 26, 5, 1.5), team(3, 1, 26, 9, 3)];
  const ball = []; for (let i = 0; i < n; i++) { const p = players[(i / 300 | 0) % 4].path; ball.push(p[2 * i], p[2 * i + 1]); } // 30초마다 다른 아이 발밑
  const R = recomputeStats({ dt: DT, court: [35, 13.7], teams: [{ name: '파랑', color: '#1f8fe0' }, { name: '보라', color: '#8a6fc9' }], counts: [2, 2],
    duration: +((n - 1) * DT).toFixed(1), players, ball, passes: [], turnovers: [], hiddenRate: 0, ballSeen: 1,
    video: { width: 1280, height: 720, corners: [[104, 168], [1256, 168], [1256, 616], [106.7, 616]] } });
  R.players.forEach((p, k) => {
    const sp = [2, 2.5, 1.5, 3][k];
    assert.ok(Math.abs(p.topSpeed - sp) < 0.1 && Math.abs(p.distance - sp * (n - 1) * DT) / (sp * n * DT) < 0.02, `${p.label}: ${p.topSpeed} m/s, ${p.distance} m`);
  });
  const sw = swapPlayerSegment(R, { playerA: 0, playerB: 1, start: 3600, end: 7200 });
  const cmp = compareReviewResults(R, sw);
  assert.equal(cmp.length, 4);
  assert.ok(cmp.every(r => Object.values(r.delta).every(Number.isFinite)));
  assert.ok(cmp[0].delta.distance > 0 && cmp[1].delta.distance < 0, JSON.stringify(cmp.map(r => r.delta.distance))); // 느린 아이 ↔ 빠른 아이 1시간 맞바꿈
  const tc = computeTactics(sw);
  assert.equal(tc.N, n);
  assert.ok(tc.cum.every(c => Number.isFinite(c[n - 1]) && c[n - 1] > 0));
  assert.ok([0, 1].every(t => tc.metrics[t].area.length === n));
});
