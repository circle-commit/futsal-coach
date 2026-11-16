// 합성 벤치마크 평가기: 분석 결과 파일(RESULT 또는 예전 raw result)과 정답(<장면>.truth.json)만 읽어 장면별 정확도를 잰다.
// 엔진 코드(js/)를 쓰지 않는다 (엔진과 독립인 잣대). 매칭(헝가리안)·속도 정의를 여기서 따로 구현한다.
//
// 사용:
//   node tools/bench/eval.mjs <폴더> [--json 보고.json]             # <장면>.truth.json ↔ <장면>-결과.json 모두
//   node tools/bench/eval.mjs <결과.json> <정답.json> [--json 보고.json]
//   node tools/bench/eval.mjs <폴더> --compare 결과,결과-v2 [--json 보고.json]  # 같은 영상의 두 결과(<장면>-결과.json·<장면>-결과-v2.json) 나란히
//
// 지표 (0.1초 칸마다):
//   아이 — 정답 아이 ↔ 결과 선수 헝가리안 매칭(1.0m 안). 결과 선수의 가려짐(hidden=1) 칸은 '그 칸 출력 없음'으로 본다.
//     번호 바뀜(ID switch, CLEAR-MOT): 정답 아이의 짝 결과 번호가 바뀐 횟수
//     번호 틀린 칸: 그 칸의 짝 결과 번호가 영상 전체의 짝(IDF1 짝)과 다른 칸 수·비율 (짧게 바뀌었다 돌아옴 vs 끝까지 바뀜 구별)
//     팀 인원: 정답 팀별 아이 수 vs 결과 counts
//     IDF1: 영상 전체에서 정답 아이 ↔ 결과 번호를 하나로 고정해 짝지었을 때(1.0m 안 칸 수가 가장 많게)의 F1
//     놓침(FN)·헛검출(FP): 칸마다 짝 없는 정답 아이·결과 선수 수의 합.
//       놓침은 색 놓침 구간(정답 loss)·가장자리(경계에서 1m 안이거나 밖)·그 밖으로, 헛검출은 선수 아닌 사람(정답 extras) 1m 안·가장자리·그 밖으로 나눠 센다
//     위치 오차: 칸마다 짝지은 쌍의 거리 중앙값·95%
//     뛴 거리 오차 %, 최고 속도 차(km/h), 질주 횟수 차: IDF1 짝(정답 아이 → 결과 선수)의 결과 통계 vs 정답 경로 통계.
//       정답 통계 = 정답 경로에 앱과 같은 정의 적용: 거리 = 0.1초 칸 사이 거리 합, 최고 속도 = 1초 평균 속도의 최대,
//       질주 = 0.5초 평균 속도가 초속 4m를 넘어선 횟수
//   공 — 결과 공이 정답에서 0.75m 안이면 맞음, 밖이면 틀림, 없으면(null) 놓침. 정답에서 공이 보일 때·몸에 가려졌을 때 따로
//   공 가진 아이 — 결과 공에서 1m 안 가장 가까운 결과 선수(앱 규칙과 같은 거리)를 IDF1 짝으로 정답 아이로 바꿔 정답과 비교
//   패스·뺏김 — 결과 목록을 IDF1 짝으로 바꿔 보낸·받은 아이가 같고 시각 차 0.5초 이내면 맞음 → 정밀도·재현율
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIG = 1e6;

/** 최소 합 짝짓기 (헝가리안, O(n³)). cost[n][m] 유한한 수. 반환: 행 → 열 (짝 없으면 -1) */
export function hungarian(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (!n || !m) return new Array(n).fill(-1);
  if (n > m) { // 행이 많으면 뒤집어서 풀고 되돌림
    const t = Array.from({ length: m }, (_, j) => cost.map(r => r[j])), a = hungarian(t), out = new Array(n).fill(-1);
    a.forEach((i, j) => { if (i >= 0) out[i] = j; });
    return out;
  }
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1), p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity), used = new Uint8Array(m + 1);
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

