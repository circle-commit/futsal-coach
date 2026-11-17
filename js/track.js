// 프레임별 검출(m 좌표) → 선수 추적 → 활동량. 순수 함수라 node 테스트로 확인한다.
// frames: [{ t, players: [[[x,y],...] 팀별], ball: [[x,y],...] }] (+ classical-v2 검출은 split·uncol·kidFg: vision.detect 설명)

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

// ---------- classical-v2 추적: 등속 예측 매칭 + 물리 속도로 잡는 반경 상한 + 가장자리 검출 확인 ----------
// v1(runTeam)은 그대로 둔다 (브라우저 분석·예전 결과가 바뀌지 않게). 같은 입력이면 늘 같은 출력(난수·시각 없음).
export const TRACK_V2 = Object.freeze({
  vmax: 9, // 잡는 반경 상한: 마지막으로 본 자리에서 초속 9m × 지난 시간 + margin (검수 후보 순간 이동 기준과 같은 속도)
  margin: 0.8, // 검출 중심 떨림·몸 기울기 여유 (m)
  tau: 0.5, // 예측에 쓰는 속도는 0.5초 시간 상수로 줄어듦: 오래 가려지면 멀리 내다보지 않음
  alpha: 0.5, // 속도 갱신: 새로 잰 속도와 이전 속도를 반씩
  vReset: 0.3, // 이보다 오래 못 봤다가 다시 잡으면 속도는 0부터
  edge: 1.0, // 코트 선 안쪽 1m 이내·코트 밖 = 가장자리 (사이드라인 밖 사람·물체가 잘못 잡히는 곳)
  tight: 0.8, // 보이던 트랙이 가장자리 검출을 바로 잡으려면 예측 위치에서 이 거리 안이어야 함
  confirm: 3, // 가려진 트랙은 가장자리 검출이 이 장면 수만큼 이어서 맞아야 다시 잡고, 그 장면들도 채운다
  pathTol: 1.5, pathSpeed: 3, // 그 검출들은 예측 경로에서 1.5m + 초속 3m(보통 뛰는 속도) × 가려진 시간 안이어야 함 (사이드라인 밖 사람이 멀리서 낚아채지 않게)
  vHold: 0.5, // 가려진 지 0.5초까지만 예측에 속도를 다 쓰고, 1초가 되면 0으로 줄여 마지막 자리로 본다.
  //   아이는 0.5~1초면 방향을 바꾸므로 오래된 속도는 믿지 않는다 (오래 뭉쳐 있던 아이의 옛 속도가 옆 아이 검출을 끌어오던 문제)
  rosterOut: 0.75, // 팀 인원·시작 장면을 셀 때 코트 선 밖 0.75m 넘는 검출은 세지 않음: 선 밖을 따라 뛰는 아이(0.5m 안)와
  //   조끼 색이 비슷한 관중·코치(대개 선 밖 1m 넘게)의 가운데. 추적 자체는 모든 검출을 보되 가장자리 규칙을 따른다
  fillGap: 3, fillSpeed: 7, // 앞뒤로 보인 사이의 가려짐이 3장(0.3초) 이하이고 그 사이 속도가 초속 7m(아이 최고 속도 6~7m 바로 위, 순간 이동 기준 9m 아래) 이하면 직선으로 잇는다.
  //   몸이 겹쳐 잠깐 안 보인 아이도 계속 움직였으므로 (뛴 거리 계산은 가려진 장면 둘레 0.6초를 빼서 짧은 틈마다 거리가 모자랐음).
  //   더 길거나 빠른 틈은 실제 가림·번호 바뀜일 수 있어 가려짐으로 남겨 검수에서 보이게 한다
  holdMax: 2, // 다시 잡는 반경(물리 반경·예측 경로 허용)은 가려진 지 2초까지만 커진다(최대 0.8+9×2=18.8m, 경로 1.5+3×2=7.5m).
  //   그보다 오래 가려진 아이는 거리로는 누구인지 가릴 수 없고 멀리 있는 다른 사람을 잡을 위험만 커지므로, 반경 밖에서 나타나면
  //   억지로 잇지 않고 가려짐으로 남겨 검수에서 보이게 한다. 가려진 트랙은 선 밖 rosterOut 넘는 검출로는 절대 다시 잡지 않음(시작 규칙과 같게)
  // 붙은 덩어리 나누기 후보(검출 split)는 "아이가 붙어서 하나로 보인 경우"에만 쓴다 (runTeamV2):
  //   ① 그 팀이 인원보다 적게 보이고 나눠도 인원을 넘지 않으며, ② 그 덩어리를 이어 온 트랙(직전 장면에 보였고 예측 자리가 나눈 자리 하나에서
  //   splitNear 안)이 있고, ③ 그 트랙이 "혼자서도 덩어리가 큰 사람"이 아닐 때. 덩어리 크기는 팀 몸 크기(중앙값)와 비교하므로 몸 큰 사람은
  //   혼자서도 늘 후보가 나온다. 그래서 팀 전원이 따로 보인 장면(붙은 아이가 있을 수 없음)에서 그 트랙 덩어리에 후보가 나온 비율이 bigShare 이상이면
  //   몸 큰 사람으로 보고, 그 사람 덩어리는 나누지 않는다(다른 아이를 놓쳐 팀이 모자랄 때 큰 사람을 둘로 나눠 빈 번호를 채우던 문제)
  splitNear: 1.0, // 붙은 두 아이 중심은 0.75m 안(몸 반지름 0.225m×2 + 조끼 조각 묶는 거리)이라 나눈 자리는 각 아이 자리 근처. 예측 떨림 여유를 더해 1m
  bigShare: 0.25, // 혼자 보일 때 4장 중 1장 넘게 후보가 나오면 그 사람 자체가 큼 (보통 아이는 거의 0: 자세로 1.6배를 넘는 일은 드묾). 낮게 잡아 애매하면 안 나눔
  // 조끼 색을 잠깐 놓친 아이 잇기 (검출 uncol·kidFg, 검출 버전 3. runTeamV2). 트랙(매칭·다시 잡기)은 잇기 없는 v2와 똑같이 두고 "잇는 길"만 옆에서 따로 따라간다:
  //   직전 장면에 색으로 보였던 트랙을 이번 장면에 못 잡으면, 색 없는 움직임 덩어리 중 크기가 그 팀 아이 한 명 몸 넓이(kidFg 영상 중앙값)의
  //   bridgeMin~bridgeMax배이고, 예측 자리에서 bridgeTol 안이고, 모든 팀 색 검출에서 bridgeSep 밖이고, 그 장면에서 다른 아이(다른 팀 포함)가 이은 적 없는
  //   가장 가까운 덩어리로 잇는다(색으로 마지막 본 뒤 bridgeLen초까지). 트랙이 색으로 다시 잡혔을 때 그 틈이 fillGap(0.3초)보다 길고 다시 잡은 자리가
  //   이은 끝의 예측에서 bridgeTol 안이면 이은 칸을 채운다. 채울 때는 시작 치우침(첫 덩어리 − 놓치기 전 예측)과 끝 치우침(이은 끝의 예측 − 다시 잡은 자리)을
  //   시각에 따라 선형으로 빼서, 덩어리에 붙은 그림자나 옆에서 나란히 달린 어른처럼 일정하게 어긋난 만큼을 없앤다. 그 밖(끊김·0.3초 이하 틈·다른 자리에서
  //   다시 잡힘·영상 끝)엔 아무것도 바꾸지 않는다. 그래서 원래 보이던 칸·다시 잡는 시점은 잇기 없는 v2와 같고, 가려짐으로 남던 긴 틈만 채워진다
  bridgeTol: 0.6, // 덩어리 중심(몸 전체)은 조끼 중심과 조금 다르고 예측도 떨려서 몸 지름(0.45m)보다 조금 크게. 붙은 두 아이 간격(0.75m)보다는 작게
  bridgeSep: 0.5, // 색으로 보이는 사람 바로 옆 덩어리는 그 사람 몸의 색 없는 부분(팔다리·그림자)일 수 있어 안 씀 (몸 지름 0.45m 바로 위)
  bridgeLen: 1.5, // 합성 장면의 색 놓침(0.2~0.9초, escort 1.4~1.5초)이 다 들어가는 길이 (2.0초도 17장면 결과가 같고, 1.0초면 escort를 못 이음). 더 긴 놓침은 지금처럼 가려짐으로 남겨 검수에서 보이게
  bridgeMin: 0.3, bridgeMax: 2.0, // 색 놓친 아이 덩어리는 한 명 넓이의 0.14~0.80배(10~90%, 중앙 0.44: 조끼 부분이 빠짐)라 하한 0.3 (0.5면 37%만 잡힘). 2배 넘으면 여럿이 붙은 덩어리
});

