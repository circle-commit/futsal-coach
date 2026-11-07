// 전술 지표 (순수 계산): 팀 영역 다각형, 폭·깊이·면적·수비 라인·간격, 누적 거리, 공 점유 팀
import { possession } from './track.js';

/** 볼록 껍질(모노톤 체인). pts: [[x,y],...] → 꼭짓점 배열(반시계) */
export function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
export const polyArea = h => Math.abs(h.reduce((s, [x, y], i) => { const [u, v] = h[(i + 1) % h.length]; return s + x * v - u * y; }, 0)) / 2;

const smooth = (a, k) => { // 가운데 정렬 이동평균 (지표 떨림 줄이기)
  const pre = [0]; for (const v of a) pre.push(pre[pre.length - 1] + v);
  return Float32Array.from(a, (_, i) => { const lo = Math.max(0, i - k), hi = Math.min(a.length, i + k + 1); return (pre[hi] - pre[lo]) / (hi - lo); });
};

/** R: 저장된 분석 결과. 반환값은 프레임별 배열이라 화면은 i번째 값만 읽으면 된다 */
export function computeTactics(R) {
  const P = R.players, [L] = R.court, N = P[0].path.length / 2, dt = R.dt;
  const at = (p, i) => [p.path[2 * i], p.path[2 * i + 1]];
  // 비교할 두 팀: 인원이 많은 순
  const teams = R.teams.map((_, t) => t).filter(t => P.some(p => p.team === t)).sort((a, b) => P.filter(p => p.team === b).length - P.filter(p => p.team === a).length).slice(0, 2);
  // 골키퍼: 한쪽 골라인 6m(코트 길이의 17%) 안에 머문 시간이 가장 많은 아이. 절반 이상일 때만
  const gk = {}, ownGoalLeft = {}, near = 0.17 * L;
  for (const t of teams) {
    const ps = P.filter(p => p.team === t);
    let best = null, bf = 0, side = true, sx = 0;
    for (const p of ps) {
      let l = 0, r = 0;
      for (let i = 0; i < N; i++) { const x = p.path[2 * i]; sx += x; if (x < near) l++; else if (x > L - near) r++; }
      if (Math.max(l, r) / N > bf) { bf = Math.max(l, r) / N; best = p; side = l >= r; }
    }
    if (ps.length > 2 && bf >= 0.5) { gk[t] = best.id; ownGoalLeft[t] = side; }
    else ownGoalLeft[t] = sx / (ps.length * N) < L / 2; // 골키퍼가 없으면 팀이 주로 있던 쪽을 자기 진영으로
  }
  const field = t => P.filter(p => p.team === t && p.id !== gk[t]);
  const metrics = {}, hulls = {};
  for (const t of teams) {
    const ps = field(t), m = { width: [], depth: [], area: [], defLine: [], compact: [] };
    hulls[t] = [];
    for (let i = 0; i < N; i++) {
      const pts = ps.map(p => at(p, i)), xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      const h = convexHull(pts); hulls[t].push(h);
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      m.width.push(Math.max(...ys) - Math.min(...ys));
      m.depth.push(Math.max(...xs) - Math.min(...xs));
      m.area.push(h.length >= 3 ? polyArea(h) : 0);
      m.defLine.push(Math.max(0, ownGoalLeft[t] ? Math.min(...xs) : L - Math.max(...xs))); // 자기 골라인에서 가장 뒤에 있는 필드 선수까지 (골라인 밖이면 0)
      m.compact.push(pts.reduce((a, [x, y]) => a + Math.hypot(x - cx, y - cy), 0) / pts.length);
    }
    metrics[t] = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, smooth(v, 5)])); // 1초 평균
  }
  // 누적 거리: 활동량 계산과 같은 규칙(0.5초 평균 위치, 9m/s 넘는 튐·가려진 순간 제외)
  const cum = P.map(p => {
    const xs = smooth(Array.from({ length: N }, (_, i) => p.path[2 * i]), 2), ys = smooth(Array.from({ length: N }, (_, i) => p.path[2 * i + 1]), 2);
    const out = new Float32Array(N);
    for (let i = 1; i < N; i++) {
      let d = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      if (d / dt > 9 || p.hidden[i] || p.hidden[i - 1]) d = 0;
      out[i] = out[i - 1] + d;
    }
    return out;
  });
  // 공 점유 팀: 공을 가진 구간 + 다음 소유 전까지 3초는 직전 팀으로 본다
  const ball = Float32Array.from(R.ball, v => (v == null ? NaN : v));
  const pz = possession(ball, P.map(p => ({ team: p.team, pos: p.path })), dt);
  const ownerTeam = new Int8Array(N).fill(-1);
  pz.segments.forEach((g, k) => {
    const next = pz.segments[k + 1]?.s ?? N, end = Math.min(next, g.e + Math.round(3 / dt));
    for (let i = g.s; i < end; i++) ownerTeam[i] = P[g.p].team;
  });
  return { teams, gk, ownGoalLeft, metrics, hulls, cum, ownerTeam, N };
}
