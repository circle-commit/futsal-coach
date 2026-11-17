// 설정(코트 모서리·팀 색) → 검출 설정, 그리고 검출 결과 → 최종 분석 결과.
import { homography, applyH, courtMask } from './vision.js';
import { rosterCounts, trackPlayers, trackBall, resample, resampleFlags, inPlayFrames } from './track.js';
import * as trackApi from './track.js'; // ballSize는 새로 들어온 것: 배포 직후 옛 track.js가 캐시에 남은 탭·워커에서도 모듈 오류 없이 열리게 이름공간으로 읽는다 (없으면 예전 공 고르기)
import { fillStats } from './stats.js'; // 통계: 검수 다시 계산(review.recomputeStats)과 같은 함수. 새 파일이라 이름으로 가져와도 캐시 섞임에 안전

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
  const m = list => list.map(([x, y, ...rest]) => [...applyH(Hm, x, y), ...rest]); // 셋째 이후 값(공 혼자·넓이 px 등)은 그대로
  // v2 검출(검출 버전 4)의 나누기 후보 split·색 없는 덩어리 uncol도 m로 (넓이 px·kidFg는 그대로). v1은 예전과 같은 모양
  const toMeters = d => ({ players: d.players.map(m), ball: m(d.ball), ...(d.split ? { split: d.split.map(([t, j, parts]) => [t, j, m(parts)]) } : {}),
    ...(d.uncol ? { uncol: m(d.uncol), kidFg: d.kidFg } : {}) });
  return { ppm, det, Hm, Hp, toMeters };
}

/** 코트 (X,Y)m 자리에서 1m²가 분석 화면에서 몇 px²인지 (코트 → 화면 호모그래피의 야코비안, 0.1m 차분). cfg.corners와 같은 분석 해상도 기준
 * (공 크기 비용: 그 자리 공 넓이 = track.ballSize의 m² × 이 값) */
export function areaScale(cfg) {
  const [L, W] = cfg.court, Hp = homography([[0, 0], [L, 0], [L, W], [0, W]], cfg.corners);
  return (X, Y) => {
    const d = 0.1, [x0, y0] = applyH(Hp, X, Y), [x1, y1] = applyH(Hp, X + d, Y), [x2, y2] = applyH(Hp, X, Y + d);
    return Math.abs((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)) / (d * d);
  };
}

// 팀 색 판정에 쓰는 값. 중심(mid)이 없으면 범위 가운데로
export const teamGate = t => ({ hue: t.hue, sat: t.sat, mid: t.mid ?? [t.hue[0] <= t.hue[1] ? (t.hue[0] + t.hue[1]) / 2 : ((t.hue[0] + t.hue[1] + 360) / 2) % 360, (t.sat[0] + t.sat[1]) / 2] });

const r2 = a => Array.from(a, v => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));

/** 분석 방식(엔진). 기본은 v2(브라우저 분석·로컬 도구 모두). v1은 비교용으로 남김.
 * v2: 등속 예측 매칭·속도 상한·가장자리 확인·관중 뺀 인원 세기·짧은 틈 잇기·붙은 덩어리 나누기·조끼 색을 잠깐 놓친 아이 잇기 (track.js TRACK_V2),
 *     공은 영상에서 잰 공 크기에 가까운 흰 점을 고름 (track.js BALL_SIZE). 검출도 더 낸다(vision.detect의 split·uncol·kidFg·공 넓이, 검출 버전 4) */
export const ENGINES = Object.freeze(['classical-v1', 'classical-v2']);
export const DEFAULT_ENGINE = 'classical-v2';

/** dets: [{ t, players, ball }] (m 좌표) → 저장·화면용 결과 (JSON으로 바로 저장 가능). opts.engine 기본 classical-v2 */
export function analyzeFrames(dets, cfg, { engine = DEFAULT_ENGINE } = {}) {
  if (!ENGINES.includes(engine)) throw new Error(`모르는 분석 방식이에요: ${engine}`);
  // 선생님이 적은 인원이 있으면 그걸로. v2는 코트 선 밖 0.75m 넘는 검출(관중·코치)은 세지 않음
  const counts = rosterCounts(engine === 'classical-v2' ? inPlayFrames(dets, cfg.court) : dets, cfg.teams.length).map((c, t) => cfg.teams[t].count || c);
  // v2: 붙은 덩어리 나누기 후보(split)는 추적 안에서 "아이가 붙어서 하나로 보인 경우"에만 쓴다 (track.js TRACK_V2 splitNear·bigShare). 인원은 나누기 전 검출로 셈.
  //     색 없는 덩어리(uncol)도 추적 안에서 조끼 색을 잠깐 놓친 아이를 이을 때만 쓴다 (TRACK_V2 bridge…, 색으로 다시 잡혀야 남김)
  const tracked = trackPlayers(dets, counts, { engine, court: cfg.court, names: cfg.teams.map(t => t.name) }); // 이름은 오류 안내용
  const times = dets.map(d => d.t);
  // v2: 라벨 없이 이 영상의 공 넓이를 재서(공 줄 넷째 값 = 흰 점 넓이 px) 공 크기에 가까운 후보를 고름. 못 재면(점이 적음·옛 track.js) 예전처럼. v1은 예전 그대로
  const ballSize = trackApi.ballSize;
  const scale = engine === 'classical-v2' && typeof ballSize === 'function' ? areaScale(cfg) : null, am = scale ? ballSize(dets, cfg.court, scale) : null;
  const ballRaw = am ? trackBall(dets, { am, scale }) : trackBall(dets);
  const players = tracked.map(p => ({ team: p.team, pos: resample(times, p.pos, DT), hidden: resampleFlags(times, p.hidden, DT) }));
  const ball = resample(times, ballRaw, DT);
  // 저장되는 모양(0.01m 경로·공·가려짐)을 먼저 만들고, 통계는 검수 다시 계산과 같은 함수(stats.fillStats)로 그 값에서 센다
  // → 교정 안 한 결과는 다시 계산해도 같은 숫자 (통계 칸은 자리만 잡아 두고 fillStats가 채움)
  const num = {};
  const out = players.map((p, id) => {
    num[p.team] = (num[p.team] || 0) + 1;
    return {
      id, team: p.team, label: `${cfg.teams[p.team].name} ${num[p.team]}`,
      distance: 0, topSpeed: 0, sprints: 0, possession: 0, touches: 0, passes: 0, received: 0, lost: 0,
      path: r2(p.pos), hidden: Array.from(p.hidden),
    };
  });
  let seen = 0; for (let i = 0; i < ball.length; i += 2) if (!Number.isNaN(ball[i])) seen++;
  return fillStats({
    dt: DT, court: cfg.court, teams: cfg.teams.map(({ name, color }) => ({ name, color })), counts,
    duration: times[times.length - 1], players: out, ball: r2(ball), passes: [], turnovers: [], hiddenRate: 0,
    ballSeen: seen / (ball.length / 2),
    video: { width: cfg.width, height: cfg.height, corners: cfg.corners },
  });
}