const outsideOf = (d, [L, W]) => Math.max(0, -d[0], d[0] - L, -d[1], d[1] - W); // 코트 선 밖으로 나간 거리 (안이면 0)

/** 코트 가까이(선 밖 rosterOut 이내)의 검출만 남긴 장면들 (classical-v2의 인원 세기·시작 장면용) */
export function inPlayFrames(frames, court, lim = TRACK_V2.rosterOut) {
  return frames.map(f => ({ ...f, players: f.players.map(l => l.filter(d => outsideOf(d, court) <= lim)) }));
}

// 짧은 틈 메우기 (classical-v2): 위 fillGap·fillSpeed 조건이면 직선으로 잇고 보인 것으로 한다
function fillGaps(pos, hid, frames, C) {
  const N = hid.length;
  for (let k = 0; k < N;) {
    if (!hid[k]) { k++; continue; }
    let e = k; while (e + 1 < N && hid[e + 1]) e++;
    const a = k - 1, b = e + 1;
    if (a >= 0 && b < N && e - k + 1 <= C.fillGap) {
      const dt = frames[b].t - frames[a].t, d = Math.hypot(pos[2 * b] - pos[2 * a], pos[2 * b + 1] - pos[2 * a + 1]);
      if (dt > 0 && d / dt <= C.fillSpeed) {
        for (let j = k; j <= e; j++) {
          const u = (frames[j].t - frames[a].t) / dt;
          pos[2 * j] = pos[2 * a] + (pos[2 * b] - pos[2 * a]) * u; pos[2 * j + 1] = pos[2 * a + 1] + (pos[2 * b + 1] - pos[2 * a + 1]) * u; hid[j] = 0;
        }
      }
    }
    k = e + 1;
  }
}
const FAR = 1e9;

