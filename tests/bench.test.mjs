// 합성 벤치마크(tools/bench) 짧은 회귀: 정답 생성이 장면 설계대로인지, 평가기가 정답과 만든 결과로 지표를 맞게 내는지 (영상·ffmpeg 없이)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTruth, makeJob, SCENES, CLUTTER_SCENES, ALL_SCENES, EXTRA_SCENES, COURT, FRAMES, clutterPlan } from '../tools/bench/synth.mjs';
import { evaluate, hungarian, pathStats, formatCompare } from '../tools/bench/eval.mjs';

const T = Object.fromEntries(SCENES.map(s => [s, makeTruth(s)]));
const at = (k, i) => [k.path[2 * i], k.path[2 * i + 1]];
const dist = (a, b, i) => Math.hypot(a.path[2 * i] - b.path[2 * i], a.path[2 * i + 1] - b.path[2 * i + 1]);
const win = (t0, t1) => Array.from({ length: Math.round((t1 - t0) * 10) + 1 }, (_, k) => Math.round(t0 * 10) + k);
const minIn = (a, b, t0, t1) => Math.min(...win(t0, t1).map(i => dist(a, b, i)));
const speeds = k => Array.from({ length: FRAMES - 1 }, (_, i) => dist(k, { path: k.path.slice(2) }, i) / 0.1);

// 정답 그대로인 '완벽한' 분석 결과 (예전 raw result 형식)
function perfect(truth) {
  const players = truth.kids.map(k => { const s = pathStats(k.path, truth.dt); return { id: k.id, team: k.team, label: k.label, ...s, possession: 0, touches: 0, passes: 0, received: 0, lost: 0, path: k.path.slice(), hidden: new Array(truth.frames).fill(0) }; });
  const pick = type => truth.passes.filter(p => p.type === type).map(({ from, to, t }) => ({ from, to, t }));
  return { dt: truth.dt, court: truth.court, teams: truth.teams, counts: [3, 3, 3], duration: truth.duration, players, ball: truth.ball.path.slice(), passes: pick('pass'), turnovers: pick('turnover'), hiddenRate: 0, ballSeen: 1, video: truth.video };
}

