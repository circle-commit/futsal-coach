// node --test tests/
// 조끼 색을 잠깐 놓친 아이 잇기 (classical-v2, 검출 버전 3) 시험: 검출(그림)의 색 없는 덩어리·아이 한 명 몸 넓이, 그림 장면에서 색 놓침 개선,
// 원래 보이던 칸은 잇기 없는 v2와 같음, 0.3초 이하 틈은 예전처럼 직선 잇기, 위험 장면(색 없는 어른이 바로 옆을 지남)에서 틀린 칸 0,
// 확정 못 하면 잇지 않은 것과 같음, 치우침 보정(나란히 달린 어른·그림자), 한 덩어리로 두 아이를 잇지 않음, v1 불변.
// 브라우저 워커와 로컬 분석 도구는 같은 vision.detect·pipeline.toMeters·analyzeFrames를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, bodySizes } from '../js/vision.js';
import { setup, analyzeFrames } from '../js/pipeline.js';
import { TRACK_V2 } from '../js/track.js';

const T = i => +(i * 0.1).toFixed(1), dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const at = (P, i) => [P.path[2 * i], P.path[2 * i + 1]];
const plain = dets => dets.map(({ uncol, kidFg, ...d }) => d); // 검출 버전 2까지의 모양 = 잇기 없음
/** 잇기 없는 결과 V에서 보이던 칸이 B에서도 같은 자리로 보이는지 (다르면 그 칸 수), 그리고 B에서 새로 보인 칸 수 */
function vsPlain(B, V) {
  let changed = 0, added = 0;
  for (let i = 0; i < V.hidden.length; i++) {
    if (!V.hidden[i]) { if (B.hidden[i] || B.path[2 * i] !== V.path[2 * i] || B.path[2 * i + 1] !== V.path[2 * i + 1]) changed++; } else if (!B.hidden[i]) added++;
  }
  return { changed, added };
}

// ---------- 그림(픽셀) 장면: 200×120 화면 = 20×12m 코트 (1m = 10px) ----------
const W = 200, H = 120, GREEN = [47, 125, 91], RED = [230, 30, 30], BLUE = [30, 40, 230], GRAY = [128, 128, 128];
const cfgP = { width: W, height: H, corners: [[0, 0], [W, 0], [W, H], [0, H]], court: [20, 12],
  teams: [{ name: 'A', color: '#e61e1e', hue: [350, 10], sat: [150, 255] }, { name: 'B', color: '#1e28e6', hue: [225, 245], sat: [150, 255] }] };
function paint(disks) {
  const f = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) f.set([...GREEN, 255], 4 * i);
  for (const [cx, cy, r, col] of disks) for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < W && y < H && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) f.set([...col, 255], 4 * (y * W + x));
  }
  return f;
}
const S = setup(cfgP, paint([])); // 빈 코트가 배경

