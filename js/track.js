// 프레임별 검출(m 좌표) → 선수 추적 → 활동량. 순수 함수라 node 테스트로 확인한다.
// frames: [{ t, players: [[[x,y],...] 팀별], ball: [[x,y],...] }]

// 헝가리안 최소 비용 매칭. cost: n x m. 반환: 행마다 열 번호(없으면 -1)
export function assign(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (!n || !m) return new Array(n).fill(-1);
  if (n > m) { // 열이 더 적으면 뒤집어서 풀기
    const t = assign(cost[0].map((_, j) => cost.map(r => r[j]))), out = new Array(n).fill(-1);
    t.forEach((i, j) => { if (i >= 0) out[i] = j; });
    return out;
  }
  const INF = 1e18, u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
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

// 팀별 인원 = 프레임마다 보인 수의 최빈값
export function rosterCounts(frames, nTeams) {
  return Array.from({ length: nTeams }, (_, t) => {
    const c = {}; let best = 0, arg = 0;
    for (const f of frames) { const k = f.players[t].length; c[k] = (c[k] || 0) + 1; if (c[k] > best || (c[k] === best && k > arg)) { best = c[k]; arg = k; } }
    return arg;
  });
}

function runTeam(frames, team, init, idxs, pos, hid) {
  const tr = init.map(([x, y]) => ({ x, y, lt: frames[idxs[0]].t }));
  for (const i of idxs) {
    const f = frames[i], det = f.players[team], ok = new Set();
    if (det.length) {
      const cost = tr.map(k => det.map(([x, y]) => Math.hypot(k.x - x, k.y - y)));
      assign(cost).forEach((j, r) => {
        // 오래 놓친 선수일수록 멀리서도 다시 잡는다 (아이 최고 8m/s 가정)
        if (j >= 0 && cost[r][j] < 1.2 + 8 * Math.abs(f.t - tr[r].lt)) {
          tr[r].x = det[j][0]; tr[r].y = det[j][1]; tr[r].lt = f.t; ok.add(r);
        }
      });
    }
    tr.forEach((k, r) => { pos[r][2 * i] = k.x; pos[r][2 * i + 1] = k.y; hid[r][i] = ok.has(r) ? 0 : 1; }); // 가려지면 마지막 위치 유지
  }
}

/** 고정 인원 추적. 인원이 다 보이는 첫 장면에서 시작해 앞뒤로 따라간다. */
export function trackPlayers(frames, counts) {
  const N = frames.length;
  const start = frames.findIndex(f => counts.every((c, t) => f.players[t].length === c));
  if (start < 0) throw new Error('선수가 모두 보이는 장면이 없어요. 팀 색을 다시 골라 주세요.');
  const players = [];
  counts.forEach((c, team) => {
    const init = [...frames[start].players[team]].sort((a, b) => a[0] - b[0]);
    const pos = init.map(() => new Float32Array(2 * N)), hid = init.map(() => new Uint8Array(N));
    runTeam(frames, team, init, Array.from({ length: N - start }, (_, k) => start + k), pos, hid);
    runTeam(frames, team, init, Array.from({ length: start + 1 }, (_, k) => start - k), pos, hid);
    init.forEach((_, r) => players.push({ team, pos: pos[r], hidden: hid[r] }));
  });
  return players;
}

// 들쭉날쭉한 샘플 시각 → 고정 간격(dt) 격자로 선형 보간
export function resample(times, pos, dt) {
  const T = times[times.length - 1], n = Math.floor(T / dt) + 1, out = new Float32Array(2 * n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (k < times.length - 2 && times[k + 1] < t) k++;
    const a = Math.min(1, Math.max(0, (t - times[k]) / ((times[k + 1] ?? times[k] + 1) - times[k] || 1)));
    for (const d of [0, 1]) {
      const p0 = pos[2 * k + d], p1 = pos[2 * Math.min(k + 1, times.length - 1) + d];
      out[2 * i + d] = Number.isNaN(p0) || Number.isNaN(p1) ? (Number.isNaN(p0) ? p1 : p0) : p0 + (p1 - p0) * a;
    }
  }
  return out;
}
export function resampleFlags(times, flags, dt) {
  const n = Math.floor(times[times.length - 1] / dt) + 1, out = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) { while (k < times.length - 1 && times[k + 1] <= i * dt) k++; out[i] = flags[k]; }
  return out;
}

const movAvg = (a, k) => a.length < k ? [] : a.slice(0, a.length - k + 1).map((_, i) => { let s = 0; for (let j = 0; j < k; j++) s += a[i + j]; return s / k; });

