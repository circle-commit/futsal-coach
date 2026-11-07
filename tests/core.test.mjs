// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { homography, applyH, morph, components, colorFromClick } from '../js/vision.js';
import { assign, trackPlayers, playerStats, possession, trackBall, resample } from '../js/track.js';

test('호모그래피: 모서리 4점이 코트 꼭짓점으로 간다', () => {
  const src = [[100, 50], [900, 60], [950, 500], [80, 480]], dst = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const H = homography(src, dst);
  src.forEach((p, i) => applyH(H, ...p).forEach((v, k) => assert.ok(Math.abs(v - dst[i][k]) < 1e-6)));
});

test('헝가리안: 합이 가장 작은 짝, 직사각 행렬도', () => {
  assert.deepEqual(assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(assign([[1, 9], [9, 1], [5, 5]]), [0, 1, -1]);
});

test('팽창·침식과 덩어리 세기', () => {
  const w = 9, h = 5, m = new Uint8Array(w * h); m[2 * w + 2] = 1; m[2 * w + 6] = 1;
  assert.equal(components(m, w, h).n, 2);
  assert.equal(components(morph(m, w, h, 2, true), w, h).n, 1); // 팽창하면 붙는다
  assert.equal(morph(morph(m, w, h, 1, false), w, h, 1, true).reduce((a, b) => a + b, 0), 0); // 열기로 점 잡티 제거
});

test('팀 색 잡기: 빨간 조끼를 찍으면 0°를 넘는 범위', () => {
  const w = 20, h = 20, f = new Uint8ClampedArray(w * h * 4), bg = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { bg.set([30, 120, 60, 255], i * 4); f.set(i % 2 ? [230, 20, 40, 255] : [235, 40, 20, 255], i * 4); }
  const c = colorFromClick(f, bg, w, h, 10, 10, 8);
  assert.ok(c.hue[0] > c.hue[1], JSON.stringify(c)); // 예: [350, 10]
});

test('추적: 가까운 선수끼리 번호가 안 바뀌고, 가려지면 위치 유지', () => {
  const fr = [
    { t: 0, players: [[[0, 0], [5, 0]]], ball: [] },
    { t: 0.1, players: [[[5.1, 0], [0.1, 0]]], ball: [] },
    { t: 0.2, players: [[[0.2, 0]]], ball: [] },
  ];
  const [a, b] = trackPlayers(fr, [2]);
  assert.deepEqual(Array.from(a.pos).map(v => +v.toFixed(1)), [0, 0, 0.1, 0, 0.2, 0]);
  assert.deepEqual(Array.from(b.hidden), [0, 0, 1]);
});

test('활동량: 10초에 20m 직선 → 약 20m, 2m/s, 질주 없음 / 가려진 순간이동은 거리 아님', () => {
  const pos = new Float32Array(202); for (let i = 0; i <= 100; i++) pos[2 * i] = i * 0.2;
  const s = playerStats(pos, new Uint8Array(101), 0.1);
  assert.ok(s.distance > 18 && s.distance <= 20.1 && Math.abs(s.topSpeed - 2) < 0.05 && s.sprints === 0, JSON.stringify(s));
  const jump = new Float32Array(200); for (let i = 50; i < 100; i++) jump[2 * i] = 5;
  const hid = new Uint8Array(100); hid[49] = 1;
  assert.equal(playerStats(jump, hid, 0.1).distance, 0);
});

test('공: 몸에 붙은 흰 점(양말)보다 혼자 떨어진 공을 고르고, 짧은 빈틈은 이어 붙인다', () => {
  const fr = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.1, players: [], ball: i === 5 ? [] : [[0.3, 0, 0], [3 + i * 0.2, 2, 1]] }));
  const b = trackBall(fr);
  assert.ok(Math.abs(b[0] - 3) < 1e-6 && Math.abs(b[10] - 4) < 1e-6, Array.from(b).join()); // 5번은 보간
});

test('공: 공이 아이에게 가면 사라지지 않고 그 아이 발밑(붙은 점)을 따라간다', () => {
  const fr = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.1, players: [], ball: i < 10 ? [[i * 0.3, 0, 1]] : [[3, 0.1, 0], [8, 5, 0]] }));
  const b = trackBall(fr);
  assert.ok(Math.abs(b[2 * 25] - 3) < 1e-6, Array.from(b).join()); // 공을 받은 아이 쪽(3,0.1), 엉뚱한 양말(8,5) 아님
});