test('검출: v2(몸 크기 줌)는 색 없는 움직임 덩어리(uncol)와 팀 검출 하나만 든 몸덩어리 넓이(kidFg)를 더 내고, 공 후보 줄 넷째 칸에 흰 점 넓이(검출 버전 4). players와 공 줄 앞 세 칸·v1 모양은 그대로', () => {
  // 빨강 둘(하나는 회색 바지가 붙음), 파랑 하나, 회색 옷 사람 하나(색 없음), 혼자 떨어진 흰 공 하나(반지름 2px = 13px: 10px/m 화면의 공 크기 상한 18.8px 안)
  const f = paint([[40, 30, 5, RED], [100, 60, 5, RED], [100, 68, 4, GRAY], [150, 90, 5, BLUE], [60, 90, 6, GRAY], [170, 20, 2, [255, 255, 255]]]);
  const v1 = detect(f, S.det), v2 = detect(f, { ...S.det, bodyPx: [80, 80] });
  assert.deepEqual(Object.keys(v1), ['players', 'ball'], 'v1(몸 크기 없음)은 예전과 같은 모양');
  assert.deepEqual(v2.players, v1.players);
  assert.equal(v1.ball.length, 1, `흰 공이 공 후보: ${JSON.stringify(v1.ball)}`);
  assert.ok(dist(v1.ball[0], [170, 20]) < 0.5 && v1.ball[0].length === 3 && v1.ball[0][2] === 1, `v1 공 줄 [x, y, 혼자]: ${JSON.stringify(v1.ball)}`);
  assert.deepEqual(v2.ball.map(b => b.slice(0, 3)), v1.ball, 'v2 공 줄 앞 세 칸 = v1 공 줄');
  assert.ok(v2.ball.every(b => b.length === 4 && Number.isInteger(b[3]) && b[3] > 0 && Math.abs(b[3] - 13) <= 6), `v2 공 줄 넷째 칸 = 흰 점 넓이 px (그린 흰 점 13px): ${JSON.stringify(v2.ball)}`);
  // 색 없는 덩어리: 회색 옷 사람과 흰 공 (조끼 색이 든 몸덩어리는 아님)
  assert.equal(v2.uncol.length, 2, `색 없는 덩어리는 회색 옷 사람·흰 공 둘: ${JSON.stringify(v2.uncol)}`);
  assert.ok(v2.uncol.some(u => dist(u, [170, 20]) < 1), '흰 공도 색 없는 덩어리');
  const [x, y, a] = v2.uncol.find(u => dist(u, [60, 90]) < 1) ?? [NaN, NaN, NaN];
  assert.ok(dist([x, y], [60, 90]) < 0.5 && Math.abs(a - Math.PI * 36) < 20, `중심 (${x}, ${y}) 넓이 ${a}px`);
  assert.equal(v2.kidFg.length, 2);
  assert.equal(v2.kidFg[0].length, 2, '빨강 둘 다 혼자 든 몸덩어리');
  assert.ok(v2.kidFg[0].some(v => v > 120), '회색 바지가 붙은 빨강은 바지까지 몸 넓이');
  assert.ok(v2.kidFg[0].some(v => Math.abs(v - Math.PI * 25) < 15) && Math.abs(v2.kidFg[1][0] - Math.PI * 25) < 15, JSON.stringify(v2.kidFg));
  const m = S.toMeters(v2); // m 좌표로 (넓이는 px 그대로)
  assert.ok(m.uncol.some(u => dist(u, [6, 9]) < 0.05 && u[2] === a), JSON.stringify(m.uncol));
  assert.deepEqual(m.kidFg, v2.kidFg);
  assert.ok(dist(m.ball[0], [17, 2]) < 0.05 && m.ball[0][2] === 1 && m.ball[0][3] === v2.ball[0][3], `공 줄도 m 좌표로, 넓이 px는 그대로: ${JSON.stringify(m.ball)}`);
  assert.deepEqual(Object.keys(S.toMeters(v1)), ['players', 'ball']);
});

test('(그림) 조끼가 0.8초 동안 회색으로 보인 아이: 색 없는 덩어리로 이어 가려졌던 8칸을 채우고, 원래 보이던 칸은 그대로', () => {
  // 빨강: 움직이는 K(초속 1.5m, 2.0~2.8초 조끼 회색), 가만히 있는 둘. 파랑 하나. 6초
  const K = i => [40 + 1.5 * i, 60], lost = i => i >= 20 && i < 28;
  const frames = Array.from({ length: 60 }, (_, i) => paint([[...K(i), 5, lost(i) ? GRAY : RED], [40, 25, 5, RED], [150, 95, 5, RED], [120, 30, 5, BLUE]]));
  const d = { ...S.det, bodyPx: bodySizes(frames.filter((_, i) => i % 2 === 0), S.det) };
  const dets = frames.map((f, i) => ({ t: T(i), ...S.toMeters(detect(f, d)) }));
  assert.ok(dets.every((x, i) => (x.uncol.length === 1) === lost(i)), '색 없는 덩어리는 조끼가 회색인 장면에만');
  const kOf = R => R.players.find(P => P.team === 0 && dist(at(P, 0), [4, 6]) < 0.1);
  const B = kOf(analyzeFrames(dets, cfgP)), V = kOf(analyzeFrames(plain(dets), cfgP));
  const hid = P => P.hidden.slice(20, 28).reduce((a, b) => a + b, 0);
  assert.equal(hid(V), 8, '잇기 없으면(검출 버전 2까지) 8칸 가려짐');
  assert.equal(hid(B), 0, '이으면 0칸');
  for (let i = 20; i < 28; i++) assert.ok(dist(at(B, i), [K(i)[0] / 10, 6]) < 0.1, `${T(i)}초 이은 자리 ${at(B, i)}`);
  assert.deepEqual(vsPlain(B, V), { changed: 0, added: 8 }, '원래 보이던 칸은 자리까지 그대로, 가려졌던 8칸만 채움');
  assert.ok(B.distance > V.distance, `뛴 거리 ${B.distance} > ${V.distance}`);
});