test('정답 생성: 장면 9개가 같은 시드면 같고, 0.1초 200칸·아이 9명, 작업 설정 파일은 웹 형식 검사를 통과', () => {
  assert.deepEqual(SCENES, ['cross', 'cluster', 'contact', 'sprint', 'pass', 'spectators', 'edge', 'colorloss', 'reappear']);
  for (const s of SCENES) {
    const t = T[s];
    assert.deepEqual(makeTruth(s), t, `${s} 결정적`);
    assert.equal(t.frames, 200); assert.equal(t.kids.length, 9); assert.deepEqual(t.kids.map(k => k.team), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
    t.kids.forEach(k => assert.equal(k.path.length, 400)); assert.equal(t.ball.path.length, 400); assert.equal(t.ball.owner.length, 200);
    assert.ok(t.passes.length >= 4, `${s} 공이 오감`);
    const job = makeJob(s); assert.equal(job.config.width, 1280); assert.deepEqual(job.config.court, COURT); assert.equal(job.config.teams.length, 3);
    // 이벤트에 든 쌍이 아니면 아이끼리 0.9m 넘게 떨어져 있다 (장면마다 재려는 상황만 생김)
    for (let i = 0; i < t.frames; i++) for (let a = 0; a < 9; a++) for (let b = a + 1; b < 9; b++) {
      if (t.events.some(e => e.kids.includes(a) && e.kids.includes(b) && i / 10 >= e.t0 - 1 && i / 10 <= e.t1 + 1)) continue;
      assert.ok(dist(t.kids[a], t.kids[b], i) > 0.9, `${s} ${a}-${b} ${i / 10}초 ${dist(t.kids[a], t.kids[b], i).toFixed(2)}m`);
    }
  }
});

test('장면 설계: 스침 0.6·0.3m, 셋 뭉침, 몸싸움·나란히, 질주 7·6·4.5m/s, 패스·가로채기·숨긴 공', () => {
  const { cross, cluster, contact, sprint, pass } = T;
  assert.ok(Math.abs(minIn(cross.kids[0], cross.kids[1], 5, 7) - 0.6) < 0.01); assert.ok(Math.abs(minIn(cross.kids[0], cross.kids[1], 12, 14) - 0.3) < 0.01);
  for (const [ks, t0, t1] of [[[3, 4, 5], 6.5, 9.5], [[0, 5, 6], 15, 16.5]]) for (const a of ks) for (const b of ks) if (a < b) assert.ok(Math.max(...win(t0, t1).map(i => dist(cluster.kids[a], cluster.kids[b], i))) < 0.55, `뭉침 ${a}-${b}`);
  const c17 = win(6.3, 8.2).map(i => dist(contact.kids[1], contact.kids[7], i));
  assert.ok(Math.min(...c17) >= 0.3 && Math.max(...c17) <= 0.5, '몸싸움 0.3~0.5m');
  assert.ok(win(12, 17).every(i => Math.abs(dist(contact.kids[4], contact.kids[8], i) - 0.45) < 0.01), '나란히 0.45m');
  const top = k => Math.max(...speeds(sprint.kids[k]));
  assert.ok(Math.abs(top(0) - 7) < 0.05 && Math.abs(top(6) - 6) < 0.05 && Math.abs(top(3) - 4.5) < 0.05, `질주 ${top(0)} ${top(6)} ${top(3)}`);
  assert.equal(pathStats(sprint.kids[0].path, 0.1).sprints, 2);
  assert.deepEqual(pass.passes, [{ from: 0, to: 1, t: 4.5, type: 'pass' }, { from: 1, to: 2, t: 8.5, type: 'pass' }, { from: 2, to: 3, t: 12, type: 'turnover' }, { from: 3, to: 4, t: 15, type: 'pass' }]);
  assert.ok(win(16.7, 17.5).every(i => pass.ball.visible[i] === 0 && pass.ball.owner[i] === 4), '발밑에 숨긴 공은 안 보이고 보라 2가 가짐');
  assert.ok(win(1, 4.4).every(i => pass.ball.owner[i] === 0 && pass.ball.visible[i] === 1), '드리블 중엔 보임');
});

test('추가 장면 설계: 코트 밖 1~1.5m 관중(선수 아님), 사이드라인 안·밖 달림, 색 놓침 구간, 다시 나타날 때 같은 팀 옆 0.7m', () => {
  const { spectators, edge, colorloss, reappear } = T, [L, W] = COURT;
  const outBy = ([x, y]) => Math.max(-x, -y, x - L, y - W); // 코트 밖으로 나간 거리 (안이면 음수)
  assert.equal(spectators.extras.length, 3);
  for (const e of spectators.extras) for (let i = 0; i < 200; i++) { const o = outBy(at(e, i)); assert.ok(o >= 1 && o <= 1.5, `관중 ${e.label} ${o}`); }
  for (const [k, t0, t1, lo, hi] of [[0, 3.5, 8.5, -0.31, -0.29], [3, 3.5, 8.5, 0.24, 0.26], [6, 4.5, 8.5, 0.24, 0.26], [1, 13.5, 17.5, 0.29, 0.31]]) {
    for (const i of win(t0, t1)) { const o = outBy(at(edge.kids[k], i)); assert.ok(o >= lo && o <= hi, `가장자리 ${k} ${i / 10}초 ${o}`); }
  }
  assert.deepEqual(colorloss.kids.filter(k => k.loss).map(k => k.id), [1, 2, 4, 7]);
  assert.ok(colorloss.kids.flatMap(k => k.loss || []).every(([a, b]) => b - a >= 0.2 - 1e-9 && b - a <= 0.9 + 1e-9));
  assert.deepEqual(reappear.kids[1].loss, [[6, 9]]); assert.deepEqual(reappear.kids[7].loss, [[12, 14.5]]);
  assert.ok(Math.abs(dist(reappear.kids[1], reappear.kids[0], 90) - 0.7) < 0.02 && Math.abs(dist(reappear.kids[7], reappear.kids[8], 145) - 0.71) < 0.02);
});

test('잡동사니 장면: 기존 장면과 아이·공·패스는 같고, 조끼 없는 어른 5명(선수 아님)은 엔진 코트 마스크(선 밖 1.5m) 안, 잡티 계획은 시드마다 같다', () => {
  assert.deepEqual(CLUTTER_SCENES, ['cross-clutter', 'pass-clutter', 'colorloss-clutter', 'reappear-clutter']); assert.deepEqual(ALL_SCENES, [...SCENES, ...CLUTTER_SCENES]);
  const [L, W] = COURT, outBy = ([x, y]) => Math.max(-x, -y, x - L, y - W);
  for (const s of CLUTTER_SCENES) {
    const c = makeTruth(s), b = T[s.replace('-clutter', '')];
    assert.deepEqual(makeTruth(s), c, `${s} 결정적`); assert.deepEqual(c.kids, b.kids); assert.deepEqual(c.ball, b.ball); assert.deepEqual(c.passes, b.passes);
    assert.equal(c.extras.length, 5); assert.ok(c.clutter?.shadows); assert.equal(makeJob(s).sourceName, `${s}.mp4`);
    for (const e of c.extras) for (let i = 0; i < 200; i++) assert.ok(outBy(at(e, i)) <= 1.5, `${s} ${e.label}`);
    const p1 = clutterPlan(s), p2 = clutterPlan(s);
    assert.deepEqual(p1, p2); assert.ok(p1.blocks.length > 2000 && p1.flashes.length >= 5);
  }
  for (const s of SCENES) assert.equal('clutter' in T[s], false, `${s}는 그대로`);
});

test('추가 장면 bigkid·bigkid-early(공식표 밖): 파랑 3번 몸 반지름 0.31m(넓이 약 1.9배), 파랑 2번 4~10초(early는 0~6초) 색 놓침, 아이끼리 2m 넘게 떨어짐(나누면 한 사람을 둘로 나눈 것)', () => {
  assert.deepEqual(EXTRA_SCENES, ['bigkid', 'bigkid-early']); assert.ok(EXTRA_SCENES.every(s => !ALL_SCENES.includes(s)));
  const early = makeTruth('bigkid-early'); assert.deepEqual(early.kids[1].loss, [[0, 6]]); assert.equal(early.kids[2].bodyRadius, 0.31); // 팀이 처음부터 모자람
  const t = makeTruth('bigkid');
  assert.deepEqual(makeTruth('bigkid'), t); assert.equal(t.kids[2].bodyRadius, 0.31); assert.deepEqual(t.kids[1].loss, [[4, 10]]); assert.equal(makeJob('bigkid').sourceName, 'bigkid.mp4');
  for (let i = 0; i < 200; i++) for (let a = 0; a < 9; a++) for (let b = a + 1; b < 9; b++) assert.ok(dist(t.kids[a], t.kids[b], i) > 2, `${a}-${b} ${i / 10}초`);
});

test('평가기: 정답 그대로인 결과는 번호 바뀜 0·IDF1 1·놓침/헛검출 0·오차 0·공 다 맞음·패스 다 맞음 (RESULT로 감싸도 같음)', () => {
  for (const s of SCENES) {
    const m = evaluate(perfect(T[s]), T[s]);
    assert.equal(m.ids.switches, 0); assert.equal(m.ids.wrongIdCells, 0); assert.equal(m.ids.idf1, 1); assert.equal(m.ids.fn, 0); assert.equal(m.ids.fp, 0);
    assert.deepEqual(m.counts, { truth: [3, 3, 3], result: [3, 3, 3] });
    assert.equal(m.position.median, 0); assert.equal(m.position.p95, 0);
    assert.equal(m.stats.distErrPctMaxAbs, 0); assert.equal(m.stats.topSpeedDiffMaxAbsKmh, 0); assert.equal(m.stats.sprintDiffAbsSum, 0);
    assert.equal(m.ball.visible.okPct, 100);
    for (const e of [m.passes, m.turnovers]) { assert.equal(e.tp, e.truth); assert.equal(e.recall, e.truth ? 1 : null); assert.equal(e.precision, e.result ? 1 : null); }
    assert.ok(m.owner.agreePct >= 99, `${s} 공 가진 아이 ${m.owner.agreePct}`);
  }
  const wrapped = { app: 'futsal-coach-analysis', version: 1, session: {}, result: perfect(T.pass), analysis: { engine: 'classical-v2', seconds: 3 } };
  const a = evaluate(wrapped, T.pass), b = evaluate(perfect(T.pass), T.pass);
  assert.equal(a.engine, 'classical-v2'); assert.equal(a.analysisSeconds, 3);
  assert.deepEqual({ ...a, engine: null, analysisSeconds: null }, { ...b, engine: null, analysisSeconds: null });
});

test('평가기: 두 아이 번호가 중간에 바뀌면 번호 바뀜 2·IDF1 = 맞는 칸/전체, 가려진 칸은 색 놓침·가장자리·기타 놓침, 관중·코트 밖 헛검출을 나눠 센다', () => {
  const R = perfect(T.sprint), [p0, p1] = R.players;
  for (let i = 100; i < 200; i++) for (const d of [0, 1]) [p0.path[2 * i + d], p1.path[2 * i + d]] = [p1.path[2 * i + d], p0.path[2 * i + d]];
  const m = evaluate(R, T.sprint);
  assert.equal(m.ids.switches, 2); assert.equal(m.ids.idf1, (2 * (7 * 200 + 2 * 100)) / (1800 + 1800));
  assert.deepEqual(m.ids.switchLog.map(x => [x.kid, x.t]), [[0, 10], [1, 10]]);
  assert.equal(m.ids.wrongIdCells, 200); assert.equal(m.ids.wrongIdPct, (100 * 200) / 1800);
  // 짧게(1초) 바뀌었다 돌아오면 번호 바뀜은 4로 더 많지만 번호 틀린 칸은 20뿐 (끝까지 바뀐 것과 구별)
  const B = perfect(T.sprint), [b0, b1] = B.players;
  for (let i = 100; i < 110; i++) for (const d of [0, 1]) [b0.path[2 * i + d], b1.path[2 * i + d]] = [b1.path[2 * i + d], b0.path[2 * i + d]];
  const brief = evaluate(B, T.sprint);
  assert.equal(brief.ids.switches, 4); assert.equal(brief.ids.wrongIdCells, 20); assert.ok(brief.ids.idf1 > m.ids.idf1);
  B.counts = [4, 4, 4]; assert.deepEqual(evaluate(B, T.sprint).counts, { truth: [3, 3, 3], result: [4, 4, 4] });

  const C = perfect(T.colorloss); C.players[1].hidden.fill(1);
  const c = evaluate(C, T.colorloss), lossCells = Array.from({ length: 200 }, (_, i) => i * 0.1).filter(t => T.colorloss.kids[1].loss.some(([a, b]) => t >= a && t < b)).length;
  assert.equal(c.ids.fn, 200); assert.equal(c.ids.fnLoss, lossCells); assert.equal(lossCells, 13); assert.equal(c.ids.fnEdge, 0); assert.equal(c.ids.fnOther, 187);
  assert.equal(c.stats.unmapped, 1, '한 번도 안 보인 아이는 짝 없음');

  const E = perfect(T.edge); E.players[3].hidden.fill(1);
  assert.ok(evaluate(E, T.edge).ids.fnEdge >= 60, '사이드라인 밖을 달리는 아이를 놓치면 가장자리 놓침');

  const S = perfect(T.spectators), ghost = (path, id) => ({ ...S.players[0], id, path, hidden: new Array(200).fill(0) });
  S.players.push(ghost(T.spectators.extras[0].path.slice(), 9), ghost(Array.from({ length: 400 }, (_, k) => (k % 2 ? 6 : 35.5)), 10)); // 관중 옷 사람, 끝줄 밖 0.5m
  const sp = evaluate(S, T.spectators);
  assert.equal(sp.ids.fp, 400); assert.equal(sp.ids.fpExtra, 200); assert.equal(sp.ids.fpEdge, 200); assert.equal(sp.ids.fpOther, 0);
});

test('평가기: 공 0.75m 기준(맞음·틀림·놓침), 패스 시각 ±0.5초, 헝가리안 = 전수 탐색, 엔진 코드(js/)를 쓰지 않음, v1·v2 나란히 표', () => {
  const R = perfect(T.pass);
  R.ball = R.ball.map((v, k) => (k % 2 ? v : v + 0.8));
  assert.equal(evaluate(R, T.pass).ball.visible.wrongPct, 100);
  R.ball = R.ball.map(() => null);
  assert.equal(evaluate(R, T.pass).ball.visible.missPct, 100);
  const P = perfect(T.pass); P.passes.forEach(p => { p.t += 0.4; });
  assert.equal(evaluate(P, T.pass).passes.recall, 1);
  P.passes.forEach(p => { p.t += 0.2; });
  assert.equal(evaluate(P, T.pass).passes.recall, 0);

  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const perms = n => (n <= 1 ? [[0]] : perms(n - 1).flatMap(p => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)])));
  for (const [n, m] of [[5, 5], [4, 6], [6, 3]]) for (let rep = 0; rep < 20; rep++) {
    const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(rnd() * 100) / 10));
    const a = hungarian(cost), got = a.reduce((s, j, i) => s + (j >= 0 ? cost[i][j] : 0), 0);
    const k = Math.min(n, m), rows = n <= m ? perms(m).map(p => p.slice(0, n)) : null;
    const best = n <= m ? Math.min(...rows.map(p => p.reduce((s, j, i) => s + cost[i][j], 0))) : Math.min(...perms(n).map(p => p.slice(0, m).reduce((s, i, j) => s + cost[i][j], 0)));
    assert.equal(a.filter(j => j >= 0).length, k); assert.ok(Math.abs(got - best) < 1e-9, `${n}×${m} ${got} vs ${best}`);
  }
  const src = fs.readFileSync(new URL('../tools/bench/eval.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*\/js\//.test(src) && !/import\(['"][^'"]*\/js\//.test(src), '평가기는 엔진 코드를 불러오지 않음');
  const v1 = evaluate(perfect(T.cross), T.cross), v2 = { ...v1, engine: 'classical-v2', ids: { ...v1.ids, idf1: 0.5 } };
  const table = formatCompare([[v1, v2]], ['classical-v1', 'classical-v2']);
  assert.match(table, /IDF1 \(classical-v1 → classical-v2\)/); assert.match(table, /\| cross \| 3\/3\/3 → 3\/3\/3 \| 1\.000 → 0\.500 \|/);
});
