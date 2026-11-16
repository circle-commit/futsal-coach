// node --test tests/
// 붙은 같은 팀 덩어리 나누기 (classical-v2) 시험: 그림(픽셀)으로 만든 장면에서 검출 후보·몸 크기를 보고, 추적 단계의 "모자랄 때만, 인원 넘지 않게" 규칙과
// v1 불변을 확인한다. 브라우저 워커와 로컬 분석 도구는 같은 vision.detect·bodySizes·pipeline.toMeters를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, bodySizes, SPLIT } from '../js/vision.js';
import { setup, analyzeFrames } from '../js/pipeline.js';

// 200×120 화면 = 20×12m 코트 (1m ≈ 10px). 초록 바닥 위에 팀 색 원
const W = 200, H = 120, GREEN = [47, 125, 91], RED = [230, 30, 30], BLUE = [30, 40, 230];
const cfg = { width: W, height: H, corners: [[0, 0], [W, 0], [W, H], [0, H]], court: [20, 12],
  teams: [{ name: 'A', color: '#e61e1e', hue: [350, 10], sat: [150, 255] }, { name: 'B', color: '#1e28e6', hue: [225, 245], sat: [150, 255] }] };
function paint(disks) {
  const f = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) f.set([...GREEN, 255], 4 * i);
  for (const [cx, cy, r, col] of disks) for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < W && y < H && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) f.set([...col, 255], 4 * (y * W + x));
  }
  return f;
}
const s = setup(cfg, paint([])); // 빈 코트가 배경
const det = bodyPx => ({ ...s.det, ...(bodyPx ? { bodyPx } : {}) });
const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;

test('몸 크기: 고르게 뽑은 장면에서 그 팀이 인원만큼 보인 장면의 검출 색 픽셀 수 중앙값', () => {
  const frames = Array.from({ length: 30 }, (_, k) => paint([[40 + k, 30, 5, RED], [150, 80 - k, 5, RED], [100, 60, 5, BLUE]]));
  const [a, b] = bodySizes(frames, s.det);
  assert.ok(a > 60 && a < 100 && b > 60 && b < 100, `몸 크기 ${a}/${b} (반지름 5px 원 ≈ 80px)`);
  assert.deepEqual(bodySizes([paint([])], s.det), [0, 0], '안 보이는 팀은 0 = 나누지 않음');
});

test('검출: 같은 팀 둘이 붙어 한 덩어리면 몸 크기를 줄 때만 나누기 후보(두 자리)를 내고, players는 그대로', () => {
  const two = paint([[100, 60, 5, RED], [109, 60, 5, RED], [40, 30, 5, BLUE]]); // 중심 9px(0.9m)·반지름 5 → 한 덩어리
  const plain = detect(two, det(null)), withBody = detect(two, det([80, 80]));
  assert.equal(plain.players[0].length, 1, '나누기 전엔 한 명으로 보임');
  assert.equal('split' in plain, false, '몸 크기를 안 주면(v1·예전) 예전과 같은 모양');
  assert.deepEqual(withBody.players, plain.players, 'players는 몸 크기와 상관없이 같음');
  assert.deepEqual(withBody.ball, plain.ball);
  assert.equal(withBody.split.length, 1);
  const [team, j, parts] = withBody.split[0];
  assert.deepEqual([team, j, parts.length], [0, 0, 2]);
  assert.ok(near(parts[0], [100, 60], 1.5) && near(parts[1], [109, 60], 1.5), `나눈 자리 ${JSON.stringify(parts)}`);
  const single = detect(paint([[100, 60, 5, RED]]), det([80, 80]));
  assert.equal('split' in single, false, '한 아이(몸 크기 1배)는 나누지 않음');
  const big = detect(paint([[100, 60, 6, RED]]), det([80, 80])); // 팔·자세로 조금 커진 한 아이(약 1.4배) → 기준(1.6배) 아래
  assert.equal('split' in big, false);
  assert.equal(SPLIT.ratio, 1.6);
});

test('검출: 같은 입력이면 같은 후보 (결정적), m 좌표로 바꿀 때 후보도 함께', () => {
  const three = paint([[100, 60, 5, RED], [109, 60, 5, RED], [104, 68, 5, RED]]);
  const a = detect(three, det([80, 80])), b = detect(three, det([80, 80]));
  assert.deepEqual(a, b);
  assert.equal(a.split[0][2].length, 3, '셋이 붙으면 세 자리');
  const m = s.toMeters(a);
  assert.equal(m.split[0][2].length, 3);
  assert.ok(near(m.split[0][2][0], s.toMeters({ players: [[a.split[0][2][0]]], ball: [] }).players[0][0], 1e-9), '후보도 같은 변환');
  assert.equal('split' in s.toMeters(detect(three, det(null))), false);
});

