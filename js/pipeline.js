// 설정(코트 모서리·팀 색) → 검출 설정, 그리고 검출 결과 → 최종 분석 결과.
import { homography, applyH, courtMask } from './vision.js';
import { rosterCounts, trackPlayers, trackBall, resample, resampleFlags, playerStats, possession } from './track.js';

export const DT = 0.1; // 결과는 0.1초 간격

/** cfg: { width, height, corners: [[x,y] 좌상,우상,우하,좌하] (분석 해상도 px), court: [길이, 폭] m, teams: [{name, color, hue, sat}] } */
export function setup(cfg, bg) {
  const [L, W] = cfg.court, w = cfg.width, h = cfg.height;
  const Hm = homography(cfg.corners, [[0, 0], [L, 0], [L, W], [0, W]]);
  const Hp = homography([[0, 0], [L, 0], [L, W], [0, W]], cfg.corners);
  const [ax, ay] = applyH(Hp, L / 2, W / 2), [bx, by] = applyH(Hp, L / 2 + 1, W / 2);
  const ppm = Math.hypot(bx - ax, by - ay); // 코트 가운데에서 1m가 몇 px인지
  const ballA = Math.PI * (0.1 * ppm) ** 2; // 공 지름 약 20cm
  const det = {
    bg, w, h, roi: courtMask(Hm, w, h, L, W, 1.5), thr: 40,
    openR: Math.max(1, Math.round(0.04 * ppm)), joinR: Math.max(2, Math.round(0.15 * ppm)),
    minPx: Math.max(15, 0.1 * ppm * ppm), teams: cfg.teams.map(teamGate),
    ball: { minA: Math.max(4, 0.3 * ballA), maxA: 6 * ballA }, // 압축 영상에선 공이 번져서 커 보임
  };
  const m = list => list.map(([x, y, ...rest]) => [...applyH(Hm, x, y), ...rest]);
  return { ppm, det, Hm, Hp, toMeters: d => ({ players: d.players.map(m), ball: m(d.ball) }) };
}

// 팀 색 판정에 쓰는 값. 중심(mid)이 없으면 범위 가운데로
export const teamGate = t => ({ hue: t.hue, sat: t.sat, mid: t.mid ?? [t.hue[0] <= t.hue[1] ? (t.hue[0] + t.hue[1]) / 2 : ((t.hue[0] + t.hue[1] + 360) / 2) % 360, (t.sat[0] + t.sat[1]) / 2] });

const r2 = a => Array.from(a, v => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));

/** dets: [{ t, players, ball }] (m 좌표) → 저장·화면용 결과 (JSON으로 바로 저장 가능) */
export function analyzeFrames(dets, cfg) {
  const counts = rosterCounts(dets, cfg.teams.length).map((c, t) => cfg.teams[t].count || c); // 선생님이 적은 인원이 있으면 그걸로
  const tracked = trackPlayers(dets, counts);
  const times = dets.map(d => d.t);
  const ballRaw = trackBall(dets);
  const players = tracked.map(p => ({ team: p.team, pos: resample(times, p.pos, DT), hidden: resampleFlags(times, p.hidden, DT) }));
  const ball = resample(times, ballRaw, DT);
  const pz = possession(ball, players, DT);
  const num = {};
  const out = players.map((p, id) => {
    num[p.team] = (num[p.team] || 0) + 1;
    const s = playerStats(p.pos, p.hidden, DT);
    return {
      id, team: p.team, label: `${cfg.teams[p.team].name} ${num[p.team]}`,
      distance: s.distance, topSpeed: s.topSpeed, sprints: s.sprints,
      possession: pz.time[id], touches: pz.touches[id],
      passes: pz.passes.filter(x => x.from === id).length, received: pz.passes.filter(x => x.to === id).length,
      lost: pz.turnovers.filter(x => x.from === id).length,
      path: r2(p.pos), hidden: Array.from(p.hidden),
    };
  });
  let seen = 0; for (let i = 0; i < ball.length; i += 2) if (!Number.isNaN(ball[i])) seen++;
  return {
    dt: DT, court: cfg.court, teams: cfg.teams.map(({ name, color }) => ({ name, color })), counts,
    duration: times[times.length - 1], players: out, ball: r2(ball), passes: pz.passes, turnovers: pz.turnovers,
    hiddenRate: out.reduce((a, p) => a + p.hidden.reduce((x, y) => x + y, 0) / p.hidden.length, 0) / out.length,
    ballSeen: seen / (ball.length / 2),
    video: { width: cfg.width, height: cfg.height, corners: cfg.corners },
  };
}