/** 경로 [x0,y0,…] (m, dt 간격)의 거리·최고 속도(1초 평균)·질주(0.5초 평균 > 4m/s로 넘어선 횟수) */
export function pathStats(p, dt, sprint = 4) {
  const n = p.length / 2, step = [];
  for (let i = 1; i < n; i++) step.push(Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]) / dt);
  const avg = k => { const out = []; let s = 0; for (let i = 0; i < step.length; i++) { s += step[i]; if (i >= k) s -= step[i - k]; if (i >= k - 1) out.push(s / k); } return out; };
  const v1 = avg(Math.round(1 / dt)), v5 = avg(Math.round(0.5 / dt));
  let sprints = 0; v5.forEach((v, i) => { if (v > sprint && !(i && v5[i - 1] > sprint)) sprints++; });
  return { distance: step.reduce((a, v) => a + v * dt, 0), topSpeed: v1.reduce((a, v) => (v > a ? v : a), 0), sprints };
}

const quant = (sorted, q) => (sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null);

/** 결과 파일 내용 → 분석 결과(result). RESULT(app futsal-coach-analysis)나 예전 raw result */
export function resultOf(doc) {
  const R = doc?.app === 'futsal-coach-analysis' ? doc.result : doc;
  if (!R || !Array.isArray(R.players) || !Array.isArray(R.ball) || !(R.dt > 0)) throw new Error('분석 결과 파일이 아니에요 (RESULT 또는 예전 결과 형식이어야 해요)');
  return R;
}

