// 뛴 거리·최고 속도·질주 오차의 원인 나누기 (합성 벤치마크, 엔진 코드는 바꾸지 않음)
// 정답 경로에 classical-v1 통계 규칙을 한 단계씩 얹어, 단계마다 바뀐 만큼을 그 원인의 기여로 본다 (합 = 결과 - 정답).
//   S0 정답 경로 길이 → c 0.5초 이동평균 → b 번호 바뀜(결과 선수가 실제로 따라간 아이의 정답 위치) →
//   a 가려진 칸(마지막 위치 유지 + 그 칸의 이동 제외) → d1 가려짐 6칸 창(앞뒤로 넓혀 제외) → d2 초속 9m 넘는 칸 0 →
//   e 나머지 = 결과 파일의 값 - 위 규칙을 다 얹은 정답 (검출 위치 떨림·치우침)
// 규칙을 바꾸면 오차가 얼마나 줄지도 실제 v1 결과(결과 경로·가려짐)에 다른 규칙을 적용해 추정한다.
// 사용: node tools/bench/causes.mjs <벤치 폴더> [--suffix 결과] [--json 보고.json]
// 주의: 아래 stats()는 js/track.js playerStats(classical-v1)의 계산을 옮긴 것. 엔진 규칙이 바뀌면 같이 고쳐야 하며,
//       실행할 때 결과 파일의 거리와 다시 맞춰 보아(자체 확인) 어긋나면 알려 준다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hungarian, resultOf, pathStats } from './eval.mjs';

const BIG = 1e6;
const movAvg = (a, k) => { const out = []; let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= k) s -= a[i - k]; if (i >= k - 1) out.push(s / k); } return out; };

/** classical-v1 통계 (규칙을 끄고 켤 수 있게). hid: 'window'(엔진: 이동평균에 든 칸 중 하나라도 가려지면 0) | 'core'(가운데 두 칸이 가려질 때만 0) | 'none' */
export function stats(pos, hidden, dt, { smooth = 5, hid = 'window', vmax = 9, sprint = 4 } = {}) {
  const n = pos.length / 2;
  if (n < 12) return { distance: 0, topSpeed: 0, sprints: 0 };
  const xs = Array.from({ length: n }, (_, i) => pos[2 * i]), ys = Array.from({ length: n }, (_, i) => pos[2 * i + 1]);
  const sx = movAvg(xs, smooth), sy = movAvg(ys, smooth), h = Array.from(hidden), hw = movAvg(h, smooth + 1), c = Math.floor((smooth - 1) / 2);
  const v = [];
  for (let i = 0; i < sx.length - 1; i++) {
    let s = Math.hypot(sx[i + 1] - sx[i], sy[i + 1] - sy[i]) / dt;
    const off = hid === 'window' ? hw[i] > 0 : hid === 'core' ? h[i + c] || h[i + c + 1] : false;
    if (s > vmax || off) s = 0;
    v.push(s);
  }
  let sprints = 0; v.forEach((s, i) => { if (s > sprint && !(i && v[i - 1] > sprint)) sprints++; });
  const v1 = movAvg(v, Math.round(1 / dt));
  return { distance: v.reduce((a, b) => a + b, 0) * dt, topSpeed: v1.reduce((m, x) => Math.max(m, x), 0), sprints };
}

// 가려진 칸 위치: 앞에서 마지막으로 보인 자리 (처음부터 가려졌으면 처음 보인 자리)
function hold(pos, hidden) {
  const out = pos.slice(), n = hidden.length; let last = -1;
  for (let i = 0; i < n; i++) if (!hidden[i]) { last = i; break; }
  if (last < 0) return out;
  for (let i = 0; i < n; i++) { if (!hidden[i]) last = i; else { out[2 * i] = pos[2 * last]; out[2 * i + 1] = pos[2 * last + 1]; } }
  return out;
}
// 가려진 칸을 앞뒤로 보인 자리 사이 직선으로 메움 (규칙 바꾸기 추정용)
function bridge(pos, hidden) {
  const out = pos.slice(), n = hidden.length;
  for (let i = 0; i < n;) {
    if (!hidden[i]) { i++; continue; }
    let j = i; while (j < n && hidden[j]) j++;
    const a = i - 1, b = j < n ? j : -1;
    for (let k = i; k < j; k++) {
      if (a < 0 && b < 0) break;
      const u = a < 0 ? 1 : b < 0 ? 0 : (k - a) / (b - a), p = a < 0 ? b : a, q = b < 0 ? a : b;
      out[2 * k] = pos[2 * p] + (pos[2 * q] - pos[2 * p]) * u; out[2 * k + 1] = pos[2 * p + 1] + (pos[2 * q + 1] - pos[2 * p + 1]) * u;
    }
    i = j;
  }
  return out;
}