// ---------- 검출 좌표 장면 (위험 시험): 빨강 K가 초속 1.5m로 가다 2.0~3.0초에 조끼 색을 놓침 ----------
const cfgM = { width: 1280, height: 720, corners: [[104, 168], [1256, 168], [1256, 616], [106.7, 616]], court: [35, 13.7],
  teams: [{ name: 'A', color: '#e61e1e', hue: [350, 10], sat: [150, 255] }, { name: 'B', color: '#1e28e6', hue: [225, 245], sat: [150, 255] }] };
const KS = 200; // 아이 한 명 몸 넓이(px)
const Kat = t => [5 + 1.5 * t, 6];
/** n장면. lostAt(t): K 조끼 색을 놓친 장면, blobs(t, K): 그 장면의 색 없는 덩어리 [[x, y, 넓이], …], kAt: K 자리, blue: 파랑 팀 검출 더하기 */
function scene({ n = 60, lostAt = t => t >= 2.0 - 1e-9 && t < 3.0 - 1e-9, blobs = () => [], kAt = Kat, blue = [] } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const t = T(i), K = kAt(t), lost = lostAt(t);
    return { t, players: [[[2, 10], ...(lost ? [] : [K]), [30, 3]], [[20, 10], ...blue]], ball: [], uncol: blobs(t, K, lost), kidFg: [[KS], [KS]], K };
  });
}
const kTrack = R => R.players.find(P => P.team === 0 && dist(at(P, 0), [5, 6]) < 0.01);
function wrongCells(sc) { // K 트랙의 보인 칸 중 K에서 0.6m 넘게 떨어진 칸 수 (2초부터)
  const P = kTrack(analyzeFrames(sc.map(({ K, ...f }) => f), cfgM));
  let wrong = 0, back = null;
  for (let i = 20; i < sc.length; i++) { if (P.hidden[i]) continue; if (dist(at(P, i), sc[i].K) > 0.6) wrong++; else if (i >= 30 && back == null) back = T(i); }
  return { P, wrong, back };
}
// 어른(색 없음, 아이 몸 넓이 1.1배): 2.0초에 K 예측 자리 0.4m 옆을 지나 K 진행 방향과 직각으로 초속 1m 멀어짐
const adult = t => [5 + 1.5 * 2.0, 6.4 + 1.0 * (t - 2.0), 1.1 * KS];

test('위험 장면 S2: 놓친 아이 덩어리는 안 보이고 색 없는 어른만 0.4m 옆을 지나도 틀린 칸 0, 다시 잡는 시각도 잇기 없을 때와 같음', () => {
  const sc = scene({ blobs: t => [adult(t)] });
  const { P, wrong, back } = wrongCells(sc);
  assert.equal(wrong, 0, `틀린 보인 칸 ${wrong}`);
  for (let i = 20; i < 30; i++) assert.equal(P.hidden[i], 1, `${T(i)}초: 색 놓친 동안은 가려짐으로 남음`);
  assert.equal(back, 3.0, '색이 돌아온 3.0초에 바로 다시 잡음 (어른을 따라간 잇는 길은 트랙을 끌고 가지 않음)');
  const V = kTrack(analyzeFrames(plain(sc.map(({ K, ...f }) => f)), cfgM));
  assert.deepEqual(Array.from(P.hidden), Array.from(V.hidden)); assert.deepEqual(P.path, V.path, '잇기 없을 때와 바이트까지 같음');
});