/** doc: 결과 파일 내용, truth: 정답. 반환: 장면 지표 */
export function evaluate(doc, truth, { gate = 1.0, ballGate = 0.75, ownerGate = 1.0, passWindow = 0.5 } = {}) {
  const R = resultOf(doc), dt = truth.dt, G = truth.kids, P = R.players;
  if (Math.abs(R.dt - dt) > 1e-9) throw new Error(`결과 간격 ${R.dt}초가 정답 간격 ${dt}초와 달라요`);
  const N = Math.min(truth.frames, P.length ? P[0].path.length / 2 : Infinity, R.ball.length / 2);
  const fin = (x, y) => Number.isFinite(x) && Number.isFinite(y);
  const gAt = (g, i) => (fin(g.path[2 * i], g.path[2 * i + 1]) ? [g.path[2 * i], g.path[2 * i + 1]] : null);
  const hAt = (h, i) => { const p = P[h]; return p.hidden?.[i] === 1 || !fin(p.path[2 * i], p.path[2 * i + 1]) ? null : [p.path[2 * i], p.path[2 * i + 1]]; };

  // ----- 칸마다 매칭: 놓침·헛검출·번호 바뀜·위치 오차, IDF1용 함께 있던 칸 수 -----
  let fn = 0, fp = 0, gtN = 0, hypN = 0;
  const why = { fnLoss: 0, fnEdge: 0, fnOther: 0, fpExtra: 0, fpEdge: 0, fpOther: 0 }, [CL, CW] = truth.court;
  const nearEdge = ([x, y]) => x < 1 || y < 1 || x > CL - 1 || y > CW - 1; // 경계에서 1m 안이거나 밖
  const inLoss = (g, t) => (G[g].loss || []).some(([a, b]) => t >= a && t < b);
  const errs = [], last = new Array(G.length).fill(-1), switches = [], co = G.map(() => new Float64Array(P.length)), matches = [];
  for (let i = 0; i < N; i++) {
    const gs = [], hs = [];
    G.forEach((g, k) => { const a = gAt(g, i); if (a) gs.push([k, a]); });
    P.forEach((_, k) => { const b = hAt(k, i); if (b) hs.push([k, b]); });
    gtN += gs.length; hypN += hs.length;
    const cost = gs.map(([g, a]) => hs.map(([h, b]) => { const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d <= gate) co[g][h]++; return d <= gate ? d : BIG; }));
    const asg = hungarian(cost), used = new Set(), t = i * dt;
    gs.forEach(([g, a], r) => {
      const c = asg[r];
      if (c < 0 || cost[r][c] >= BIG) { fn++; why[inLoss(g, t) ? 'fnLoss' : nearEdge(a) ? 'fnEdge' : 'fnOther']++; return; }
      const h = hs[c][0]; used.add(c); errs.push(cost[r][c]); matches.push([g, h]);
      if (last[g] >= 0 && last[g] !== h) switches.push({ kid: g, t: +t.toFixed(1), from: last[g], to: h });
      last[g] = h;
    });
    hs.forEach(([, b], c) => {
      if (used.has(c)) return;
      fp++;
      const extra = (truth.extras || []).some(e => Math.hypot(e.path[2 * i] - b[0], e.path[2 * i + 1] - b[1]) <= gate);
      why[extra ? 'fpExtra' : nearEdge(b) ? 'fpEdge' : 'fpOther']++;
    });
  }
  // ----- IDF1: 정답 아이 ↔ 결과 번호 하나로 고정 (함께 있던 칸 수 최대) -----
  const map = hungarian(co.map(r => Array.from(r, v => -v))).map((h, g) => (h >= 0 && co[g][h] > 0 ? h : -1));
  const idtp = map.reduce((a, h, g) => a + (h >= 0 ? co[g][h] : 0), 0);
  const inv = new Map(); map.forEach((h, g) => { if (h >= 0) inv.set(h, g); });
  const toKid = h => (inv.has(h) ? inv.get(h) : -2); // -2: 정답 아이와 짝이 없는 결과 선수
  const wrongByKid = G.map(() => 0); for (const [g, h] of matches) if (h !== map[g]) wrongByKid[g]++;
  const wrong = wrongByKid.reduce((a, v) => a + v, 0);
  const teamsN = Math.max(...G.map(g => g.team)) + 1, truthCounts = Array.from({ length: teamsN }, (_, t) => G.filter(g => g.team === t).length);

  // ----- 아이별 통계 (IDF1 짝) -----
  const perKid = G.map((g, k) => {
    const truthStats = pathStats(g.path.slice(0, 2 * N), dt), h = map[k];
    if (h < 0) return { kid: k, label: g.label, player: null, truth: truthStats, wrongIdCells: wrongByKid[k] };
    const r = P[h];
    return { kid: k, label: g.label, player: h, truth: truthStats, result: { distance: r.distance, topSpeed: r.topSpeed, sprints: r.sprints },
      distErrPct: truthStats.distance > 1 ? ((r.distance - truthStats.distance) / truthStats.distance) * 100 : null,
      topSpeedDiffKmh: (r.topSpeed - truthStats.topSpeed) * 3.6, sprintDiff: r.sprints - truthStats.sprints, wrongIdCells: wrongByKid[k] };
  });
  const mapped = perKid.filter(x => x.player != null), absMean = a => (a.length ? a.reduce((s, v) => s + Math.abs(v), 0) / a.length : null), absMax = a => (a.length ? a.reduce((s, v) => Math.max(s, Math.abs(v)), 0) : null);
  const dErr = mapped.map(x => x.distErrPct).filter(v => v != null), sErr = mapped.map(x => x.topSpeedDiffKmh);

  // ----- 공·공 가진 아이 -----
  const ball = { visible: { ok: 0, wrong: 0, miss: 0 }, hidden: { ok: 0, wrong: 0, miss: 0 } }, owner = { agree: 0, total: 0, falseOwner: 0, free: 0 };
  for (let i = 0; i < N; i++) {
    const tx = truth.ball.path[2 * i], ty = truth.ball.path[2 * i + 1], bx = R.ball[2 * i], by = R.ball[2 * i + 1], has = fin(bx, by);
    const c = ball[truth.ball.visible[i] ? 'visible' : 'hidden'];
    if (!has) c.miss++; else if (Math.hypot(bx - tx, by - ty) <= ballGate) c.ok++; else c.wrong++;
    let o = -1;
    if (has) { let bd = ownerGate; P.forEach((p, k) => { const x = p.path[2 * i], y = p.path[2 * i + 1]; if (!fin(x, y)) return; const d = Math.hypot(x - bx, y - by); if (d < bd) { bd = d; o = k; } }); }
    const want = truth.ball.owner[i], got = o < 0 ? -1 : toKid(o);
    if (want >= 0) { owner.total++; if (got === want) owner.agree++; } else { owner.free++; if (got !== -1) owner.falseOwner++; }
  }
  const rate = c => { const n = c.ok + c.wrong + c.miss; return { ...c, n, okPct: n ? (100 * c.ok) / n : null, wrongPct: n ? (100 * c.wrong) / n : null, missPct: n ? (100 * c.miss) / n : null }; };

  // ----- 패스·뺏김 -----
  const events = (want, got) => {
    const used = new Set(); let tp = 0; const missed = [];
    for (const w of [...want].sort((a, b) => a.t - b.t)) {
      let best = -1, bd = Infinity;
      got.forEach((g, k) => { if (used.has(k) || toKid(g.from) !== w.from || toKid(g.to) !== w.to) return; const d = Math.abs(g.t - w.t); if (d <= passWindow && d < bd) { bd = d; best = k; } });
      if (best >= 0) { used.add(best); tp++; } else missed.push(w);
    }
    const extra = got.filter((_, k) => !used.has(k)).map(g => ({ from: toKid(g.from), to: toKid(g.to), t: g.t }));
    return { truth: want.length, result: got.length, tp, precision: got.length ? tp / got.length : null, recall: want.length ? tp / want.length : null, missed, extra };
  };
  const tp = truth.passes || [];
  const sortedErr = errs.sort((a, b) => a - b);
  return {
    scene: truth.scene, title: truth.title, frames: N, kids: G.length, players: P.length, analysisSeconds: doc?.analysis?.seconds ?? null,
    engine: doc?.analysis?.engine ?? null,
    counts: { truth: truthCounts, result: Array.isArray(R.counts) ? R.counts : null },
    ids: { switches: switches.length, wrongIdCells: wrong, wrongIdPct: matches.length ? (100 * wrong) / matches.length : 0, idf1: gtN + hypN ? (2 * idtp) / (gtN + hypN) : 1, fn, fp, ...why, truthCells: gtN, resultCells: hypN, mapping: map, switchLog: switches },
    position: { n: sortedErr.length, median: quant(sortedErr, 0.5), p95: quant(sortedErr, 0.95) },
    stats: { perKid, unmapped: perKid.length - mapped.length, distErrPctMeanAbs: absMean(dErr), distErrPctMaxAbs: absMax(dErr), topSpeedDiffMeanAbsKmh: absMean(sErr), topSpeedDiffMaxAbsKmh: absMax(sErr), sprintDiffAbsSum: mapped.reduce((a, x) => a + Math.abs(x.sprintDiff), 0) },
    ball: { visible: rate(ball.visible), hidden: rate(ball.hidden) },
    owner: { ...owner, agreePct: owner.total ? (100 * owner.agree) / owner.total : null, falseOwnerPct: owner.free ? (100 * owner.falseOwner) / owner.free : null },
    passes: events(tp.filter(p => p.type === 'pass'), R.passes || []),
    turnovers: events(tp.filter(p => p.type === 'turnover'), R.turnovers || []),
    events: (truth.events || []).map(e => ({ name: e.name, kids: e.kids, t0: e.t0, t1: e.t1, switches: switches.filter(s => e.kids.includes(s.kid) && s.t >= e.t0 - 1 && s.t <= e.t1 + 1).length })),
  };
}

