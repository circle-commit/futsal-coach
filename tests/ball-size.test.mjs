// node --test tests/
// 공 크기 비용 약속 (classical-v2, 검출 버전 4): 라벨 없이 영상에서 공 넓이 재기(track.ballSize), 공 크기에 가까운 후보 고르기(track.trackBall size),
// v2 공 후보 줄 [x, y, 혼자, 넓이px] 검사(로컬 분석 도구 detectionOk), v1은 예전 그대로
import test from 'node:test';
import assert from 'node:assert/strict';
import { ballSize, trackBall, BALL_SIZE } from '../js/track.js';
import { areaScale } from '../js/pipeline.js';
import { detectionOk } from '../tools/local-analysis.mjs';

const COURT = [32, 18], SC = 1000, scale = () => SC; // 시험용: 어디서나 1m² = 1000px²
const AM = 0.11; // 공 넓이 0.11m² → 110px (실제 샘플은 약 0.11m², 이론 지름 20cm의 3.5배)
// 장면 n개 (t = i/10, 도구와 같은 시각). each(i) → 그 장면 공 후보들
const frames = (n, each, t = i => i / 10) => Array.from({ length: n }, (_, i) => ({ t: t(i), ball: each(i) }));
// 빠르게(초속 5m) 대각선으로 가는 혼자 떨어진 공 크기 점
const fastBall = i => [2 + 0.4 * i, 3 + 0.3 * i, 1, AM * SC];

test('ballSize: 빠르게 움직이는 혼자 떨어진 공 크기 점으로 재고, 천천히 걷는 큰 흰 점·붙은 점·코트 밖 점은 빼고, 점이 적으면 null', () => {
  assert.equal(ballSize(frames(20, i => [fastBall(i)]), COURT, scale), AM);
  // 천천히(초속 1m) 걷는 흰 옷 어른 덩어리(공 4배)·아이 몸에 붙은 공 크기 점·코트 밖에서 빠르게 가는 점이 함께 있어도 공 넓이 그대로
  const busy = frames(20, i => [fastBall(i), [20 + 0.1 * i, 10, 1, 4 * AM * SC], [10 + 0.5 * i, 15, 0, 2 * AM * SC], [5 + 0.5 * i, -2, 1, 3 * AM * SC]]);
  assert.equal(ballSize(busy, COURT, scale), AM);
  assert.equal(ballSize(frames(20, i => [[20 + 0.1 * i, 10, 1, 4 * AM * SC]]), COURT, scale), null, '천천히 걷는 큰 흰 점만 있으면 못 잼');
  // 점 수: 11장 길이면 빠른 걸음 10개(minPts) → 잼, 10장이면 9개 → null. 4장짜리 길(minLen 5 미만)은 안 셈
  assert.equal(ballSize(frames(11, i => [fastBall(i)]), COURT, scale), AM);
  assert.equal(ballSize(frames(10, i => [fastBall(i)]), COURT, scale), null);
  const short = frames(40, i => (i % 5 === 4 ? [] : [fastBall(i)])); // 4장마다 끊김
  assert.equal(ballSize(short, COURT, scale), null);
  assert.equal(BALL_SIZE.minPts, 10);
  // 넓이 칸이 없는 줄(v1 모양)은 못 잼
  assert.equal(ballSize(frames(20, i => [fastBall(i).slice(0, 3)]), COURT, scale), null);
});