// kid: 이 팀 아이 한 명 몸 넓이(px, 0이면 잇지 않음), used: 장면마다 이미 이은 덩어리 번호 (모든 팀이 같이 씀: 한 덩어리로 두 아이를 잇지 않게)
function runTeamV2(frames, team, init, idxs, pos, hid, court, kid, used) {
  const C = TRACK_V2, [L, W] = court;
  const isEdge = d => d[0] < C.edge || d[1] < C.edge || d[0] > L - C.edge || d[1] > W - C.edge;
  // br: 잇는 길 { t0: 색으로 마지막 본 시각, x·y·vx·vy·lt·seen: 이은 끝 상태(트랙과 같은 방식으로 갱신), o1: 시작 치우침, cells: [[장면, x, y, 덩어리], …] }
  const tr = init.map(([x, y]) => ({ x, y, vx: 0, vy: 0, lt: frames[idxs[0]].t, seen: true, chain: null, br: null }));
  // 예측 이동량 = 속도 × g(가려진 시간): 처음엔 τ로 줄어들며 늘다가 vHold부터 줄어 2·vHold에서 0 (오래된 속도는 버림)
  const gOf = dt => C.tau * (1 - Math.exp(-Math.min(dt, C.vHold) / C.tau)) * Math.max(0, 1 - Math.max(0, dt - C.vHold) / C.vHold);
  const ahead = (k, t) => { const dt = Math.abs(t - k.lt), g = gOf(dt); return { x: k.x + k.vx * g, y: k.y + k.vy * g, dt }; }; // k(트랙·잇는 길)에서 시각 t를 내다본 자리
  const off = (k, t, d) => { const dt = Math.abs(t - k.lt); return [d[0] - (k.x + k.vx * dt), d[1] - (k.y + k.vy * dt)]; }; // 잇기 치우침: d − k에서 등속으로 간 자리 (한 장면이라 줄이지 않음)
  // 검출 d(시각 t)로 트랙 갱신. 속도는 직전 장면에도 보였고 간격이 짧을 때만 새로 잼
  const take = (k, d, t) => {
    const dt = Math.abs(t - k.lt);
    if (k.seen && dt > 0 && dt <= C.vReset) {
      let vx = C.alpha * ((d[0] - k.x) / dt) + (1 - C.alpha) * k.vx, vy = C.alpha * ((d[1] - k.y) / dt) + (1 - C.alpha) * k.vy;
      const sp = Math.hypot(vx, vy); if (sp > C.vmax) { vx *= C.vmax / sp; vy *= C.vmax / sp; }
      k.vx = vx; k.vy = vy;
    } else { k.vx = 0; k.vy = 0; }
    k.x = d[0]; k.y = d[1]; k.lt = t;
  };
  // 몸 큰 사람 판정 근거 (이 방향으로 지나온 장면만): 팀 전원이 따로 보인 장면에서 트랙 r이 잡은 덩어리 수 / 그 덩어리에 나누기 후보가 있던 수
  const alone = tr.map(() => 0), bigN = tr.map(() => 0);
  const isBig = r => alone[r] > 0 && bigN[r] >= C.bigShare * alone[r];
  for (const i of idxs) {
    const f = frames[i], raw = f.players[team], ok = new Set(), usedDet = new Set();
    const pred = tr.map(k => ahead(k, f.t));
    const held = r => Math.min(pred[r].dt, C.holdMax); // 반경이 커지는 시간은 holdMax까지
    const reach = (k, r, d) => Math.hypot(d[0] - k.x, d[1] - k.y) <= C.margin + C.vmax * held(r);
    // 붙은 덩어리 나누기 (TRACK_V2 splitNear·bigShare 설명): 덩어리를 이어 온 보이던 트랙이 있고, 그 트랙이 몸 큰 사람이 아닐 때만 나눈 자리를 검출로 쓴다
    const cands = f.split ? f.split.filter(s => s[0] === team) : [];
    let det = raw;
    if (cands.length && raw.length < tr.length) {
      const use = new Map(); let n = raw.length;
      for (const [, j, parts] of cands) {
        const owners = tr.map((_, r) => r).filter(r => tr[r].seen && parts.some(p => Math.hypot(p[0] - pred[r].x, p[1] - pred[r].y) <= C.splitNear));
        if (!owners.length || owners.some(isBig) || n + parts.length - 1 > tr.length) continue;
        use.set(j, parts); n += parts.length - 1;
      }
      if (use.size) det = raw.flatMap((d, j) => use.get(j) ?? [d]);
    }
    if (det.length) {
      const cost = tr.map((k, r) => det.map(d => {
        if (!reach(k, r, d)) return FAR; // 물리적으로 못 가는 곳
        const c = Math.hypot(d[0] - pred[r].x, d[1] - pred[r].y);
        if (isEdge(d) && (!k.seen || c > C.tight)) return FAR; // 가장자리는 보이던 트랙이 예측 가까이일 때만 바로
        return c;
      }));
      const full = raw.length === tr.length; // 팀 전원이 따로 보임 = 나누기는 안 썼고, 붙은 아이가 있을 수 없는 장면
      assign(cost).forEach((j, r) => {
        if (j >= 0 && cost[r][j] < FAR) {
          take(tr[r], det[j], f.t); tr[r].chain = null; ok.add(r); usedDet.add(j);
          if (full) { alone[r]++; if (cands.some(s => s[1] === j)) bigN[r]++; }
        }
      });
    }
    // 못 잡은 트랙: 남은 가장자리 검출이 여러 장면 이어서 맞을 때만 다시 잡는다 (비용·번호 순으로 하나씩, 결정적)
    const cand = [];
    tr.forEach((k, r) => {
      if (ok.has(r)) return;
      const last = k.chain?.[k.chain.length - 1];
      det.forEach((d, j) => {
        if (usedDet.has(j) || !isEdge(d) || outsideOf(d, court) > C.rosterOut || !reach(k, r, d)) return; // 선 밖 멀리(관중·코치)로는 다시 잡지 않음
        const c = Math.hypot(d[0] - pred[r].x, d[1] - pred[r].y);
        if (c > C.pathTol + C.pathSpeed * held(r)) return; // 예측 경로와 안 맞음
        const cont = !!last && Math.hypot(d[0] - last.d[0], d[1] - last.d[1]) <= C.margin + C.vmax * Math.abs(f.t - last.t);
        cand.push({ r, j, cont, c });
      });
    });
    cand.sort((a, b) => b.cont - a.cont || a.c - b.c || a.r - b.r || a.j - b.j); // 이어지는 줄을 먼저
    const got = new Set();
    for (const { r, j, cont } of cand) {
      if (got.has(r) || usedDet.has(j)) continue;
      got.add(r); usedDet.add(j);
      const k = tr[r], d = det[j], chain = cont ? [...k.chain, { i, t: f.t, d }] : [{ i, t: f.t, d }];
      if (chain.length < C.confirm) { k.chain = chain; continue; }
      for (const e of chain.slice(0, -1)) { pos[r][2 * e.i] = e.d[0]; pos[r][2 * e.i + 1] = e.d[1]; hid[r][e.i] = 0; } // 확인된 장면들도 채움
      const c0 = chain[0], dt = Math.abs(f.t - c0.t);
      k.x = d[0]; k.y = d[1]; k.lt = f.t; k.chain = null; ok.add(r);
      let vx = dt > 0 ? (d[0] - c0.d[0]) / dt : 0, vy = dt > 0 ? (d[1] - c0.d[1]) / dt : 0;
      const sp = Math.hypot(vx, vy); if (sp > C.vmax) { vx *= C.vmax / sp; vy *= C.vmax / sp; }
      k.vx = vx; k.vy = vy;
    }
    // 조끼 색을 잠깐 놓친 아이 잇기 (TRACK_V2 bridge… 설명): 막 놓쳤거나 잇는 중인 트랙 → 맞는 덩어리 중 가까운 것부터 하나씩. 트랙 상태는 그대로 둔다
    const bridged = new Set();
    if (f.uncol && kid > 0) {
      const colored = f.players.flat(), bc = [];
      tr.forEach((k, r) => {
        if (ok.has(r) || got.has(r) || !(k.br || k.seen) || Math.abs(f.t - (k.br ? k.br.t0 : k.lt)) > C.bridgeLen + 1e-9) return;
        const p = k.br ? ahead(k.br, f.t) : pred[r]; // 잇는 중이면 이은 끝에서, 막 놓쳤으면 트랙에서 내다본 자리
        f.uncol.forEach((u, q) => {
          const z = u[2] / kid, c = Math.hypot(u[0] - p.x, u[1] - p.y);
          if (!used[i]?.has(q) && z >= C.bridgeMin && z <= C.bridgeMax && c <= C.bridgeTol && colored.every(d => Math.hypot(d[0] - u[0], d[1] - u[1]) >= C.bridgeSep)) bc.push({ r, q, c });
        });
      });
      bc.sort((a, b) => a.c - b.c || a.r - b.r || a.q - b.q);
      const taken = new Set();
      for (const { r, q } of bc) {
        if (taken.has(q) || bridged.has(r)) continue;
        taken.add(q); bridged.add(r);
        const k = tr[r], u = f.uncol[q];
        k.br ??= { t0: k.lt, x: k.x, y: k.y, vx: k.vx, vy: k.vy, lt: k.lt, seen: true, o1: off(k, f.t, u), cells: [] }; // 시작 치우침 = 첫 덩어리 − 놓치기 전 트랙에서 간 자리
        take(k.br, u, f.t); k.br.cells.push([i, u[0], u[1], q]);
      }
    }
    tr.forEach((k, r) => {
      if (!ok.has(r) && !got.has(r)) k.chain = null; // 이어지지 않으면 처음부터
      if (k.br && ok.has(r)) { // 색으로 다시 잡음: 틈이 fillGap보다 길고(짧은 틈은 예전처럼 직선 잇기) 다시 잡은 자리가 이은 끝의 예측 가까이면 이은 칸을 채움
        const b = k.br, e = ahead(b, f.t);
        if (b.cells.length > C.fillGap && Math.hypot(k.x - e.x, k.y - e.y) <= C.bridgeTol) {
          const o2 = off(b, f.t, [k.x, k.y]).map(v => -v), t1 = frames[b.cells[0][0]].t; // 끝 치우침 = 이은 끝에서 간 자리 − 다시 잡은 자리
          for (const [c, x, y, q] of b.cells) {
            const a = (frames[c].t - t1) / (f.t - t1); // 첫 이은 칸 0 → 다시 잡은 장면 1 (시각 비례)
            pos[r][2 * c] = x - (b.o1[0] + (o2[0] - b.o1[0]) * a); pos[r][2 * c + 1] = y - (b.o1[1] + (o2[1] - b.o1[1]) * a); hid[r][c] = 0;
            (used[c] ??= new Set()).add(q);
          }
        }
      }
      if (k.br && !bridged.has(r)) k.br = null; // 다시 잡힘(채웠든 안 채웠든)·끊김(맞는 덩어리 없음·bridgeLen 넘음·가장자리 다시 잡기 중): 잇는 길은 버림
      pos[r][2 * i] = k.x; pos[r][2 * i + 1] = k.y; hid[r][i] = ok.has(r) ? 0 : 1; k.seen = ok.has(r); // 가려지면 마지막 위치 유지
    });
  }
}