test('위험 장면 S1·S3: K 자신의 색 없는 덩어리가 보이면 K를 이어 따라가고(놓친 10칸이 보인 칸), 어른이 0.4m로 나란히 걸어도 틀린 칸 0', () => {
  const S1 = scene({ blobs: (t, K, lost) => [adult(t), ...(lost ? [[K[0], K[1], 0.6 * KS]] : [])] });
  const r1 = wrongCells(S1);
  assert.equal(r1.wrong, 0);
  assert.deepEqual(Array.from(r1.P.hidden.slice(20, 30)), Array(10).fill(0), '놓친 1초 모두 이어 보인 칸');
  assert.deepEqual(vsPlain(r1.P, kTrack(analyzeFrames(plain(S1.map(({ K, ...f }) => f)), cfgM))), { changed: 0, added: 10 });
  const S3 = scene({ blobs: (t, K, lost) => [[K[0], K[1] + 0.4, 1.1 * KS], ...(lost ? [[K[0], K[1], 0.6 * KS]] : [])] });
  const r3 = wrongCells(S3);
  assert.equal(r3.wrong, 0);
  assert.equal(r3.P.hidden.slice(20, 30).reduce((a, b) => a + b, 0), 0);
});

test('잇는 덩어리 규칙: 아이 한 명 넓이의 0.3~2배 · 예측 자리 0.6m 안 · 모든 색 검출에서 0.5m 밖 (하나라도 어기면 잇지 않음)', () => {
  // 2.0~2.5초 색 놓침(5칸), 색이 돌아온 자리는 K 경로 위. 덩어리가 규칙에 맞으면 5칸을 이어 확정, 아니면 잇기 없는 v2처럼 5칸 가려짐
  const lostAt = t => t >= 2.0 - 1e-9 && t < 2.5 - 1e-9, own = z => (t, K, lost) => (lost ? [[K[0], K[1], z * KS]] : []);
  const cases = [
    ['맞는 덩어리(0.6배, K 자리)', { blobs: own(0.6) }, 0],
    ['너무 작음(0.2배)', { blobs: own(0.2) }, 5],
    ['너무 큼(2.5배)', { blobs: own(2.5) }, 5],
    ['시작 장면에 예측 자리에서 0.8m (곧 K 자리로 옴)', { blobs: (t, K, lost) => (lost ? [[K[0], K[1] + Math.max(0, 0.8 - 4 * (t - 2.0)), 0.6 * KS]] : []) }, 5],
    ['파랑 검출 0.45m 옆 (그 사람 팔다리·그림자일 수 있음)', { blobs: own(0.6), blue: [[8, 6.45]] }, 5],
  ];
  for (const [name, opt, want] of cases) {
    const P = kTrack(analyzeFrames(scene({ lostAt, ...opt }).map(({ K, ...f }) => f), cfgM));
    assert.equal(P.hidden.slice(20, 25).reduce((a, b) => a + b, 0), want, name);
  }
});