test('ballSize: 걸음 속도는 실제 장면 시각 차로 (웹 분석처럼 간격이 0.1초가 아니어도), 0.1초 간격(도구)이면 고정 0.1초로 셈한 것과 같음', () => {
  // 한 걸음 0.3m: 0.08초 간격이면 초속 3.75m(셈), 0.12초 간격이면 초속 2.5m(안 셈)
  const step = (dtSec, n = 20) => frames(n, i => [[2 + 0.3 * i, 5, 1, AM * SC]], i => +(i * dtSec).toFixed(6));
  assert.equal(ballSize(step(0.08), COURT, scale), AM);
  assert.equal(ballSize(step(0.12), COURT, scale), null);
  // 고정 0.1초로 나누던 실험 구현과 같은지: 0.1초 간격(i/10, JSON으로 오간 값) 장면에서 무작위 후보로 비교
  const ref = (fr) => { // 실험 구현(스크래치패드 final-ball.mjs ballSize)의 속도 계산만 고정 0.1초
    const pts = fr.map(f => f.ball.filter(b => b[2] && b[3] > 0 && Math.max(0, -b[0], b[0] - 32, -b[1], b[1] - 18) <= 0));
    let open = [], done = [];
    for (let i = 0; i < pts.length; i++) {
      const used = new Set(), next = [];
      for (const ch of open) {
        const last = ch[ch.length - 1], v = ch.length > 1 ? [last[0] - ch[ch.length - 2][0], last[1] - ch[ch.length - 2][1]] : null;
        let best = -1, bd = Infinity;
        pts[i].forEach((q, k) => { if (used.has(k)) return; const s = Math.hypot(q[0] - last[0], q[1] - last[1]); if (s > 2.5) return; const acc = v ? Math.hypot(q[0] - last[0] - v[0], q[1] - last[1] - v[1]) : 0; if (acc > 1) return; if (acc + 0.1 * s < bd) { bd = acc + 0.1 * s; best = k; } });
        if (best >= 0) { used.add(best); ch.push(pts[i][best]); next.push(ch); } else done.push(ch);
      }
      pts[i].forEach((q, k) => { if (!used.has(k)) next.push([q]); });
      open = next;
    }
    done.push(...open);
    const vals = done.filter(ch => ch.length >= 5).flatMap(ch => ch.slice(1).filter((q, k) => Math.hypot(q[0] - ch[k][0], q[1] - ch[k][1]) / 0.1 >= 3).map(q => q[3] / SC)).sort((a, b) => a - b);
    return vals.length >= 10 ? vals[Math.min(vals.length - 1, Math.floor(0.5 * vals.length))] : null;
  };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 20; trial++) {
    const fr = JSON.parse(JSON.stringify(frames(150, i => Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => k === 0
      ? [1 + ((0.28 + 0.06 * rnd()) * i) % 30, 2 + 14 * rnd() * 0.05 + (i % 40) * 0.3, rnd() < 0.8 ? 1 : 0, 60 + 100 * rnd()] // 초속 3m 언저리로 가는 점
      : [32 * rnd(), 18 * rnd(), rnd() < 0.5 ? 1 : 0, 20 + 400 * rnd()]))));
    assert.equal(ballSize(fr, COURT, scale), ref(fr), `무작위 ${trial}`);
  }
});

// 고르기: 공 크기(넓이 비 1)인 아이 발밑 공, 신발 끝 크기(0.25배) 혼자 떨어진 흰 점, 흰 옷 크기(4배) 혼자 떨어진 흰 점이 나란히 움직임
const three = frames(30, i => [[5 + 0.2 * i, 5, 0, AM * SC], [5 + 0.2 * i, 5.6, 1, 0.25 * AM * SC], [5 + 0.2 * i, 4.4, 1, 4 * AM * SC]]);
const ys = out => Array.from({ length: out.length / 2 }, (_, i) => Math.round(out[2 * i + 1] * 10) / 10);

test('trackBall 크기 비용: 공 크기 후보를 신발 끝·흰 옷 크기 후보보다 고름 (size가 없으면 예전처럼 혼자 떨어진 흰 점)', () => {
  assert.ok(ys(trackBall(three, { am: AM, scale })).every(y => y === 5), '크기 비용: 공 크기(y=5)');
  assert.ok(ys(trackBall(three)).every(y => y !== 5), '크기 비용 없음: 혼자 떨어진 흰 점');
  // 비용 값: 그 자리 공 넓이의 ±50% 안이면 덜고(혼자 떨어진 공 크기 점이 더 싸짐), 밖이면 더함
  const two = frames(10, i => [[5 + 0.2 * i, 5, 1, AM * SC], [5 + 0.2 * i, 5.3, 1, 1.6 * AM * SC]]);
  assert.ok(ys(trackBall(two, { am: AM, scale })).every(y => y === 5));
  assert.equal(BALL_SIZE.w, 1.5); assert.equal(BALL_SIZE.tol, Math.log(1.5));
});

