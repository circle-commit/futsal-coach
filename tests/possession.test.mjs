// node --test tests/
// 공 소유·통계 약속: ① 같은 결과면 같은 숫자 — 분석 직후(pipeline.analyzeFrames) 통계 = 검수 다시 계산(review.recomputeStats) (v1·v2, 같은 stats.fillStats·같은 0.01m 입력)
// ② 같은 아이의 앞뒤 소유 구간은 사이가 1초(track.POSSESSION.mergeGap) 이하일 때만 합치고 사이도 그 아이 소유, 길면 따로(터치도 따로), 같은 아이끼리는 패스·뺏김 아님
//    (나머지 규칙 — 1m 안 가장 가까운 아이, 0.2초 이상, 패스는 4초 안 — 은 그대로)
// ③ 사이에 다른 아이 0.2초 구간이 생기거나 없어져도 한 아이 소유 변화는 사이 1초 + 그 구간 안 (예전 규칙은 몇십 초까지 흔들림)
// ④ 배포 직후 캐시 섞임: 새 pipeline·stats·review와 옛 track.js, 옛 review.js·pipeline.js와 새 track.js가 만나도 오류 없음 (직전 배포 6caff12 파일로)
// ⑤ 전술 화면 공 점유 띠(tactics.computeTactics)는 새 구간에서도 구간마다 그 아이 팀
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { possession, POSSESSION } from '../js/track.js';
import { analyzeFrames } from '../js/pipeline.js';
import { recomputeStats } from '../js/review.js';
import { computeTactics } from '../js/tactics.js';

const DT = 0.1, KEYS = ['distance', 'topSpeed', 'sprints', 'possession', 'touches', 'passes', 'received', 'lost'];
const statsOf = p => Object.fromEntries(KEYS.map(k => [k, p[k]]));

// ---------- 합성 검출: 20×12m 코트, 팀마다 둘, 30초(10fps). 공은 아이 발밑·패스·안 보임·아무도 없는 곳을 오감 ----------
const cfg = { width: 200, height: 120, corners: [[0, 0], [200, 0], [200, 120], [0, 120]], court: [20, 12],
  teams: [{ name: '빨강', color: '#e61e1e', hue: [350, 10], sat: [150, 255] }, { name: '파랑', color: '#1e28e6', hue: [225, 245], sat: [150, 255] }] };
const kid = [i => [2 + 0.03 * i, 3], i => [15 - 0.02 * i, 4 + 0.004 * i], i => [5 + 0.01 * i, 9], i => [16, 8 + 0.005 * i]]; // 0·1 빨강, 2·3 파랑
const gone = (k, i) => (k === 1 && i >= 100 && i < 113) || (k === 2 && i >= 200 && i < 206); // 가려짐
function ballAt(i) {
  const near = k => { const [x, y] = kid[k](i); return [x + 0.3, y + 0.2]; }, lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  if (i < 50) return near(0);
  if (i < 60) return lerp(near(0), near(1), (i - 49) / 11); // 같은 팀 패스
  if (i < 120) return near(1);
  if (i < 128) return null; // 공 안 보임 0.8초 → 같은 아이로 이어짐
  if (i < 170) return near(1);
  if (i < 190) return [10, 11.5]; // 아무도 없는 곳 2초 → 같은 아이 따로 두 번
  if (i < 230) return near(1);
  if (i < 240) return lerp(near(1), near(2), (i - 229) / 11); // 뺏김
  return near(2);
}
const dets = (v2) => Array.from({ length: 300 }, (_, i) => {
  const b = ballAt(i);
  return { t: +(i * DT).toFixed(1), players: [[0, 1].filter(k => !gone(k, i)).map(k => kid[k](i)), [2, 3].filter(k => !gone(k, i)).map(k => kid[k](i))],
    ball: b ? [[b[0], b[1], 1, ...(v2 ? [30] : [])]] : [] };
});