// ---------- 표 ----------
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const pr = e => `${f(e.precision == null ? null : e.precision * 100, 0)}/${f(e.recall == null ? null : e.recall * 100, 0)} (${e.tp}/${e.result}·${e.truth})`;
export function formatTable(rows) {
  const head = ['장면', '팀 인원 정답→결과', '번호바뀜', '번호 틀린 칸 (%)', 'IDF1', '놓침 칸 (색놓침/가장자리/기타)', '헛검출 칸 (관중/가장자리/기타)', '위치오차 중앙/95% m', '거리오차 평균/최대 %', '최고속도차 평균/최대 km/h', '질주차 합', '공(보일때) 맞음/틀림/놓침 %', '공가진아이 일치 %', '패스 정밀/재현 %', '뺏김 정밀/재현 %', '분석 s'];
  const body = rows.map(m => m.error ? [m.scene, `결과 없음: ${m.error}`] : [
    m.scene, `${m.counts.truth.join('/')}→${m.counts.result ? m.counts.result.join('/') : '–'}`, String(m.ids.switches), `${m.ids.wrongIdCells} (${f(m.ids.wrongIdPct)})`, f(m.ids.idf1, 3), `${m.ids.fn} (${m.ids.fnLoss}/${m.ids.fnEdge}/${m.ids.fnOther})`, `${m.ids.fp} (${m.ids.fpExtra}/${m.ids.fpEdge}/${m.ids.fpOther})`,
    `${f(m.position.median, 2)}/${f(m.position.p95, 2)}`, `${f(m.stats.distErrPctMeanAbs)}/${f(m.stats.distErrPctMaxAbs)}`,
    `${f(m.stats.topSpeedDiffMeanAbsKmh)}/${f(m.stats.topSpeedDiffMaxAbsKmh)}`, String(m.stats.sprintDiffAbsSum),
    `${f(m.ball.visible.okPct, 0)}/${f(m.ball.visible.wrongPct, 0)}/${f(m.ball.visible.missPct, 0)}`,
    f(m.owner.agreePct, 0), pr(m.passes), pr(m.turnovers), f(m.analysisSeconds, 0),
  ]);
  return [head, ...body].map(r => '| ' + r.join(' | ') + ' |').join('\n').replace(/^(\|[^\n]*\|)\n/, (_, h) => h + '\n|' + head.map(() => '---').join('|') + '|\n');
}