test('trackBall: size가 없으면 예전 trackBall과 값까지 같음 (v1·넓이 칸이 있는 줄 모두), 넓이 칸이 없는 후보는 크기 비용을 안 받음', () => {
  const old = fr => { // 크기 비용을 넣기 전 trackBall (636586b) 그대로
    const N = fr.length, MISS = 1.2, REACQ = 0.8, emis = c => (c[2] ? 0 : 1.1);
    let prev = [{ cost: 0, back: -1, pos: null }]; const hist = [];
    for (let i = 0; i < N; i++) {
      const f = fr[i], dt = i ? f.t - fr[i - 1].t : 0.1;
      const cur = [{ cost: Infinity, back: 0, pos: null }, ...f.ball.map(p => ({ cost: Infinity, back: 0, pos: p }))];
      cur.forEach((c, j) => { const e = j ? emis(c.pos) : MISS; prev.forEach((p, k) => { let tr; if (!j) tr = 0; else if (!p.pos) tr = REACQ; else { const d = Math.hypot(p.pos[0] - c.pos[0], p.pos[1] - c.pos[1]); tr = d > 0.5 + 20 * dt ? Infinity : 0.3 * d; } if (p.cost + tr + e < c.cost) { c.cost = p.cost + tr + e; c.back = k; } }); });
      hist.push(cur); prev = cur;
    }
    const out = new Float32Array(N * 2).fill(NaN);
    let k = prev.reduce((b, c, j) => (c.cost < prev[b].cost ? j : b), 0);
    for (let i = N - 1; i >= 0; i--) { const c = hist[i][k]; if (c.pos) { out[2 * i] = c.pos[0]; out[2 * i + 1] = c.pos[1]; } k = c.back; }
    let last = -1;
    for (let i = 0; i < N; i++) { if (Number.isNaN(out[2 * i])) continue; if (last >= 0 && i - last > 1 && fr[i].t - fr[last].t <= 1) { for (let j = last + 1; j < i; j++) { const a = (fr[j].t - fr[last].t) / (fr[i].t - fr[last].t); for (const d of [0, 1]) out[2 * j + d] = out[2 * last + d] + (out[2 * i + d] - out[2 * last + d]) * a; } } last = i; }
    return out;
  };
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 30; trial++) {
    const v2 = trial % 2 === 0;
    const fr = frames(80, i => (rnd() < 0.1 ? [] : Array.from({ length: Math.floor(rnd() * 5) }, () => [32 * rnd(), 18 * rnd(), rnd() < 0.5 ? 1 : 0, ...(v2 ? [10 + 200 * rnd()] : [])])), i => +(i * 0.1 + 0.02 * rnd()).toFixed(3));
    assert.deepEqual(trackBall(fr), old(fr), `무작위 ${trial}`);
    assert.deepEqual(trackBall(fr, null), old(fr));
  }
  // 넓이 칸이 없는 후보(3칸)는 크기 비용 없이 예전 비용 그대로
  const noArea = frames(10, i => [[5 + 0.2 * i, 5, 1]]);
  assert.deepEqual(trackBall(noArea, { am: AM, scale }), trackBall(noArea));
});

test('areaScale: 코트 → 분석 화면 px²/m² (그 자리마다), 직사각형 코트면 어디서나 같은 값', () => {
  const cfg = { court: [32, 18], corners: [[0, 0], [640, 0], [640, 360], [0, 360]] }, s = areaScale(cfg);
  for (const [X, Y] of [[1, 1], [16, 9], [30, 17]]) assert.ok(Math.abs(s(X, Y) - 400) < 1e-6, `${s(X, Y)}`); // 20px/m → 400px²/m²
  const persp = areaScale({ court: [32, 18], corners: [[200, 100], [440, 100], [620, 340], [20, 340]] }); // 위가 좁은 원근
  assert.ok(persp(16, 17) > persp(16, 1), '카메라 가까운 쪽(아래)이 더 큼');
});