/** 고정 인원 추적. 인원이 다 보이는 첫 장면에서 시작해 앞뒤로 따라간다.
 * opts.engine: 'classical-v1'(기본, 마지막 위치로 매칭) 또는 'classical-v2'(등속 예측·속도 상한·가장자리 확인·나누기·색 놓친 아이 잇기, opts.court [L,W] 필요) */
export function trackPlayers(frames, counts, { engine = 'classical-v1', court, names } = {}) {
  const N = frames.length, v2 = engine === 'classical-v2';
  if (v2 && !(Array.isArray(court) && court[0] > 0 && court[1] > 0)) throw new Error('classical-v2 추적에는 코트 크기가 필요해요');
  if (!v2 && engine !== 'classical-v1') throw new Error(`모르는 분석 방식이에요: ${engine}`);
  const sorted = list => [...list].sort((a, b) => a[0] - b[0]);
  let starts; // 팀마다 { s: 시작 장면, init: 처음 자리 }
  if (v2) {
    // 시작 장면·처음 자리는 코트 가까이(선 밖 rosterOut 이내) 검출로만: 관중·코치로는 절대 트랙을 시작하지 않는다.
    // 모든 팀이 한꺼번에 다 보이는 장면이 있으면 거기서(예전 v2와 같은 결과), 없으면 팀은 따로 추적되므로 팀마다 그 팀 인원이 다 보이는 첫 장면에서.
    const ref = inPlayFrames(frames, court), all = ref.findIndex(f => counts.every((c, t) => f.players[t].length === c));
    starts = counts.map((c, t) => {
      const s = all >= 0 ? all : ref.findIndex(f => f.players[t].length === c);
      if (s < 0) throw new Error(`'${names?.[t] ?? `${t + 1}번째`}' 팀 아이 ${c}명이 코트 안에서 한꺼번에 보이는 장면이 없어요. 새 수업 분석의 팀 색 단계에서 그 팀 인원을 실제 인원으로 직접 적어 주세요.`);
      return { s, init: sorted(ref[s].players[t]) };
    });
  } else {
    const start = frames.findIndex(f => counts.every((c, t) => f.players[t].length === c));
    if (start < 0) throw new Error('선수가 모두 보이는 장면이 없어요. 팀 색을 다시 골라 주세요.');
    starts = counts.map((_, t) => ({ s: start, init: sorted(frames[start].players[t]) }));
  }
  // v2: 팀마다 아이 한 명 몸 넓이 = 팀 검출이 하나만 든 움직임 덩어리 넓이(검출 kidFg)의 영상 전체 중앙값. 기록이 없으면(예전 검출) 0 = 잇지 않음
  const kid = v2 ? counts.map((_, t) => { const a = frames.flatMap(f => f.kidFg?.[t] ?? []).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; }) : null;
  const used = []; // v2 잇기: 장면마다 이미 이은 덩어리 번호 (팀 순서대로 돌므로 앞 팀이 이은 덩어리는 뒤 팀이 쓰지 않음)
  const run = v2 ? (fr, team, init, idxs, pos, hid) => runTeamV2(fr, team, init, idxs, pos, hid, court, kid[team], used) : runTeam;
  const players = [];
  counts.forEach((c, team) => {
    const { s: start, init } = starts[team];
    const pos = init.map(() => new Float32Array(2 * N)), hid = init.map(() => new Uint8Array(N));
    run(frames, team, init, Array.from({ length: N - start }, (_, k) => start + k), pos, hid);
    run(frames, team, init, Array.from({ length: start + 1 }, (_, k) => start - k), pos, hid);
    if (v2) init.forEach((_, r) => fillGaps(pos[r], hid[r], frames, TRACK_V2));
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
  // 장면 수만큼 긴 배열이라 Math.max(...v1)로 펼치지 않는다 (긴 영상에서 인자 수 한계로 RangeError). 값은 같다
  return { distance: v.reduce((a, b) => a + b, 0) * dt, topSpeed: v1.length ? v1.reduce((m, x) => Math.max(m, x), -Infinity) : 0, sprints, speed: v };
}

// 공 크기 비용 (classical-v2, 검출 버전 4: v2 공 후보 줄 넷째 값 = 흰 점 넓이 px).
// 실제 영상의 공 흰 점은 번짐·압축 때문에 지름 20cm 이론 넓이의 3.5배쯤으로 보이고(합성은 0.9배), 영상마다 다르다 → 라벨 없이 영상에서 잰다 (ballSize).
// w·tol: 그 자리 공 넓이의 ±50%(|ln 비| < ln 1.5) 안이면 비용을 덜고 밖이면 더함. 공 정답 개발용(t < 150초)으로 정하고 시험용으로 한 번 확인한 값 (2026-11-17)
// minLen·maxStep·maxAcc·minSpeed·minPts: ballSize 길 잇기 (5장 이상, 한 걸음 2.5m 안, 앞 걸음과의 차이 1m 안, 초속 3m 넘는 걸음, 점 10개 이상)
export const BALL_SIZE = Object.freeze({ w: 1.5, tol: Math.log(1.5), minLen: 5, maxStep: 2.5, maxAcc: 1.0, minSpeed: 3, minPts: 10 });

/** 라벨 없이 이 영상의 공 넓이(m²) 재기. frames: [{ t, ball: [[x, y, 혼자 1/0, 넓이px], …] }], scale(X, Y) = 코트 (X,Y)m 자리의 화면 px²/m².
 * 혼자 떨어진 코트 안 공 후보를 장면마다 이어 붙인 길(minLen장 이상)에서, 초속 minSpeed m 넘게 움직인 걸음이 닿은 점들의
 * 넓이 px ÷ 그 자리 px²/m² 의 중앙값. 천천히 걷는 흰 옷 어른·멈춘 흰 점은 빠지고 차인 공이 남는다. 점이 minPts개 미만이면 null.
 * 걸음 속도는 실제 장면 시각 차로 (웹 분석은 장면 간격이 정확히 0.1초가 아님). 시각 차는 1µs로 반올림해서 0.1초 간격(도구)이면 정확히 0.1 */
export function ballSize(frames, court, scale, S = BALL_SIZE) {
  const [L, W] = court, inside = b => Math.max(0, -b[0], b[0] - L, -b[1], b[1] - W) <= 0;
  let open = [], done = []; // 길: [[후보, 장면 시각], …]
  for (const f of frames) {
    const pts = f.ball.filter(b => b[2] && b[3] > 0 && inside(b)), used = new Set(), next = [];
    for (const ch of open) {
      const [last] = ch[ch.length - 1], v = ch.length > 1 ? [last[0] - ch[ch.length - 2][0][0], last[1] - ch[ch.length - 2][0][1]] : null;
      let best = -1, bd = Infinity;
      pts.forEach((q, k) => {
        if (used.has(k)) return;
        const s = Math.hypot(q[0] - last[0], q[1] - last[1]); if (s > S.maxStep) return;
        const acc = v ? Math.hypot(q[0] - last[0] - v[0], q[1] - last[1] - v[1]) : 0; if (acc > S.maxAcc) return;
        if (acc + 0.1 * s < bd) { bd = acc + 0.1 * s; best = k; }
      });
      if (best >= 0) { used.add(best); ch.push([pts[best], f.t]); next.push(ch); } else done.push(ch);
    }
    pts.forEach((q, k) => { if (!used.has(k)) next.push([[q, f.t]]); });
    open = next;
  }
  done.push(...open);
  const vals = [];
  for (const ch of done) {
    if (ch.length < S.minLen) continue;
    for (let k = 1; k < ch.length; k++) {
      const [q, t] = ch[k], [p, t0] = ch[k - 1], dt = Math.round((t - t0) * 1e6) / 1e6;
      if (dt > 0 && Math.hypot(q[0] - p[0], q[1] - p[1]) / dt >= S.minSpeed) vals.push(q[3] / scale(q[0], q[1]));
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length >= S.minPts ? vals[Math.min(vals.length - 1, Math.floor(0.5 * vals.length))] : null;
}

/** 공 추적: 장면마다 공 후보 중 하나 또는 "안 보임"을 고르되, 영상 전체에서 비용이 가장 낮은 경로를 고른다(비터비).
 * 후보 [x, y, 혼자 떨어짐(1/0)(, 넓이px)]. 아이 몸에 붙은 흰 점(양말·신발·발밑 공)은 비싸게,
 * 멀리 순간이동은 못 하게 해서, 공이 아이에게 가면 그 아이 발밑을 따라가게 된다.
 * size = { am: ballSize 결과(m²), scale(X, Y): px²/m² } (classical-v2): 후보 비용에 w·(|ln(넓이 / (am·scale))| − tol)을 더해
 * 공 크기의 흰 점을 고른다 (신발 끝처럼 작은 흰 점·흰 옷처럼 큰 흰 점은 비싸짐). size가 없으면 예전과 같다 (classical-v1) */
export function trackBall(frames, size = null, S = BALL_SIZE) {
  const N = frames.length, MISS = 1.2, REACQ = 0.8;
  const emis = size
    ? c => (c[2] ? 0 : 1.1) + (c[3] > 0 ? S.w * (Math.abs(Math.log(c[3] / (size.am * size.scale(c[0], c[1])))) - S.tol) : 0)
    : c => (c[2] ? 0 : 1.1);
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