/** 장면 하나: 아이별 단계 값과 원인 기여 */
export function causes(doc, truth, { gate = 1.0 } = {}) {
  const R = resultOf(doc), dt = truth.dt, G = truth.kids, P = R.players;
  const N = Math.min(truth.frames, P[0].path.length / 2), fin = (x, y) => Number.isFinite(x) && Number.isFinite(y);
  // 칸마다 결과 선수 ↔ 정답 아이 (평가기와 같은 헝가리안, 가려진 결과 칸은 빼고)
  const follow = P.map(() => new Int16Array(N).fill(-1)), co = G.map(() => new Float64Array(P.length));
  for (let i = 0; i < N; i++) {
    const hs = P.map((p, k) => (p.hidden[i] || !fin(p.path[2 * i], p.path[2 * i + 1]) ? null : k)).filter(k => k != null);
    const cost = G.map(g => hs.map(k => { const d = Math.hypot(g.path[2 * i] - P[k].path[2 * i], g.path[2 * i + 1] - P[k].path[2 * i + 1]); return d <= gate ? d : BIG; }));
    hungarian(cost).forEach((c, g) => { if (c >= 0 && cost[g][c] < BIG) { follow[hs[c]][i] = g; co[g][hs[c]]++; } });
  }
  const map = hungarian(co.map(r => Array.from(r, v => -v))).map((h, g) => (h >= 0 && co[g][h] > 0 ? h : -1));
  return G.map((g, k) => {
    const h = map[k]; if (h < 0) return { kid: k, label: g.label, player: null };
    const T = g.path.slice(0, 2 * N), hid = P[h].hidden.slice(0, N), zero = new Array(N).fill(0);
    const Tb = T.slice(); for (let i = 0; i < N; i++) { const f = follow[h][i]; if (f >= 0 && f !== k) { Tb[2 * i] = G[f].path[2 * i]; Tb[2 * i + 1] = G[f].path[2 * i + 1]; } }
    const Tab = hold(Tb, hid), none = { hid: 'none', vmax: Infinity };
    const S = [
      pathStats(T, dt), // S0 정답 (평가기 정의)
      stats(T, zero, dt, none), // c
      stats(Tb, zero, dt, none), // b
      stats(Tab, hid, dt, { hid: 'core', vmax: Infinity }), // a
      stats(Tab, hid, dt, { hid: 'window', vmax: Infinity }), // d1
      stats(Tab, hid, dt), // d2 (= 정답에 엔진 규칙을 다 얹음)
      { distance: P[h].distance, topSpeed: P[h].topSpeed, sprints: P[h].sprints }, // e: 결과 파일
    ];
    const RP = P[h].path.slice(0, 2 * N), mine = stats(RP, hid, dt); // 자체 확인: 옮긴 규칙으로 결과 경로를 계산
    const alt = { // 규칙을 바꾸면 (실제 v1 결과 경로·가려짐에 적용)
      now: mine.distance,
      core: stats(RP, hid, dt, { hid: 'core' }).distance, // 가려짐 창을 가운데 칸만으로
      bridge: stats(bridge(RP, hid), zero, dt).distance, // 가려진 칸을 직선으로 메우고 제외하지 않음
      smooth3: stats(RP, hid, dt, { smooth: 3 }).distance, // 이동평균 0.3초
      bridge3: stats(bridge(RP, hid), zero, dt, { smooth: 3 }).distance, // 둘 다
    };
    const names = ['c', 'b', 'a', 'd1', 'd2', 'e'], part = key => Object.fromEntries(names.map((n, j) => [n, S[j + 1][key] - S[j][key]]));
    return { kid: k, label: g.label, player: h, truth: S[0], result: S[6], dist: part('distance'), top: part('topSpeed'), spr: part('sprints'), selfCheck: mine.distance - P[h].distance, alt, hiddenCells: hid.reduce((a, b) => a + b, 0) };
  });
}