// 추적 단계: 장면(m 좌표) 목록으로 나누기 규칙만 본다. 팀 0 = A·B·C 3명, 팀 1 = 1명 (20×12m 코트)
const T = i => +(i * 0.1).toFixed(1); // near(p, q, tol)는 위에서 정의
const at = (P, i) => [P.path[2 * i], P.path[2 * i + 1]];
const cfgM = { ...cfg, teams: cfg.teams.map(t => ({ ...t })) };
// A는 오른쪽으로 걷고, B가 다가와 15~30장 동안 A에 붙었다(0.5m) 떨어진다. 붙은 동안 검출은 덩어리 하나 + 나누기 후보(두 자리 또는 parts(A,B))
function mergeScene(parts = (a, b) => [a, b]) {
  return Array.from({ length: 45 }, (_, i) => {
    const A = [5 + 0.05 * i, 5], yB = i < 5 ? 7 : i < 15 ? 7 - 0.15 * (i - 5) : i < 30 ? 5.5 : Math.min(7, 5.5 + 0.15 * (i - 30)), B = [5 + 0.05 * i, yB], Cc = [15, 9];
    const merged = Math.hypot(A[0] - B[0], A[1] - B[1]) <= 0.6;
    return merged ? { t: T(i), players: [[[A[0], (A[1] + B[1]) / 2], Cc], [[10, 3]]], ball: [], split: [[0, 0, parts(A, B)]], A, B }
      : { t: T(i), players: [[A, B, Cc], [[10, 3]]], ball: [], A, B };
  });
}
const merged = sc => sc.map((f, i) => (f.split ? i : -1)).filter(i => i >= 0);
const strip = sc => sc.map(({ A, B, ...f }) => f);
const trackOf = (R, i, p) => R.players.findIndex(P => P.team === 0 && !P.hidden[i] && near(at(P, i), p, 0.25));

test('붙어서 하나로 보인 덩어리는 이어 온 트랙이 있고 팀이 모자랄 때 나눈 자리로 두 아이를 계속 따라감', () => {
  const sc = mergeScene(), R = analyzeFrames(strip(sc), cfgM), m = merged(sc);
  assert.ok(m.length >= 15, `붙은 장면 ${m.length}개`);
  const a0 = trackOf(R, 0, sc[0].A), b0 = trackOf(R, 0, sc[0].B);
  assert.ok(a0 >= 0 && b0 >= 0 && a0 !== b0);
  for (const i of m) assert.deepEqual([trackOf(R, i, sc[i].A), trackOf(R, i, sc[i].B)], [a0, b0], `${sc[i].t}초: 붙은 동안에도 A·B 번호 그대로 보임`);
  assert.deepEqual([trackOf(R, 44, sc[44].A), trackOf(R, 44, sc[44].B)], [a0, b0], '떨어진 뒤에도 번호 그대로');
  // 나누면 인원(3)을 넘는 후보(세 자리)는 쓰지 않음 → 붙은 동안 한 명은 가려짐
  const over = mergeScene((a, b) => [a, b, [a[0] + 0.3, a[1] + 0.25]]), Ro = analyzeFrames(strip(over), cfgM);
  assert.ok(merged(over).some(i => Ro.players.filter(P => P.team === 0 && P.hidden[i]).length === 1), '세 자리로 나누면 인원을 넘어 안 나눔');
  // v1은 후보를 보지 않음 (결과가 후보 없을 때와 똑같음)
  const plain = strip(sc).map(({ split, ...f }) => f);
  assert.deepEqual(analyzeFrames(strip(sc), cfgM, { engine: 'classical-v1' }), analyzeFrames(plain, cfgM, { engine: 'classical-v1' }));
  assert.ok(R.hiddenRate < analyzeFrames(plain, cfgM).hiddenRate, 'v2는 후보로 붙은 아이를 이어 감');
});