/** pos: 격자 위 [x0,y0,x1,y1,...] m, hidden: 가려짐 표시 */
export function playerStats(pos, hidden, dt, sprintMs = 4) {
  const n = pos.length / 2;
  if (n < 12) return { distance: 0, topSpeed: 0, sprints: 0, speed: [] };
  const xs = Array.from({ length: n }, (_, i) => pos[2 * i]), ys = Array.from({ length: n }, (_, i) => pos[2 * i + 1]);
  const sx = movAvg(xs, 5), sy = movAvg(ys, 5); // 0.5초 평균으로 위치 떨림 제거
  const hidW = movAvg(Array.from(hidden), 6);
  const v = [];
  for (let i = 0; i < sx.length - 1; i++) {
    let s = Math.hypot(sx[i + 1] - sx[i], sy[i + 1] - sy[i]) / dt;
    if (s > 9 || hidW[i] > 0) s = 0; // 순간이동(추적 튐)·가려졌던 구간은 빼기
    v.push(s);
  }
  let sprints = 0;
  v.forEach((s, i) => { if (s > sprintMs && !(i && v[i - 1] > sprintMs)) sprints++; });
  const v1 = movAvg(v, Math.round(1 / dt)); // 최고 속도는 1초 평균
  return { distance: v.reduce((a, b) => a + b, 0) * dt, topSpeed: v1.length ? Math.max(...v1) : 0, sprints, speed: v };
}

/** 공 추적: 장면마다 공 후보 중 하나 또는 "안 보임"을 고르되, 영상 전체에서 비용이 가장 낮은 경로를 고른다(비터비).
 * 후보 [x, y, 혼자 떨어짐(1/0)]. 아이 몸에 붙은 흰 점(양말·신발·발밑 공)은 비싸게,
 * 멀리 순간이동은 못 하게 해서, 공이 아이에게 가면 그 아이 발밑을 따라가게 된다. */
export function trackBall(frames) {
  const N = frames.length, MISS = 1.2, REACQ = 0.8;
  const emis = c => (c[2] ? 0 : 1.1);
  let prev = [{ cost: 0, back: -1, pos: null }]; // 0번 상태 = 안 보임
  const hist = [];
  for (let i = 0; i < N; i++) {
    const f = frames[i], dt = i ? f.t - frames[i - 1].t : 0.1;
    const cur = [{ cost: Infinity, back: 0, pos: null }, ...f.ball.map(p => ({ cost: Infinity, back: 0, pos: p }))];
    cur.forEach((c, j) => {
      const e = j ? emis(c.pos) : MISS;
      prev.forEach((p, k) => {
        let tr;
        if (!j) tr = 0;
        else if (!p.pos) tr = REACQ;
        else { const d = Math.hypot(p.pos[0] - c.pos[0], p.pos[1] - c.pos[1]); tr = d > 0.5 + 20 * dt ? Infinity : 0.3 * d; }
        if (p.cost + tr + e < c.cost) { c.cost = p.cost + tr + e; c.back = k; }
      });
    });
    hist.push(cur); prev = cur;
  }
  const out = new Float32Array(N * 2).fill(NaN);
  let k = prev.reduce((b, c, j) => (c.cost < prev[b].cost ? j : b), 0);
  for (let i = N - 1; i >= 0; i--) {
    const c = hist[i][k];
    if (c.pos) { out[2 * i] = c.pos[0]; out[2 * i + 1] = c.pos[1]; }
    k = c.back;
  }
  // 1초 이하로 안 보인 구간만 앞뒤를 잇는다(길게 이으면 빈 땅에 공을 그리게 됨)
  let last = -1;
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(out[2 * i])) continue;
    if (last >= 0 && i - last > 1 && frames[i].t - frames[last].t <= 1) {
      for (let j = last + 1; j < i; j++) {
        const a = (frames[j].t - frames[last].t) / (frames[i].t - frames[last].t);
        for (const d of [0, 1]) out[2 * j + d] = out[2 * last + d] + (out[2 * i + d] - out[2 * last + d]) * a;
      }
    }
    last = i;
  }
  return out;
}

/** 공 소유와 패스. ball: 격자 위 [x,y](NaN=모름), players: [{team, pos}] */
export function possession(ball, players, dt, near = 1.0) {
  const n = ball.length / 2, owner = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const bx = ball[2 * i], by = ball[2 * i + 1];
    if (Number.isNaN(bx)) continue;
    let bd = near, b = -1;
    players.forEach((p, k) => { const d = Math.hypot(p.pos[2 * i] - bx, p.pos[2 * i + 1] - by); if (d < bd) { bd = d; b = k; } });
    owner[i] = b;
  }
  const segs = []; // 0.2초 이상 공을 가진 구간
  for (let i = 0; i < n;) {
    let j = i; while (j < n && owner[j] === owner[i]) j++;
    if (owner[i] >= 0 && j - i >= 2) segs.push({ p: owner[i], s: i, e: j });
    i = j;
  }
  const merged = [];
  for (const g of segs) { const l = merged[merged.length - 1]; if (l && l.p === g.p) l.e = g.e; else merged.push({ ...g }); }
  const passes = [], turnovers = [];
  for (let k = 1; k < merged.length; k++) {
    const a = merged[k - 1], b = merged[k];
    if ((b.s - a.e) * dt > 4) continue; // 너무 오래 끊겼으면 이어진 플레이로 안 봄
    (players[a.p].team === players[b.p].team ? passes : turnovers).push({ from: a.p, to: b.p, t: +(a.e * dt).toFixed(1) });
  }
  const time = players.map((_, k) => merged.filter(g => g.p === k).reduce((s, g) => s + (g.e - g.s) * dt, 0));
  return { passes, turnovers, time, touches: players.map((_, k) => merged.filter(g => g.p === k).length), segments: merged };
}