/** 같은 영상의 두 결과(A·B)를 나란히: 'A → B' */
export function formatCompare(pairs, [la, lb]) {
  const cols = [['팀 인원', m => (m.counts.result ? m.counts.result.join('/') : null), null], ['IDF1', m => m.ids.idf1, 3], ['번호바뀜', m => m.ids.switches, 0], ['번호 틀린 %', m => m.ids.wrongIdPct, 1], ['놓침 칸', m => m.ids.fn, 0], ['헛검출 칸', m => m.ids.fp, 0], ['관중 헛검출', m => m.ids.fpExtra, 0],
    ['위치오차 중앙 m', m => m.position.median, 2], ['거리오차 평균 %', m => m.stats.distErrPctMeanAbs, 1], ['최고속도차 평균 km/h', m => m.stats.topSpeedDiffMeanAbsKmh, 1], ['질주차 합', m => m.stats.sprintDiffAbsSum, 0],
    ['공 맞음 %', m => m.ball.visible.okPct, 0], ['공가진아이 %', m => m.owner.agreePct, 0], ['패스 재현 %', m => (m.passes.recall == null ? null : m.passes.recall * 100), 0], ['뺏김 재현 %', m => (m.turnovers.recall == null ? null : m.turnovers.recall * 100), 0]];
  const head = ['장면', ...cols.map(c => `${c[0]} (${la} → ${lb})`)];
  const val = (m, get, d) => (m.error ? '없음' : d == null ? get(m) ?? '–' : f(get(m), d));
  const body = pairs.map(([a, b]) => [a.scene || b.scene, ...cols.map(([, get, d]) => `${val(a, get, d)} → ${val(b, get, d)}`)]);
  return [head, ...body].map(r => '| ' + r.join(' | ') + ' |').join('\n').replace(/^(\|[^\n]*\|)\n/, (_, h) => h + '\n|' + head.map(() => '---').join('|') + '|\n');
}