test('① 같은 결과면 같은 숫자: 교정 안 한 결과를 다시 계산(recomputeStats)하면 분석 직후 통계와 정확히 같음 (v1·v2)', () => {
  for (const engine of ['classical-v1', 'classical-v2']) {
    const R = analyzeFrames(dets(engine === 'classical-v2'), cfg, { engine }), re = recomputeStats(R);
    R.players.forEach((p, k) => assert.deepEqual(statsOf(re.players[k]), statsOf(p), `${engine} 선수${k}`));
    assert.deepEqual([re.passes, re.turnovers, re.hiddenRate], [R.passes, R.turnovers, R.hiddenRate], engine);
    // 시험이 소유·패스·뺏김·가려짐을 실제로 거치는지
    assert.ok(R.passes.length >= 1 && R.turnovers.length >= 1 && R.hiddenRate > 0, `${engine}: 패스 ${R.passes.length} 뺏김 ${R.turnovers.length}`);
    assert.ok(R.players.some(p => p.touches >= 2), `${engine}: 같은 아이가 따로 두 번 이상 잡은 구간이 있음`);
  }
});

// ---------- possession 단위 시험: 아이 A·B(빨강), C·D(파랑)가 멀리 떨어져 서 있고, 공 자리로 소유자를 정함 ----------
const KIDS = { A: 0, B: 1, C: 2, D: 3 }, TEAM = [0, 0, 1, 1];
const spot = k => [10 + 10 * k, 5];
/** 'A10 -5 ?3 B2' → 칸마다 공: A 옆(0.3m)·아무도 없는 곳(-)·모름(?) */
function timeline(spec) {
  const cells = [];
  for (const tok of spec.trim().split(/\s+/)) {
    const c = tok[0], n = +tok.slice(1);
    for (let j = 0; j < n; j++) cells.push(c === '-' ? [5, 15] : c === '?' ? [NaN, NaN] : [spot(KIDS[c])[0] + 0.3, 5]);
  }
  const N = cells.length, ball = Float32Array.from(cells.flat());
  const players = TEAM.map((team, k) => ({ team, pos: Float32Array.from(Array.from({ length: N }, () => spot(k)).flat()) }));
  return { ball, players, N };
}
const pz = spec => { const { ball, players } = timeline(spec); return possession(ball, players, DT); };
const round = r => ({ time: r.time.map(v => +v.toFixed(6)), touches: r.touches, passes: r.passes.map(p => [p.from, p.to]), turnovers: r.turnovers.map(p => [p.from, p.to]) });
// 예전 규칙(6caff12): 같은 아이 앞뒤 구간을 사이 시간 제한 없이 합침 — 차이를 보이려고 시험 안에 그대로 둠
function oldPossession(ball, players, dt, near = 1.0) {
  const n = ball.length / 2, owner = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) { const bx = ball[2 * i], by = ball[2 * i + 1]; if (Number.isNaN(bx)) continue; let bd = near, b = -1; players.forEach((p, k) => { const d = Math.hypot(p.pos[2 * i] - bx, p.pos[2 * i + 1] - by); if (d < bd) { bd = d; b = k; } }); owner[i] = b; }
  const segs = []; for (let i = 0; i < n;) { let j = i; while (j < n && owner[j] === owner[i]) j++; if (owner[i] >= 0 && j - i >= 2) segs.push({ p: owner[i], s: i, e: j }); i = j; }
  const merged = []; for (const g of segs) { const l = merged[merged.length - 1]; if (l && l.p === g.p) l.e = g.e; else merged.push({ ...g }); }
  return { time: players.map((_, k) => merged.filter(g => g.p === k).reduce((s, g) => s + (g.e - g.s) * dt, 0)) };
}