test('0.3초 이하 틈은 예전처럼 직선 잇기(덩어리로 잇지 않음), 그보다 긴 틈만 덩어리로 채움', () => {
  // K가 색을 놓친 틈 가운데에서 0.3m 비켜 갔다 돌아옴(덩어리는 K 몸). 3칸 틈: 잇기 없을 때와 같은 직선, 4칸 틈: 잇기 없으면 가려짐 → 덩어리 길로 채움
  const run = n => {
    const lostAt = t => t >= 2.0 - 1e-9 && t < 2.0 + n / 10 - 1e-9, swerve = t => (t > 2.05 && t < 1.95 + (n - 1) / 10 ? 0.3 : 0); // 틈의 처음·끝 장면 빼고 비켜 감
    const dets = scene({ lostAt, blobs: (t, K, lost) => (lost ? [[K[0], K[1] + swerve(t), 0.6 * KS]] : []) }).map(({ K, ...f }) => f);
    return [kTrack(analyzeFrames(dets, cfgM)), kTrack(analyzeFrames(plain(dets), cfgM))];
  };
  const [B3, V3] = run(3), [B4, V4] = run(4);
  assert.deepEqual(Array.from(B3.hidden), Array.from(V3.hidden)); assert.deepEqual(B3.path, V3.path, '3칸 틈은 잇기 없을 때와 같음');
  assert.equal(V3.hidden.slice(20, 23).reduce((a, b) => a + b, 0), 0, '3칸 틈은 직선 잇기로 보임');
  assert.ok(Math.abs(at(V3, 21)[1] - 6) < 0.01, '직선 잇기라 비켜 간 0.3m는 안 따라감');
  assert.equal(V4.hidden.slice(20, 24).reduce((a, b) => a + b, 0), 4, '4칸 틈은 잇기 없으면 가려짐');
  assert.deepEqual(vsPlain(B4, V4), { changed: 0, added: 4 });
  for (const i of [21, 22]) assert.ok(at(B4, i)[1] > 6.2, `${T(i)}초: 덩어리 길(비켜 간 자리)로 채움 ${at(B4, i)}`);
});

test('치우침 보정: 시작·끝의 어긋남을 이은 칸에서 선형으로 빼서, 옆에서 나란히 달린 어른이나 그림자만큼 치우치지 않음', () => {
  // 1초(10칸) 색 놓침. ① K 덩어리는 안 보이고 색 없는 어른이 0.5m 옆에서 같이 달림 ② 그 어른이 1초 동안 0.5m → 0.3m로 다가옴(치우침이 고르게 바뀜)
  // ③ K 덩어리 중심이 그림자 때문에 (0.2, 0.15)m 치우침
  const cases = {
    '나란히 달린 어른': (t, K) => [[K[0], K[1] + 0.5, 1.1 * KS]],
    '다가오며 나란히 달린 어른': (t, K) => [[K[0], K[1] + 0.5 - 0.2 * Math.min(1, Math.max(0, t - 2.0)), 1.1 * KS]],
    '그림자로 치우친 자기 덩어리': (t, K, lost) => (lost ? [[K[0] + 0.2, K[1] + 0.15, 0.8 * KS]] : []),
  };
  for (const [name, blobs] of Object.entries(cases)) {
    const sc = scene({ blobs }), P = kTrack(analyzeFrames(sc.map(({ K, ...f }) => f), cfgM));
    for (let i = 20; i < 30; i++) {
      assert.equal(P.hidden[i], 0, `${name} ${T(i)}초: 채움`);
      assert.ok(dist(at(P, i), sc[i].K) < 0.02, `${name} ${T(i)}초: K에서 ${dist(at(P, i), sc[i].K).toFixed(3)}m (보정 전 덩어리는 ${dist(sc[i].uncol.at(-1), sc[i].K).toFixed(2)}m)`);
    }
  }
});

test('한 장면의 한 덩어리로 두 아이(다른 팀이어도)를 잇지 않음: 먼저 이은 팀이 쓰면 다른 팀 아이는 가려짐으로 남음', () => {
  // 빨강 K와 파랑 J가 0.5m 간격으로 나란히 가다 둘 다 2.0~2.5초 색을 놓침. 색 없는 덩어리는 K 자리에 하나뿐
  const J = t => [5 + 1.5 * t, 6.5], lost = t => t >= 2.0 - 1e-9 && t < 2.5 - 1e-9;
  const dets = Array.from({ length: 60 }, (_, i) => {
    const t = T(i), K = Kat(t);
    return { t, players: [[[2, 10], ...(lost(t) ? [] : [K]), [30, 3]], [[20, 10], ...(lost(t) ? [] : [J(t)])]], ball: [], uncol: lost(t) ? [[K[0], K[1], 0.6 * KS]] : [], kidFg: [[KS], [KS]] };
  });
  const R = analyzeFrames(dets, cfgM), k = kTrack(R), j = R.players.find(P => P.team === 1 && dist(at(P, 0), [5, 6.5]) < 0.01);
  assert.equal(k.hidden.slice(20, 25).reduce((a, b) => a + b, 0), 0, 'K는 자기 덩어리로 채움');
  assert.equal(j.hidden.slice(20, 25).reduce((a, b) => a + b, 0), 5, 'J는 K가 쓴 덩어리를 쓰지 않아 가려짐');
});