// ---------- 명령 ----------
// 폴더의 장면들: synth가 남긴 bench-run.json의 순서, 없으면 이름순
function sceneList(dir) {
  const all = fs.readdirSync(dir).filter(n => n.endsWith('.truth.json')).map(n => n.slice(0, -'.truth.json'.length)).sort();
  let order = []; try { order = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'bench-run.json'), 'utf8')).scenes || {}); } catch {}
  return [...order.filter(s => all.includes(s)), ...all.filter(s => !order.includes(s))];
}
function main(argv) {
  let json = null, compare = null; const pos = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--json') json = argv[++i]; else if (argv[i] === '--compare') compare = argv[++i].split(','); else if (argv[i] === '--help' || argv[i] === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 20).map(l => l.slice(3)).join('\n')); return 0; } else pos.push(argv[i]); }
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const run = (r, truth) => { try { return evaluate(read(r), truth); } catch (e) { return { scene: truth.scene, error: e.code === 'ENOENT' ? '파일 없음' : e.message }; } };
  if (compare) {
    if (pos.length !== 1 || compare.length !== 2) { console.error('사용: node tools/bench/eval.mjs <폴더> --compare 결과,결과-v2'); return 2; }
    const dir = pos[0], scenes = sceneList(dir);
    const pairs = scenes.map(s => { const truth = read(path.join(dir, `${s}.truth.json`)); return compare.map(sfx => run(path.join(dir, `${s}-${sfx}.json`), truth)); });
    const label = k => pairs.map(p => p[k].engine).find(Boolean) || compare[k];
    console.log(formatCompare(pairs, [label(0), label(1)]));
    if (json) fs.writeFileSync(json, JSON.stringify({ at: new Date().toISOString(), compare, pairs }, null, 2));
    return 0;
  }
  let pairs;
  if (pos.length === 1 && fs.statSync(pos[0]).isDirectory()) {
    const dir = pos[0];
    pairs = sceneList(dir).map(s => [path.join(dir, `${s}-결과.json`), path.join(dir, `${s}.truth.json`)]);
  } else if (pos.length === 2) pairs = [[pos[0], pos[1]]];
  else { console.error('사용: node tools/bench/eval.mjs <폴더> | <결과.json> <정답.json> [--json 보고.json]'); return 2; }
  const rows = pairs.map(([r, t]) => run(r, read(t)));
  console.log(formatTable(rows));
  for (const m of rows.filter(x => !x.error)) {
    console.log(`\n[${m.scene}] ${m.title}`);
    console.log('  이벤트별 번호 바뀜: ' + m.events.map(e => `${e.name} ${e.switches}`).join(', '));
    const bad = m.stats.perKid.filter(k => k.player == null || Math.abs(k.distErrPct ?? 0) >= 10 || Math.abs(k.topSpeedDiffKmh ?? 0) >= 3 || k.sprintDiff || k.wrongIdCells);
    if (bad.length) console.log('  눈에 띄는 아이: ' + bad.map(k => k.player == null ? `${k.label}(짝 없음)` : `${k.label}→선수${k.player} 번호 틀린 칸 ${k.wrongIdCells} 거리 ${f(k.distErrPct)}% 최고속도 ${f(k.topSpeedDiffKmh)}km/h 질주 ${k.sprintDiff > 0 ? '+' : ''}${k.sprintDiff}`).join('; '));
  }
  if (json) fs.writeFileSync(json, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