// ---------- 명령 ----------
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 && d >= 0 ? '+' : '') + v.toFixed(d));
function main(argv) {
  let suffix = '결과', json = null; const pos = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--suffix') suffix = argv[++i]; else if (argv[i] === '--json') json = argv[++i]; else pos.push(argv[i]); }
  if (pos.length !== 1) { console.error('사용: node tools/bench/causes.mjs <벤치 폴더> [--suffix 결과] [--json 보고.json]'); return 2; }
  const dir = pos[0], read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  let order = []; try { order = Object.keys(read(path.join(dir, 'bench-run.json')).scenes); } catch {}
  const all = fs.readdirSync(dir).filter(n => n.endsWith('.truth.json')).map(n => n.slice(0, -11)).sort(), scenes = [...order.filter(s => all.includes(s)), ...all.filter(s => !order.includes(s))];
  const rows = [], kidsAll = [];
  for (const s of scenes) {
    const truth = read(path.join(dir, `${s}.truth.json`)); let kids;
    try { kids = causes(read(path.join(dir, `${s}-${suffix}.json`)), truth).filter(k => k.player != null); } catch (e) { rows.push({ scene: s, error: e.message }); continue; }
    kidsAll.push(...kids.map(k => ({ scene: s, ...k })));
    const D0 = kids.reduce((a, k) => a + k.truth.distance, 0), sum = key => kids.reduce((a, k) => a + k.dist[key], 0);
    const err = kids.map(k => (100 * (k.result.distance - k.truth.distance)) / k.truth.distance), alt = key => kids.reduce((a, k) => a + Math.abs(k.alt[key] - k.truth.distance) / k.truth.distance, 0) * 100 / kids.length;
    rows.push({ scene: s, kids: kids.length, totalPct: (100 * kids.reduce((a, k) => a + k.result.distance - k.truth.distance, 0)) / D0, meanAbsPct: err.reduce((a, v) => a + Math.abs(v), 0) / err.length,
      parts: Object.fromEntries(['c', 'b', 'a', 'd1', 'd2', 'e'].map(n => [n, (100 * sum(n)) / D0])), selfCheckMaxAbsM: Math.max(...kids.map(k => Math.abs(k.selfCheck))),
      alt: { now: alt('now'), core: alt('core'), bridge: alt('bridge'), smooth3: alt('smooth3'), bridge3: alt('bridge3') } });
  }
  console.log('| 장면 | 아이 | 합계 오차 % | 이동평균 c | 번호바뀜 b | 가려진 칸 a | 가려짐 창 d1 | 9m/s 컷 d2 | 위치 떨림 e | 평균 |오차| % | 자체확인 최대 m |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r.error ? `| ${r.scene} | ${r.error} |` : `| ${r.scene} | ${r.kids} | ${f(r.totalPct)} | ${f(r.parts.c)} | ${f(r.parts.b)} | ${f(r.parts.a)} | ${f(r.parts.d1)} | ${f(r.parts.d2)} | ${f(r.parts.e)} | ${r.meanAbsPct.toFixed(1)} | ${r.selfCheckMaxAbsM.toFixed(2)} |`);
  const ok = rows.filter(r => !r.error), avg = g => ok.reduce((a, r) => a + g(r), 0) / ok.length;
  console.log('\n규칙을 바꾸면 (평균 |거리 오차| %, 실제 v1 결과 경로·가려짐에 적용): ' + ['now', 'core', 'bridge', 'smooth3', 'bridge3'].map(k => `${{ now: '지금', core: '가려짐 창→가운데 칸만', bridge: '가려진 칸 직선 메움', smooth3: '이동평균 0.3초', bridge3: '직선 메움+0.3초' }[k]} ${avg(r => r.alt[k]).toFixed(1)}`).join(' · '));
  for (const r of ok) console.log(`  ${r.scene}: ${['now', 'core', 'bridge', 'smooth3', 'bridge3'].map(k => r.alt[k].toFixed(1)).join(' / ')}`);
  const mean = (key, sub) => kidsAll.reduce((a, k) => a + k[key][sub], 0) / kidsAll.length;
  console.log('\n최고 속도 차 평균 (km/h, 아이당): ' + ['c', 'b', 'a', 'd1', 'd2', 'e'].map(n => `${n} ${f(mean('top', n) * 3.6, 2)}`).join(' · ') + ` = 합 ${f(kidsAll.reduce((a, k) => a + k.result.topSpeed - k.truth.topSpeed, 0) / kidsAll.length * 3.6, 2)}`);
  console.log('질주 횟수 차 합 (회): ' + ['c', 'b', 'a', 'd1', 'd2', 'e'].map(n => `${n} ${f(kidsAll.reduce((a, k) => a + k.spr[n], 0), 0)}`).join(' · ') + ` = 합 ${f(kidsAll.reduce((a, k) => a + k.result.sprints - k.truth.sprints, 0), 0)}`);
  if (json) fs.writeFileSync(json, JSON.stringify({ at: new Date().toISOString(), suffix, rows, kids: kidsAll }, null, 2));
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