test('확정 못 하면 잇지 않은 것과 같음: 1.5초 안에 색이 안 돌아옴 · 덩어리가 중간에 사라짐 · 영상 끝까지 잇는 중', () => {
  const own = (t, K, lost) => (lost ? [[K[0], K[1], 0.6 * KS]] : []);
  const cases = {
    '2.5초 놓침(잇기 상한 넘음)': scene({ lostAt: t => t >= 2.0 - 1e-9 && t < 4.5 - 1e-9, blobs: own }),
    '덩어리가 0.4초 뒤 사라짐': scene({ blobs: (t, K, lost) => (lost && t < 2.4 - 1e-9 ? [[K[0], K[1], 0.6 * KS]] : []) }),
    '영상 끝까지 놓침': scene({ lostAt: t => t >= 5.0 - 1e-9, blobs: own }),
  };
  for (const [name, sc] of Object.entries(cases)) {
    const dets = sc.map(({ K, ...f }) => f), B = kTrack(analyzeFrames(dets, cfgM)), V = kTrack(analyzeFrames(plain(dets), cfgM));
    assert.deepEqual(Array.from(B.hidden), Array.from(V.hidden), `${name}: 가려짐이 잇지 않은 것과 같음`);
    assert.deepEqual(B.path, V.path, `${name}: 자리도 같음`);
    assert.ok(B.hidden.reduce((a, b) => a + b, 0) >= 10, `${name}: 놓친 칸은 가려짐`);
  }
});

test('다른 자리에서 색으로 다시 잡히면(따라간 덩어리가 다른 사람) 채우지 않고 놓치기 전 자리·가려짐 그대로, 맞는 자리면 채움', () => {
  // 2.0~2.5초 색 놓침. 색 없는 덩어리가 K의 예측 경로를 따라 곧게 감. 색이 돌아온 K가 경로에서 1m 옆(안 채움) 또는 경로 위(채움)
  const run = side => {
    const kAt = t => (t < 2.0 - 1e-9 ? Kat(t) : [Kat(t)[0], 6 + side * Math.min(1, (t - 2.0) / 0.5)]);
    const sc = scene({ lostAt: t => t >= 2.0 - 1e-9 && t < 2.5 - 1e-9, kAt, blobs: t => (t >= 2.0 - 1e-9 ? [[...Kat(t), 0.6 * KS]] : []) });
    return kTrack(analyzeFrames(sc.map(({ K, ...f }) => f), cfgM));
  };
  const off = run(1), on = run(0);
  for (let i = 20; i < 25; i++) {
    assert.equal(off.hidden[i], 1, `${T(i)}초: 다른 자리에서 다시 잡혀 안 채움`);
    assert.deepEqual(at(off, i), at(off, 19), `${T(i)}초: 놓치기 전 자리`);
    assert.equal(on.hidden[i], 0, `${T(i)}초: 맞는 자리에서 다시 잡혀 채움`);
  }
  assert.equal(off.hidden[25], 0, '색이 돌아온 K는 바로 잡음');
  assert.ok(dist(at(off, 30), [Kat(3.0)[0], 7]) < 0.01, '그 뒤로 K를 따라감');
});

test('v1은 색 없는 덩어리를 쓰지 않음 (검출 버전 3 기록을 줘도 결과 그대로)', () => {
  const dets = scene({ blobs: (t, K, lost) => (lost ? [[K[0], K[1], 0.6 * KS]] : []) }).map(({ K, ...f }) => f);
  assert.deepEqual(analyzeFrames(dets, cfgM, { engine: 'classical-v1' }), analyzeFrames(plain(dets), cfgM, { engine: 'classical-v1' }));
});