test('② 같은 아이 앞뒤 구간: 사이 1초 이하면 합치고 사이도 소유(터치 1), 1초 넘으면 따로(터치 2), 같은 아이끼리는 패스·뺏김 아님', () => {
  assert.deepEqual(POSSESSION, { near: 1.0, minCells: 2, mergeGap: 1.0, passGap: 4 });
  assert.deepEqual(round(pz('A10 -5 A10')), { time: [2.5, 0, 0, 0], touches: [1, 0, 0, 0], passes: [], turnovers: [] }, '사이 0.5초: 합침');
  assert.deepEqual(round(pz('A10 -10 A10')).time[0], 3, '사이 딱 1초: 합침 (경계 포함)');
  assert.deepEqual(round(pz('A10 ?8 A10')), { time: [2.8, 0, 0, 0], touches: [1, 0, 0, 0], passes: [], turnovers: [] }, '공 안 보인 0.8초도 사이');
  assert.deepEqual(round(pz('A10 -11 A10')), { time: [2, 0, 0, 0], touches: [2, 0, 0, 0], passes: [], turnovers: [] }, '사이 1.1초: 따로 두 번, 패스 아님');
  assert.deepEqual(round(pz('A10 -50 A10 -3 B10')), { time: [2, 1, 0, 0], touches: [2, 1, 0, 0], passes: [[0, 1]], turnovers: [] }, '긴 사이 뒤 같은 아이 → 그다음 넘김은 패스로');
  // 예전 규칙과 다른 곳: 사이가 길면 예전엔 사이(5초)까지 그 아이 소유로 셌음
  const { ball, players } = timeline('A10 -50 A10');
  assert.equal(+oldPossession(ball, players, DT).time[0].toFixed(6), 7);
  assert.equal(+possession(ball, players, DT).time[0].toFixed(6), 2);
});

test('② 나머지 규칙은 그대로: 1m 안 가장 가까운 아이(1m는 안 셈), 0.2초 이상, 다른 아이 넘김은 4초 안만 (같은 팀 패스·다른 팀 뺏김)', () => {
  assert.deepEqual(round(pz('A10 B1 A10')), { time: [2.1, 0, 0, 0], touches: [1, 0, 0, 0], passes: [], turnovers: [] }, 'B 0.1초는 구간 아님 → A 사이 0.1초로 합침');
  assert.deepEqual(round(pz('A10 -20 B10')).passes, [[0, 1]], '같은 팀 2초 뒤 → 패스');
  assert.deepEqual(round(pz('A10 -40 C10')).turnovers, [[0, 2]], '다른 팀 4초 뒤 → 뺏김 (4초 포함)');
  assert.deepEqual(round(pz('A10 -41 C10')), { time: [1, 0, 1, 0], touches: [1, 0, 1, 0], passes: [], turnovers: [] }, '4.1초면 이어진 플레이 아님');
  // 1m 경계: 공이 A에서 0.99m면 A, 1.00m면 아무도 아님
  const at = d => { const { players } = timeline('A10'), ball = Float32Array.from(Array.from({ length: 10 }, () => [spot(0)[0] + d, 5]).flat()); return possession(ball, players, DT).time[0]; };
  assert.equal(+at(0.99).toFixed(6), 1); assert.equal(at(1.0), 0);
});

test('③ 사이에 다른 아이 0.2초 구간이 생기거나 없어져도 한 아이 소유 변화는 사이 1초 + 그 구간 안 (무작위 400번, 예전 규칙은 이 상한을 넘음)', () => {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647), pick = a => a[Math.floor(rnd() * a.length)];
  const randomPart = () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => `${pick(['A', 'B', 'C', 'D', '-', '?'])}${1 + Math.floor(rnd() * 15)}`).join(' ');
  const bound = POSSESSION.mergeGap + 2 * DT + 1e-6;
  let oldOver = 0;
  for (let t = 0; t < 400; t++) {
    const a = pick(['A', 'B', 'C', 'D']), y = pick(['A', 'B', 'C', 'D'].filter(k => k !== a)); // 사이 양쪽은 a, 끼어드는 0.2초는 다른 아이 y
    const gap = 2 + Math.floor(rnd() * 30), at = Math.floor(rnd() * (gap - 1)), fill = pick(['-', '?']);
    const pre = randomPart(), post = randomPart(), mid = `${a}${2 + Math.floor(rnd() * 10)}`;
    const without = `${pre} -2 ${mid} ${fill}${gap} ${a}${2 + Math.floor(rnd() * 10)} -2 ${post}`;
    const withY = without.replace(`${fill}${gap}`, `${at ? `${fill}${at} ` : ''}${y}2${gap - at - 2 > 0 ? ` ${fill}${gap - at - 2}` : ''}`);
    const T0 = pz(without).time, T1 = pz(withY).time;
    T0.forEach((v, k) => assert.ok(Math.abs(T1[k] - v) <= bound, `${without} → ${withY}: 아이${k} ${v.toFixed(1)} → ${T1[k].toFixed(1)}초`));
    const o = s => { const { ball, players } = timeline(s); return oldPossession(ball, players, DT).time; };
    const O0 = o(without), O1 = o(withY);
    if (O0.some((v, k) => Math.abs(O1[k] - v) > bound)) oldOver++;
  }
  assert.ok(oldOver > 50, `예전 규칙은 상한을 자주 넘음 (${oldOver}/400)`);
});