test('v2 공 후보 줄은 [x, y, 혼자, 넓이px] 4칸·넓이 > 0, v1 줄은 예전처럼 3칸 (로컬 분석 도구 검출 기록 검사)', () => {
  const line = ball => ({ i: 3, t: 0.3, players: [[[1, 2]], []], ball });
  const v2 = b => detectionOk(line(b), 3, 2, 'classical-v2'), v1 = b => detectionOk(line(b), 3, 2, 'classical-v1');
  assert.ok(v2([]) && v2([[1, 2, 1, 50], [3, 4, 0, 12.5]]));
  for (const bad of [[[1, 2, 1]], [[1, 2, 1, 0]], [[1, 2, 1, -3]], [[1, 2, 2, 50]], [[1, 2, 1, NaN]], [[1, 2, 1, 50, 7]]]) assert.equal(v2(bad), false, JSON.stringify(bad));
  assert.ok(v1([[1, 2, 1], [3, 4, 0]]));
  assert.equal(v1([[1, 2, 1, 50]]), false, 'v1 줄은 3칸만');
  assert.ok(detectionOk(line([[1, 2, 1]]), 3, 2), '방식을 안 주면 v1 (예전 호출과 같음)');
});

test('ballSize: 도구 시각(i/10)의 장면 차가 부동소수점으로 0.1에서 조금 어긋나도(0.30000000000000004 − 0.2 등) 고정 0.1초와 같게 셈 (µs 반올림, 속도 경계)', () => {
  // 0과 0.3m를 오가는 길: 한 걸음이 딱 0.3m(부동소수점 0.3) → 0.3 / 0.1 = 2.9999999999999996 < 초속 3m라 고정 0.1초면 안 셈.
  // 시각 차를 그대로 쓰면 0.09999999999999998 같은 차에서 3.0000000000000004가 되어 세어짐 → 반올림으로 도구 결과를 실험(고정 0.1초)과 같게 둠
  const zig = frames(40, i => [[i % 2 ? 0.3 : 0, 5, 1, AM * SC]]);
  assert.ok(zig.some((f, i) => i && f.t - zig[i - 1].t !== 0.1), '시험 전제: i/10 시각 차가 0.1과 다른 칸이 있음');
  assert.equal(ballSize(zig, [32, 18], scale), null);
});

test('analyzeFrames: 공 크기 비용은 classical-v2에만 (v1은 예전 trackBall 그대로), 공 줄 넓이로 영상에서 공 넓이를 잼', async () => {
  const { analyzeFrames } = await import('../js/pipeline.js');
  const { resample } = await import('../js/track.js');
  const cfg = { width: 640, height: 360, corners: [[0, 0], [640, 0], [640, 360], [0, 360]], court: [32, 18], teams: [{ name: '빨강', color: '#ff0000', hue: [350, 10], sat: [100, 255] }] };
  const S = 400, area = AM * S; // 20px/m → 400px²/m²
  // 앞 3초: 혼자 빠르게(초속 4m) 굴러가는 공 크기 점 (공 넓이를 재는 데 쓰임). 뒤 1초: 공이 아이 발밑에 붙고(혼자 0) 0.5m 옆에 신발 끝 크기 흰 점이 혼자 따라감
  const dets = Array.from({ length: 40 }, (_, i) => ({ t: i / 10, players: [[[10, 4]]],
    ball: i < 30 ? [[2 + 0.4 * i, 9, 1, area]] : [[2 + 0.4 * i, 9, 0, area], [2 + 0.4 * i, 9.5, 1, 0.2 * area]] }));
  const r2 = a => Array.from(a, v => (Number.isNaN(v) ? null : Math.round(v * 100) / 100)), times = dets.map(d => d.t);
  const scale = areaScale(cfg), am = ballSize(dets, cfg.court, scale);
  assert.ok(Math.abs(am - AM) < 1e-9, `잰 공 넓이 ${am}`);
  const v1 = analyzeFrames(dets, cfg, { engine: 'classical-v1' }), v2 = analyzeFrames(dets, cfg, { engine: 'classical-v2' });
  assert.deepEqual(v1.ball, r2(resample(times, trackBall(dets), 0.1)), 'v1: 예전 trackBall');
  assert.deepEqual(v2.ball, r2(resample(times, trackBall(dets, { am, scale }), 0.1)), 'v2: 잰 공 넓이로 크기 비용');
  assert.notDeepEqual(v1.ball, v2.ball);
  assert.ok(Array.from({ length: 40 }, (_, i) => v2.ball[2 * i + 1]).every(y => y === 9), 'v2는 공 크기 점(y=9)');
});