test('나누기 후보가 있어도 이어 온 트랙이 없거나 팀이 다 보이면 안 씀', () => {
  // 팀 다 보임: A 덩어리에 후보가 붙어 와도(자세로 커 보임) 트랙은 덩어리 가운데를 그대로 따라감
  const full = Array.from({ length: 20 }, (_, i) => ({ t: T(i), players: [[[5, 5], [9, 5], [15, 9]], [[10, 3]]], ball: [], ...(i >= 5 ? { split: [[0, 0, [[4.7, 5], [5.3, 5]]]] } : {}) }));
  const Rf = analyzeFrames(full, cfgM);
  for (let i = 5; i < Rf.players[0].hidden.length; i++) assert.ok(trackOf(Rf, i, [5, 5]) >= 0 && Rf.players.every(P => P.hidden[i] === 0), `${T(i)}초 다 보임`);
  // 이어 온 트랙 없음: B·C가 둘 다 안 보이다가(10~19장) 붙은 채 다시 나타나면, 그 첫 장면엔 보이던 트랙이 없어 후보를 안 씀(한 명만 덩어리를 잡음).
  // 다음 장면부터는 덩어리를 잡은 트랙이 이어 온 트랙이 되어 나누고, 나머지 한 명도 나눈 자리로 다시 잡힘
  const back = Array.from({ length: 35 }, (_, i) => {
    const B = [12, 7.7], Cc = [12, 8.3], players = [[[5, 5], ...(i < 10 ? [[12, 6], [12, 9]] : i < 20 ? [] : [[12, 8]])], [[10, 3]]];
    return { t: T(i), players, ball: [], ...(i >= 20 ? { split: [[0, 1, [B, Cc]]] } : {}) };
  });
  const cfg3 = { ...cfgM, teams: cfgM.teams.map((t, k) => ({ ...t, ...(k === 0 ? { count: 3 } : {}) })) }; // 셋이 다 보이는 장면이 짧으니 선생님이 인원을 적은 경우
  const Rb = analyzeFrames(back, cfg3), seen = i => Rb.players.filter(P => P.team === 0 && !P.hidden[i]).length;
  assert.deepEqual(Rb.counts, [3, 1]);
  assert.equal(seen(20), 2, '다시 나타난 첫 장면: A와 덩어리를 잡은 한 명만 보임 (나누기 안 씀)');
  for (let i = 22; i < Rb.players[0].hidden.length; i++) assert.equal(seen(i), 3, `${T(i)}초: 덩어리를 이어 온 트랙이 생겨 나눈 자리로 셋 다 보임`);
});

test('(QA bigkid) 혼자서도 덩어리가 큰 같은 팀 사람은 다른 아이를 놓쳐 팀이 모자라도 둘로 나누지 않음', () => {
  // 팀 0: A(보통), BIG(늘 나누기 후보가 나옴 = 몸 큰 사람), C(4~10초 조끼 색 놓침, BIG에서 4m). 셋은 2m 넘게 떨어져 있어 서로 붙지 않음 (15초)
  const sc = Array.from({ length: 150 }, (_, i) => {
    const A = [4 + 0.03 * i, 4], BIG = [12, 6 + 0.01 * i], C = [8, 6];
    const lost = i >= 40 && i < 100;
    return { t: T(i), players: [[A, BIG, ...(lost ? [] : [C])], [[10, 10]]], ball: [], split: [[0, 1, [[BIG[0] - 0.3, BIG[1]], [BIG[0] + 0.3, BIG[1]]]]], BIG };
  });
  const R = analyzeFrames(strip(sc), cfgM);
  assert.deepEqual(R.counts, [3, 1]);
  let two = 0; for (let i = 0; i < 149; i++) if (R.players.filter(P => P.team === 0 && !P.hidden[i] && near(at(P, i), sc[i].BIG, 0.6)).length >= 2) two++;
  assert.equal(two, 0, `몸 큰 사람 자리에 같은 팀 두 명이 찍힌 장면 ${two}`);
  const c = R.players.findIndex(P => P.team === 0 && near(at(P, 0), [8, 6], 0.1));
  for (let i = 45; i < 100; i++) assert.equal(R.players[c].hidden[i], 1, `${T(i)}초: 놓친 C는 가려짐으로 남음`);
  assert.equal(R.players[c].hidden[105], 0, 'C 조끼 색이 돌아오면 다시 잡음');
});

test('(QA bigkid, 그림) 몸 넓이 약 2배인 같은 팀 사람 + 다른 아이 6초 놓침: v2도 v1처럼 빈 번호를 채우지 않음', () => {
  // 1m ≈ 10px. 빨강 팀: 보통 아이(반지름 5px) A, 몸 큰 사람(반지름 7px, 넓이 1.96배) BIG, 보통 아이 C(4~10초 동안 조끼 색 없음 = 안 그림), 15초
  const frames = Array.from({ length: 150 }, (_, i) => paint([[40 + 0.3 * i, 40, 5, RED], [160, 60 + 0.1 * i, 7, RED], ...(i >= 40 && i < 100 ? [] : [[100, 60, 5, RED]]), [100, 100, 5, BLUE]]));
  const body = bodySizes(frames.filter((_, i) => i % 5 === 0), s.det), d = det(body); // 배경 30장처럼 고르게 30장
  const dets = frames.map((f, i) => ({ t: T(i), ...s.toMeters(detect(f, d)) }));
  assert.ok(dets.every(x => x.split?.some(q => q[0] === 0)), '몸 큰 사람 덩어리는 늘 나누기 후보가 나옴 (팀 몸 크기 중앙값의 1.6배 넘음)');
  for (const engine of ['classical-v1', 'classical-v2']) {
    const R = analyzeFrames(dets, cfgM, { engine });
    assert.deepEqual(R.counts, [3, 1]);
    let two = 0; for (let i = 0; i < 149; i++) if (R.players.filter(P => P.team === 0 && !P.hidden[i] && near(at(P, i), [16, 6 + 0.01 * i], 0.6)).length >= 2) two++;
    assert.equal(two, 0, `${engine}: 몸 큰 사람 자리에 빨강 두 명이 찍힌 장면 ${two}`);
  }
});