test('패스: 같은 팀끼리 공이 넘어가면 패스, 상대에게 가면 뺏김', () => {
  const n = 30, ball = new Float32Array(2 * n), mk = (x, team) => ({ team, pos: Float32Array.from({ length: 2 * n }, (_, i) => (i % 2 ? 0 : x)) });
  const ps = [mk(0, 0), mk(10, 0), mk(20, 1)];
  for (let i = 0; i < n; i++) ball[2 * i] = i < 10 ? 0 : i < 20 ? 10 : 20;
  const r = possession(ball, ps, 0.1);
  assert.deepEqual(r.passes.map(p => [p.from, p.to]), [[0, 1]]);
  assert.deepEqual(r.turnovers.map(p => [p.from, p.to]), [[1, 2]]);
});

test('보간: 들쭉날쭉한 시각 → 0.1초 격자', () => {
  const out = resample([0, 0.25, 0.5], Float32Array.from([0, 0, 2.5, 0, 5, 0]), 0.1);
  assert.deepEqual(Array.from(out).filter((_, i) => i % 2 === 0).map(v => +v.toFixed(2)), [0, 1, 2, 3, 4, 5]);
});

test('팀 색: 범위가 겹쳐도 색 중심이 가까운 팀으로, 덩어리 안 적은 색은 무시', async () => {
  const { detect } = await import('../js/vision.js');
  const { teamGate } = await import('../js/pipeline.js');
  const w = 40, h = 20, f = new Uint8ClampedArray(w * h * 4), bg = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { bg.set([30, 110, 70, 255], i * 4); f.set([30, 110, 70, 255], i * 4); }
  const paint = (x0, rgb) => { for (let y = 5; y < 15; y++) for (let x = x0; x < x0 + 10; x++) f.set([...rgb, 255], (y * w + x) * 4); };
  paint(2, [40, 140, 230]); // 진한 파랑 조끼
  f.set([150, 170, 210, 255], (5 * w + 2) * 4); // 그늘진 가장자리 한 점(연보라에 가까움)
  paint(25, [160, 150, 215]); // 연보라 옷
  const blue = { hue: [193, 219], sat: [103, 255], mid: [205, 180] }, purple = { hue: [200, 257], sat: [40, 125], mid: [235, 75] };
  const d = detect(f, { bg, roi: new Uint8Array(w * h).fill(1), w, h, thr: 40, openR: 1, joinR: 2, minPx: 20, teams: [blue, purple].map(teamGate) });
  assert.deepEqual(d.players.map(l => l.length), [1, 1]);
  assert.ok(d.players[0][0][0] < 15 && d.players[1][0][0] > 20);
});

test('전술: 볼록 껍질과 면적, 폭·깊이·수비 라인', async () => {
  const { convexHull, polyArea, computeTactics } = await import('../js/tactics.js');
  const h = convexHull([[0, 0], [4, 0], [4, 3], [0, 3], [2, 1]]);
  assert.equal(h.length, 4); assert.equal(polyArea(h), 12);
  // 팀0: 골키퍼(x=1) + 필드 3명, 왼쪽 골을 지킴
  const N = 20, mk = (id, team, x, y) => ({ id, team, path: Array.from({ length: 2 * N }, (_, i) => (i % 2 ? y : x)), hidden: new Array(N).fill(0) });
  const R = { dt: 0.1, court: [40, 20], teams: [{ name: 'A' }, { name: 'B' }], ball: new Array(2 * N).fill(null),
    players: [mk(0, 0, 1, 10), mk(1, 0, 10, 5), mk(2, 0, 10, 15), mk(3, 0, 16, 10), mk(4, 1, 30, 10), mk(5, 1, 25, 8)] };
  const t = computeTactics(R);
  assert.equal(t.gk[0], 0);
  assert.deepEqual([t.metrics[0].width[5], t.metrics[0].depth[5], t.metrics[0].defLine[5], t.metrics[0].area[5]].map(v => +v.toFixed(1)), [10, 6, 10, 30]);
});