test('trackBall 크기 비용 값: 가중 1.5·허용 ln 1.5가 고르는 결과를 가름 (공 크기 붙은 점 vs 2.5배 혼자 점, 4배 혼자 점만 있으면 숨김)', () => {
  // 아이 발밑 공 크기 점: 1.1 + 1.5·(0 − ln 1.5) = 0.49 < 2.5배 혼자 떨어진 점: 1.5·(ln 2.5 − ln 1.5) = 0.77 → 공 크기 점 (가중 1이면 0.69 > 0.51로 반대)
  const pairFr = frames(20, i => [[5 + 0.2 * i, 5, 0, AM * SC], [5 + 0.2 * i, 5.5, 1, 2.5 * AM * SC]]);
  assert.ok(ys(trackBall(pairFr, { am: AM, scale })).every(y => y === 5));
  assert.ok(ys(trackBall(pairFr, { am: AM, scale }, { ...BALL_SIZE, w: 1 })).every(y => y === 5.5), '가중 1이면 반대 (값이 결과를 가르는 장면)');
  // 흰 옷 크기(4배) 혼자 떨어진 점만 가만히 있으면: 1.5·(ln 4 − ln 1.5) = 1.47 > 안 보임 1.2 → 공을 안 보여 줌 (허용 ln 2나 가중 1이면 1.2보다 싸서 보여 줌)
  const big = frames(20, () => [[10, 6, 1, 4 * AM * SC]]);
  assert.ok(Array.from(trackBall(big, { am: AM, scale })).every(v => Number.isNaN(v)));
  assert.ok(Array.from(trackBall(big, { am: AM, scale }, { ...BALL_SIZE, tol: Math.log(2) })).every(v => !Number.isNaN(v)));
  assert.ok(Array.from(trackBall(big)).every(v => !Number.isNaN(v)), '크기 비용 없으면 예전처럼 보여 줌');
});

test('vision.detect 공 후보 줄: v2(몸 크기를 줄 때)는 넷째 칸에 흰 점 넓이 px, v1은 예전처럼 3칸', async () => {
  const { setup } = await import('../js/pipeline.js');
  const { detect } = await import('../js/vision.js');
  const w = 320, h = 180, bg = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) bg.set([0x2f, 0x7d, 0x5b, 255], 4 * i);
  const frame = bg.slice();
  let white = 0;
  // 혼자 떨어진 흰 공 (반지름 2px = 13px: 10px/m 화면이라 공 크기 상한 = 이론 3.1px의 6배 = 18.8px 안)
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 4) { frame.set([255, 255, 255, 255], 4 * ((90 + y) * w + 160 + x)); white++; }
  for (let y = 40; y < 66; y++) for (let x = 40; x < 58; x++) frame.set([220, 20, 20, 255], 4 * (y * w + x)); // 빨강 아이
  const cfg = { width: w, height: h, corners: [[0, 0], [w, 0], [w, h], [0, h]], court: [32, 18], teams: [{ name: '빨강', color: '#dc1414', hue: [350, 10], sat: [150, 255] }] };
  const s = setup(cfg, bg);
  const v1 = detect(frame, s.det);
  assert.equal(v1.ball.length, 1);
  assert.equal(v1.ball[0].length, 3, 'v1: [x, y, 혼자]');
  s.det.bodyPx = [400];
  const v2 = detect(frame, s.det);
  assert.equal(v2.ball.length, 1);
  assert.deepEqual(v2.ball[0].slice(0, 3), v1.ball[0], 'v2 앞 세 칸은 v1과 같음');
  assert.ok(Number.isInteger(v2.ball[0][3]) && v2.ball[0][3] > 0 && Math.abs(v2.ball[0][3] - white) <= 0.5 * white, `넓이 ${v2.ball[0][3]}px (그린 흰 점 ${white}px)`);
  assert.equal(s.toMeters(v2).ball[0][3], v2.ball[0][3], 'm 좌표로 바꿔도 넓이 px는 그대로');
});