test('④ 배포 직후 캐시 섞임: 새 pipeline·stats·review + 옛 track.js, 옛 review.js·pipeline.js + 새 track.js·stats.js가 만나도 모듈 오류 없이 돎 (직전 배포 6caff12)', async t => {
  const old = f => spawnSync('git', ['show', `6caff12:js/${f}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  if (old('track.js').status !== 0) { t.skip('git 기록(6caff12)이 없어 건너뜀'); return; }
  const here = f => fs.readFileSync(fileURLToPath(new URL(`../js/${f}`, import.meta.url)), 'utf8');
  const mk = files => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'futsal-mix-')); for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(d, f), src); return d; };
  const now = ['pipeline.js', 'stats.js', 'review.js', 'track.js', 'vision.js'];
  const cases = [
    ['새 pipeline·stats·review + 옛 track.js', { ...Object.fromEntries(now.map(f => [f, here(f)])), 'track.js': old('track.js').stdout }],
    ['옛 review.js·pipeline.js + 새 track.js·stats.js', { ...Object.fromEntries(now.map(f => [f, here(f)])), 'review.js': old('review.js').stdout, 'pipeline.js': old('pipeline.js').stdout }],
  ];
  for (const [name, files] of cases) {
    const d = mk(files);
    try {
      const P = await import(pathToFileURL(path.join(d, 'pipeline.js')).href), V = await import(pathToFileURL(path.join(d, 'review.js')).href);
      const R = P.analyzeFrames(dets(true), cfg), re = V.recomputeStats(R);
      assert.equal(R.players.length, 4, name);
      assert.ok(re.players.every(p => Number.isFinite(p.possession) && Number.isFinite(p.distance)), name);
      if (name.startsWith('새 pipeline')) R.players.forEach((p, k) => assert.deepEqual(statsOf(re.players[k]), statsOf(p), `${name}: 같은 탭 안에선 분석·다시 계산이 같은 track.js라 같은 숫자`));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test('⑤ 전술 화면 공 점유 띠: 새 소유 구간마다 그 아이 팀으로 칠해지고, 1초 넘게 끊긴 같은 아이 구간도 문제없음', () => {
  const R = analyzeFrames(dets(true), cfg), T = computeTactics(R);
  const ball = Float32Array.from(R.ball, v => (v == null ? NaN : v)), segs = possession(ball, R.players.map(p => ({ team: p.team, pos: Float32Array.from(p.path, v => (v == null ? NaN : v)) })), R.dt).segments;
  assert.ok(segs.some((g, k) => k && segs[k - 1].p === g.p), '같은 아이 구간이 연달아 있는 장면 (1초 넘게 끊김)');
  for (const g of segs) for (let i = g.s; i < g.e; i++) assert.equal(T.ownerTeam[i], R.players[g.p].team, `칸 ${i}`);
  assert.ok(Array.from(T.ownerTeam).every(v => v === -1 || v === 0 || v === 1));
});
