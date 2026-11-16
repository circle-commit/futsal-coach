// 정답을 아는 합성 수업 영상 벤치마크 생성기 (classical-v1 정확도를 재는 기준).
// 장면마다 위에서 본 1280×720·30fps 영상(H.264 mp4), 정답(<장면>.truth.json), 웹 형식 작업 설정 파일(<장면>-작업.json)을 만든다.
// 엔진 코드와 독립: 코트↔화면 변환·그리기·정답 계산을 여기서 따로 한다 (작업 설정 형식 검사에만 js/analysis-file.js를 씀).
//
// 사용:
//   node tools/bench/synth.mjs [--out bench-out] [--seed 1] [--scenes cross,cluster,contact,sprint,pass] [--no-video] [--analyze]
//   --analyze  만든 뒤 장면마다 node tools/analyze.mjs로 <장면>-결과.json까지 만든다 (걸린 시간은 <out>/bench-run.json)
//   --engine classical-v2  분석 방식을 CLI에 넘기고 결과를 <장면>-결과-v2.json으로 (--no-video와 함께 쓰면 만든 영상을 다시 씀).
//              생략하면 기준인 classical-v1을 명시해서 넘기고 <장면>-결과.json으로 (CLI 기본값과 상관없음)
//   평가: node tools/bench/eval.mjs <out>
//
// 장면 (각 20초, 3팀 × 3명, 공 1개):
//   cross   같은 팀 둘이 스쳐 지나감 (중심 사이 0.6m, 0.3m)
//   cluster 셋이 뭉쳐 붙어 서 있음 (같은 팀 셋, 다른 팀 셋)
//   contact 다른 팀끼리 몸이 닿음 (몸싸움, 나란히 달림)
//   sprint  질주 (최고 초속 7m 두 번, 6m, 4.5m)
//   pass    발밑 드리블·패스·가로채기, 발밑에 공을 숨긴 1초
//   spectators 코트 밖 1~1.5m에서 조끼와 비슷한 색 옷을 입은 관중 3명이 움직임 (선수 아님)
//   edge    사이드라인 안쪽 0.3m·밖 0.25~0.3m, 끝줄 밖 0.25m를 따라 달리는 아이
//   colorloss 조끼 색이 0.2~0.9초씩 안 잡힘 (그늘·몸 돌림 흉내: 조끼가 회색에 가깝게 보임)
//   reappear 2.5~3초 동안 조끼 색이 안 잡혔다가 같은 팀 아이 옆(약 0.7m)에서 다시 나타남
//   bigkid  (추가 장면, 기본 실행엔 안 들어감) 파랑 3번이 몸 넓이 1.9배(같은 조끼를 입은 코치·큰 아이)이고, 파랑 2번은 4~10초 동안
//           조끼 색이 안 잡힘 = 팀 인원이 모자란 동안 몸 큰 사람이 둘로 나뉘어 빈 번호를 채우는지(덩어리 나누기 위험)
//   bigkid-early  (추가 장면) bigkid와 같지만 파랑 2번 색 놓침이 처음부터(0~6초): 팀이 처음부터 모자라 큰 사람 판정 근거가 적을 때
//   <장면>-clutter  cross·pass·colorloss·reappear에 잡동사니를 얹음: 아이·어른 그림자, 조끼 없는 무채색 옷 어른 5명(코트 안 1·밖 4),
//           흰 신발·코트 밖 예비 공·반짝이는 흰 점, 압축 잡티 블록(라인 근처 절반). 색 없는 움직이는 덩어리(60px 이상)가 실제 샘플(평균 약 19)과 비슷하게
// 정답(truth.json): 0.1초마다 아이별 위치(m)·공 위치·공 보임(몸에 가려지면 0)·공 가진 아이(-1 없음),
//   패스·뺏김(공이 떠난 시각), 장면 이벤트 구간, 아이별 색 놓침 구간(loss), 선수가 아닌 사람(extras)의 위치. 영상의 30fps 장면 중 0.1초 격자(3장마다)가 정답 시각과 정확히 같다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnalysisJob } from '../../js/analysis-file.js';

export const DT = 0.1, FPS = 30, DUR = 20, W = 1280, H = 720, COURT = [35, 13.7];
export const FRAMES = Math.round(DUR / DT); // 정답 칸 수 (0, 0.1, …, 19.9초)
// 샘플 설정과 비슷한 코트 자리 (약 33px/m, 왼쪽 아래가 살짝 안쪽 = 약한 원근)
export const CORNERS = [[104, 168], [1256, 168], [1256, 616], [106.7, 616]];
export const BODY_R = 0.225, HEAD_R = 0.08, BALL_R = 0.1;
const FOOT = BODY_R + BALL_R + 0.01; // 발밑 드리블: 공이 몸에 닿는 거리
const UNDER = 0.12; // 발밑에 숨긴 공: 몸 아래 (위에서 안 보임)
// 조끼 색: samples/sample.config.json의 팀 색 범위 안 (실제 샘플 설정을 참고해 숫자로 옮겨 둠)
export const TEAMS = [
  { name: '파랑', color: '#1f8fe0', rgb: [31, 143, 224], hue: [184, 220], sat: [130, 255] },
  { name: '보라', color: '#8a6fc9', rgb: [138, 111, 201], hue: [222, 270], sat: [60, 130] },
  { name: '분홍', color: '#e0367f', rgb: [224, 54, 127], hue: [280, 358], sat: [70, 255] },
];
const KID_TEAM = [0, 0, 0, 1, 1, 1, 2, 2, 2];
export const SCENES = ['cross', 'cluster', 'contact', 'sprint', 'pass', 'spectators', 'edge', 'colorloss', 'reappear'];
// 잡동사니를 얹은 장면 (B안 위험 재기): 기존 장면과 아이·공 움직임은 같고, 색 없는 움직이는 덩어리를 실제 샘플 수준으로 더한다
export const CLUTTER_SCENES = ['cross-clutter', 'pass-clutter', 'colorloss-clutter', 'reappear-clutter'];
export const ALL_SCENES = [...SCENES, ...CLUTTER_SCENES];
// 위험을 재는 추가 장면 (공식표 13장면에는 넣지 않음, --scenes로 직접 고름)
export const EXTRA_SCENES = ['bigkid', 'bigkid-early'];

// ---------- 움직임 ----------
// 키프레임 [t, x, y, vx?, vy?] 사이를 3차 에르미트로 잇는다 (위치·속도 연속). 속도를 안 주면 앞뒤로 정하고 처음·끝은 0
function keys(list) {
  const k = list.map(([t, x, y, vx, vy]) => ({ t, x, y, vx, vy }));
  k.forEach((p, i) => {
    if (p.vx !== undefined) return;
    if (i === 0 || i === k.length - 1) { p.vx = 0; p.vy = 0; return; }
    const a = k[i - 1], b = k[i + 1];
    p.vx = (b.x - a.x) / (b.t - a.t); p.vy = (b.y - a.y) / (b.t - a.t);
  });
  return t => {
    if (t <= k[0].t) return [k[0].x, k[0].y];
    const z = k[k.length - 1]; if (t >= z.t) return [z.x, z.y];
    let i = 0; while (t > k[i + 1].t) i++;
    const a = k[i], b = k[i + 1], T = b.t - a.t, s = (t - a.t) / T, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    return [h00 * a.x + h10 * T * a.vx + h01 * b.x + h11 * T * b.vx, h00 * a.y + h10 * T * a.vy + h01 * b.y + h11 * T * b.vy];
  };
}
const wander = (cx, cy, ax, ay, wx, wy, ph) => t => [cx + ax * Math.sin(wx * t + ph), cy + ay * Math.cos(wy * t + ph)];
// 몸싸움 흔들림: [t0,t1] 안에서만 x로 ±amp (양 끝 0.3초에 부드럽게 켜고 끔)
const jostle = (f, t0, t1, amp, sign) => t => {
  const [x, y] = f(t); if (t <= t0 || t >= t1) return [x, y];
  const e = Math.min(1, (t - t0) / 0.3, (t1 - t) / 0.3), env = e * e * (3 - 2 * e);
  return [x + sign * amp * env * Math.sin(2 * Math.PI * 1.5 * (t - t0)), y];
};

// 코트 가장자리에서 1.5m 넘게 떨어져 노는 9명 (관중·색 놓침 장면 공용, ph로 위상만 바꿈)
const INNER = ph => [
  wander(8, 4.5, 2, 1.2, 0.5, 0.6, 0.3 + ph), wander(12, 9.5, 2, 1.2, 0.6, 0.5, 1.1 + ph), wander(20, 6.5, 2, 1.5, 0.5, 0.7, 2.0 + ph),
  wander(26, 4, 2, 1.2, 0.6, 0.5, 0.7 + ph), wander(29, 9.5, 2, 1.2, 0.5, 0.6, 1.6 + ph), wander(5, 10, 1.5, 1, 0.6, 0.5, 2.6 + ph),
  wander(16, 2.8, 2, 0.8, 0.5, 0.7, 1.3 + ph), wander(21, 11.2, 2, 0.8, 0.6, 0.5, 0.4 + ph), wander(32.5, 5.5, 0.8, 1.5, 0.5, 0.6, 2.2 + ph),
];
// 장면: motions[9](t → [x, y] m), ball(공 가진 순서: { kid, t0, t1, under?: [a, b] }, 사이는 날아감), events
const SCENE_DEFS = {
  cross: {
    title: '같은 팀 둘이 스쳐 지나감 (0.6m, 0.3m)',
    motions: [
      keys([[0, 9, 4.2, 0, 0], [4, 9, 5.0, 0, 0], [8, 19, 5.0, 0, 0], [11, 19, 5.3, 0, 0], [15, 9, 5.3, 0, 0], [20, 8, 3.8, 0, 0]]),
      keys([[0, 19, 6.4, 0, 0], [4, 19, 5.6, 0, 0], [8, 9, 5.6, 0, 0], [11, 9, 5.0, 0, 0], [15, 19, 5.0, 0, 0], [20, 20, 6.6, 0, 0]]),
      wander(28, 11.5, 2, 1, 0.5, 0.7, 0.3),
      wander(5, 11, 2, 1.2, 0.6, 0.5, 1.0), wander(15, 11.2, 2.5, 1, 0.5, 0.6, 2.0), wander(22, 11, 2, 1.2, 0.7, 0.5, 0.5),
      wander(26, 3, 1.5, 1.2, 0.5, 0.6, 0.2), wander(31, 5.5, 1.5, 1.2, 0.6, 0.5, 1.4), wander(29, 8.8, 1.2, 0.9, 0.5, 0.7, 2.2),
    ],
    ball: [{ kid: 6, t0: 0, t1: 3 }, { kid: 7, t0: 3.6, t1: 6.5 }, { kid: 8, t0: 7.1, t1: 10 }, { kid: 6, t0: 10.7, t1: 13.5 }, { kid: 7, t0: 14.1, t1: 16.8 }, { kid: 8, t0: 17.4, t1: 20 }],
    events: [{ name: '같은 팀 스침 0.6m', kids: [0, 1], t0: 5, t1: 7 }, { name: '같은 팀 스침 0.3m', kids: [0, 1], t0: 12, t1: 14 }],
  },
  cluster: {
    title: '셋이 뭉쳐 붙어 서 있음 (같은 팀 셋, 다른 팀 셋)',
    motions: [
      keys([[0, 30, 11.5, 0, 0], [5, 31, 10, 0, 0], [10, 29, 11.5, 0, 0], [14.5, 25, 8.29, 0, 0], [17, 25, 8.29, 0, 0], [20, 28.5, 10.5, 0, 0]]),
      wander(6, 4, 2, 1.5, 0.5, 0.6, 0.3), wander(8, 10.5, 2, 1.2, 0.6, 0.5, 1.2),
      keys([[0, 14, 10, 0, 0], [2, 14.5, 9.5, 0, 0], [6, 17.5, 7.28, 0, 0], [10, 17.5, 7.28, 0, 0], [12.5, 14, 10.5, 0, 0], [20, 12.5, 11, 0, 0]]),
      keys([[0, 22, 9.5, 0, 0], [2, 21.5, 9, 0, 0], [6, 17.7425, 6.86, 0, 0], [10, 17.7425, 6.86, 0, 0], [12.5, 21, 9.5, 0, 0], [20, 22.5, 10.5, 0, 0]]),
      keys([[0, 18, 2.5, 0, 0], [2, 18, 3.5, 0, 0], [6, 17.2575, 6.86, 0, 0], [10, 17.2575, 6.86, 0, 0], [12, 20, 6, 0, 0], [14.5, 24.749, 7.855, 0, 0], [17, 24.749, 7.855, 0, 0], [20, 26, 5.5, 0, 0]]),
      keys([[0, 30, 3, 0, 0], [5, 31.5, 4.5, 0, 0], [10, 29.5, 3.5, 0, 0], [14.5, 25.251, 7.855, 0, 0], [17, 25.251, 7.855, 0, 0], [20, 29, 4.5, 0, 0]]),
      wander(33, 7, 1, 2, 0.4, 0.5, 0.6), wander(12, 1.8, 2, 0.8, 0.5, 0.7, 2.4),
    ],
    ball: [{ kid: 1, t0: 0, t1: 4 }, { kid: 2, t0: 4.8, t1: 8 }, { kid: 1, t0: 8.8, t1: 12 }, { kid: 8, t0: 12.9, t1: 16 }, { kid: 1, t0: 16.8, t1: 20 }],
    events: [{ name: '같은 팀 셋 뭉침', kids: [3, 4, 5], t0: 6, t1: 10 }, { name: '다른 팀 셋 뭉침', kids: [0, 5, 6], t0: 14.5, t1: 17 }],
  },
  contact: {
    title: '다른 팀끼리 몸이 닿음 (몸싸움, 나란히 달림)',
    motions: [
      wander(28, 3, 2, 1.2, 0.6, 0.5, 0.4),
      jostle(keys([[0, 8, 4, 0, 0], [3, 9, 5, 0, 0], [6, 14.79, 6.5, 0, 0], [8.5, 14.79, 6.5, 0, 0], [11, 10, 8.5, 0, 0], [20, 8, 9, 0, 0]]), 6, 8.5, 0.04, -1),
      wander(31, 10, 1.5, 1.5, 0.5, 0.6, 1.6),
      wander(25, 7, 1.5, 1.5, 0.7, 0.5, 2.1),
      keys([[0, 4, 10.5, 0, 0], [4, 6, 12, 0, 0], [8, 5, 11, 0, 0], [11.5, 8, 11, 0, 0], [17.5, 22, 11, 0, 0], [20, 23, 10.5, 0, 0]]),
      wander(5, 2.5, 1.5, 1, 0.6, 0.6, 0.9),
      wander(20, 2, 1.5, 0.8, 0.5, 0.7, 2.7),
      jostle(keys([[0, 22, 9, 0, 0], [3, 20, 8, 0, 0], [6, 15.21, 6.5, 0, 0], [8.5, 15.21, 6.5, 0, 0], [11, 20, 4.5, 0, 0], [20, 22, 4, 0, 0]]), 6, 8.5, 0.04, 1),
      keys([[0, 12, 12.6, 0, 0], [4, 10, 12.3, 0, 0], [8, 9, 12.6, 0, 0], [11.5, 8, 11.45, 0, 0], [17.5, 22, 11.45, 0, 0], [20, 23, 12.3, 0, 0]]),
    ],
    ball: [{ kid: 0, t0: 0, t1: 3 }, { kid: 2, t0: 3.8, t1: 7 }, { kid: 3, t0: 7.8, t1: 10.5 }, { kid: 0, t0: 11.3, t1: 14 }, { kid: 2, t0: 14.8, t1: 17.5 }, { kid: 0, t0: 18.3, t1: 20 }],
    events: [{ name: '다른 팀 몸싸움', kids: [1, 7], t0: 6, t1: 8.5 }, { name: '다른 팀 나란히 달림', kids: [4, 8], t0: 11.5, t1: 17.5 }],
  },
  sprint: {
    title: '질주 (최고 초속 7m 두 번, 6m, 4.5m)',
    motions: [
      // 정지→초속 7m→정지: 반쪽 거리 D를 3D/(2·7)초에 가면 속도가 넘치지 않고 가운데에서 정확히 7m/s
      keys([[0, 4, 3, 0, 0], [2, 4, 3, 0, 0], [2 + 18 / 7, 16, 3, 7, 0], [2 + 36 / 7, 28, 3, 0, 0], [11.5, 24, 4.5, 0, 0], [11.5 + 15 / 7, 14, 4.5, -7, 0], [11.5 + 30 / 7, 4, 4.5, 0, 0], [20, 5, 3.5, 0, 0]]),
      wander(6, 11, 1.5, 1, 0.5, 0.6, 0.7), wander(33, 7, 1, 1.5, 0.5, 0.5, 1.3),
      keys([[0, 9, 7.5, 0, 0], [12, 10, 7.5, 0, 0], [14, 16, 7.5, 4.5, 0], [16, 22, 7.5, 0, 0], [20, 23, 8, 0, 0]]),
      keys([[0, 30, 12.6, 0, 0], [3, 30, 12.6, 0, 0], [9, 16, 12.6, 0, 0], [20, 14, 12, 0, 0]]),
      wander(32, 1.5, 1, 0.6, 0.5, 0.6, 2),
      keys([[0, 30, 10.5, 0, 0], [5, 30, 10.5, 0, 0], [7.5, 20, 10.5, -6, 0], [10, 10, 10.5, 0, 0], [20, 12, 11.5, 0, 0]]),
      wander(20, 6, 1.5, 0.4, 0.5, 0.6, 0.8), wander(27, 8.5, 1.2, 0.6, 0.5, 0.7, 1.9),
    ],
    ball: [{ kid: 8, t0: 0, t1: 3 }, { kid: 7, t0: 3.8, t1: 6.5 }, { kid: 8, t0: 7.3, t1: 10 }, { kid: 2, t0: 10.9, t1: 13.5 }, { kid: 8, t0: 14.4, t1: 17 }, { kid: 7, t0: 17.8, t1: 20 }],
    events: [{ name: '질주 7m/s', kids: [0], t0: 2, t1: 2 + 36 / 7 }, { name: '질주 7m/s (2)', kids: [0], t0: 11.5, t1: 11.5 + 30 / 7 }, { name: '질주 6m/s', kids: [6], t0: 5, t1: 10 }, { name: '달리기 4.5m/s', kids: [3], t0: 12, t1: 16 }],
  },
  pass: {
    title: '발밑 드리블·패스·가로채기, 발밑에 숨긴 공',
    motions: [
      keys([[0, 5, 7, 0, 0], [0.5, 5.5, 7, 1, -0.2], [4.5, 11, 6, 1, 0], [8.5, 19, 7.5, 0, 0], [12.6, 28, 9, 0, 0], [20, 30, 10, 0, 0]]),
      keys([[0, 13, 11.5, 0, 0], [3, 14, 10.5], [5.4, 15, 9, 0.5, -0.5], [8.5, 18, 8, 0.5, -0.3], [12, 19, 10, 0, 0], [20, 21, 12.5, 0, 0]]),
      keys([[0, 24, 3, 0, 0], [6, 23, 4, 0, 0], [9.2, 22, 5, 0.3, 0.3], [12, 24, 6, 0, 0], [16, 26, 4, 0, 0], [20, 27, 3.5, 0, 0]]),
      keys([[0, 27, 11, 0, 0], [8, 27, 10, 0, 0], [12.6, 25.5, 7.5, -1, 0.5], [15, 22, 9, -1, 0.5], [20, 19, 10, 0, 0]]),
      keys([[0, 12, 12, 0, 0], [10, 14, 12.2, 0, 0], [15.8, 17, 11, 0, 0], [16.6, 16.5, 10.6, 0, 0], [17.6, 16.5, 10.6, 0, 0], [20, 14, 10, 0, 0]]),
      wander(8, 2, 1.5, 0.8, 0.5, 0.6, 0.4),
      wander(32, 3, 1.2, 1.2, 0.5, 0.6, 1.1), wander(31, 12, 1.5, 0.8, 0.6, 0.5, 2.3), wander(5, 11.5, 1.5, 1, 0.5, 0.7, 0.2),
    ],
    ball: [{ kid: 0, t0: 0.5, t1: 4.5 }, { kid: 1, t0: 5.4, t1: 8.5 }, { kid: 2, t0: 9.2, t1: 12 }, { kid: 3, t0: 12.6, t1: 15 }, { kid: 4, t0: 15.8, t1: 20, under: [16.6, 17.6] }],
    events: [{ name: '드리블·패스', kids: [0, 1, 2], t0: 0.5, t1: 12 }, { name: '가로채기', kids: [2, 3], t0: 11.5, t1: 13 }, { name: '발밑에 숨긴 공', kids: [4], t0: 16.6, t1: 17.6 }],
  },
  spectators: {
    title: '코트 밖 1~1.5m의 조끼 비슷한 색 옷 관중 3명 (선수 아님)',
    motions: INNER(0),
    extras: [
      { label: '관중(파랑 비슷한 옷)', rgb: [40, 132, 214], motion: keys([[0, 4, -1.2, 0, 0], [6, 10, -1.3, 0, 0], [9, 10.5, -1.2, 0, 0], [16, 20, -1.4, 0, 0], [20, 23, -1.25, 0, 0]]) },
      { label: '관중(분홍 비슷한 옷)', rgb: [214, 62, 132], motion: keys([[0, 30, 15.0, 0, 0], [5, 26, 15.1, 0, 0], [8, 26, 15.0, 0, 0], [14, 18, 15.15, 0, 0], [20, 14, 15.0, 0, 0]]) },
      { label: '관중(보라 비슷한 옷)', rgb: [132, 108, 196], motion: keys([[0, -1.3, 3, 0, 0], [7, -1.4, 7, 0, 0], [11, -1.2, 7.5, 0, 0], [20, -1.3, 11, 0, 0]]) },
    ],
    ball: [{ kid: 0, t0: 0, t1: 3 }, { kid: 1, t0: 3.8, t1: 7 }, { kid: 2, t0: 7.8, t1: 11 }, { kid: 0, t0: 11.9, t1: 15 }, { kid: 1, t0: 15.8, t1: 20 }],
    events: [{ name: '코트 밖 관중', kids: [], t0: 0, t1: 20 }],
  },
  edge: {
    title: '사이드라인·끝줄을 따라 안쪽 0.3m·밖 0.25~0.3m로 달리는 아이',
    motions: [
      keys([[0, 3, 1.5, 0, 0], [2, 3, 0.3, 0, 0], [3.5, 6, 0.3, 3, 0], [8.5, 21, 0.3, 3, 0], [10, 24, 0.3, 0, 0], [12, 25, 1.8, 0, 0], [20, 22, 3, 0, 0]]),
      keys([[0, 12, 3.5, 0, 0], [10.5, 11, 3, 0, 0], [12, 12, -0.3, 0, 0], [13.5, 15, -0.3, 3, 0], [17.5, 27, -0.3, 3, 0], [19, 30, -0.3, 0, 0], [20, 30.5, 0.3, 0, 0]]),
      wander(17, 7, 2, 1.5, 0.5, 0.6, 1.0),
      keys([[0, 30, 12, 0, 0], [2, 31, 13.95, 0, 0], [3.5, 28, 13.95, -3, 0], [8.5, 13, 13.95, -3, 0], [10, 10, 13.95, 0, 0], [12, 9, 12.2, 0, 0], [20, 7.5, 12, 0, 0]]),
      wander(8, 7.5, 2, 1.5, 0.6, 0.5, 2.0), wander(26, 7, 2, 1.5, 0.5, 0.7, 0.4),
      keys([[0, 33, 3, 0, 0], [3, 35.25, 2.5, 0, 0], [4.5, 35.25, 4, 0, 2], [8.5, 35.25, 12, 0, 2], [10, 35.25, 13, 0, 0], [13, 33, 11.5, 0, 0], [20, 31, 9, 0, 0]]),
      wander(12, 10.5, 1.5, 1, 0.6, 0.5, 1.5), wander(22, 10.5, 1.5, 1, 0.5, 0.6, 2.5),
    ],
    ball: [{ kid: 7, t0: 0, t1: 3 }, { kid: 8, t0: 3.8, t1: 7 }, { kid: 2, t0: 7.8, t1: 11 }, { kid: 7, t0: 11.8, t1: 15 }, { kid: 8, t0: 15.8, t1: 20 }],
    events: [{ name: '사이드라인 안쪽 0.3m 달림', kids: [0], t0: 2, t1: 10 }, { name: '사이드라인 밖 0.25m 달림', kids: [3], t0: 2, t1: 10 },
      { name: '끝줄 밖 0.25m 달림', kids: [6], t0: 3, t1: 10 }, { name: '사이드라인 밖 0.3m 달림', kids: [1], t0: 12, t1: 19 }],
  },
  colorloss: {
    title: '조끼 색이 0.2~0.9초씩 안 잡힘 (그늘·몸 돌림 흉내)',
    motions: INNER(1),
    loss: { 1: [[3.0, 3.4], [7.2, 7.8], [12.0, 12.3]], 4: [[5.0, 5.6], [10.0, 10.2], [15.5, 16.2]], 7: [[4.0, 4.3], [9.0, 9.9], [14.0, 14.5]], 2: [[17.0, 17.6]] },
    ball: [{ kid: 3, t0: 0, t1: 3 }, { kid: 8, t0: 3.9, t1: 7 }, { kid: 3, t0: 8, t1: 11 }, { kid: 5, t0: 12, t1: 15 }, { kid: 0, t0: 16, t1: 20 }],
    events: [],
  },
  reappear: {
    title: '2.5~3초 동안 조끼 색이 안 잡혔다가 같은 팀 아이 옆(약 0.7m)에서 다시 나타남',
    motions: [
      keys([[0, 22, 9, 0, 0], [5, 21, 8, 0, 0], [7.5, 19.6, 7.3, 0, 0], [11, 19.6, 7.3, 0, 0], [14, 22, 10.5, 0, 0], [20, 24, 11.5, 0, 0]]),
      keys([[0, 9, 4, 0, 0], [5, 12, 4.5, 0, 0], [6, 14, 5, 2, 0.4], [9, 18.95, 7.05, 0, 0], [12, 17, 5, 0, 0], [20, 14, 3.5, 0, 0]]),
      wander(8, 10, 1.5, 1.2, 0.5, 0.6, 0.5),
      wander(5, 4, 1.5, 1.2, 0.6, 0.5, 1.4), wander(13, 10.5, 1.5, 1, 0.5, 0.7, 2.2), wander(31, 11.5, 1.5, 0.8, 0.6, 0.5, 0.9),
      wander(23, 2.5, 2, 0.8, 0.5, 0.6, 1.8),
      keys([[0, 20, 12, 0, 0], [8, 22, 11.5, 0, 0], [12, 24, 10, 0.5, -0.5], [14.5, 27.5, 8.1, 0, 0], [17, 25, 6, 0, 0], [20, 23, 4.5, 0, 0]]),
      keys([[0, 30, 4, 0, 0], [8, 29, 6, 0, 0], [12, 28.2, 8.2, 0, 0], [16, 28.2, 8.2, 0, 0], [20, 31, 6, 0, 0]]),
    ],
    loss: { 1: [[6, 9]], 7: [[12, 14.5]] },
    ball: [{ kid: 3, t0: 0, t1: 3 }, { kid: 2, t0: 3.8, t1: 7 }, { kid: 4, t0: 7.8, t1: 11 }, { kid: 2, t0: 11.8, t1: 15 }, { kid: 3, t0: 15.8, t1: 20 }],
    events: [{ name: '3초 안 잡혔다 같은 팀 옆 0.7m에서 다시', kids: [0, 1], t0: 6, t1: 9.5 }, { name: '2.5초 안 잡혔다 같은 팀 옆 0.71m에서 다시', kids: [7, 8], t0: 12, t1: 15 }],
  },
};
// 색 놓침 구간은 이벤트로도 남긴다 (평가기에서 그 구간 번호 바뀜을 따로 셈)
for (const d of Object.values(SCENE_DEFS)) for (const [k, ws] of Object.entries(d.loss || {})) for (const [t0, t1] of ws) if (d === SCENE_DEFS.colorloss) d.events.push({ name: `색 놓침 ${TEAMS[KID_TEAM[k]].name} ${t1 - t0 < 0.5 ? '짧게' : '길게'}`, kids: [+k], t0, t1 });
// 잡동사니 장면: 조끼 없는 무채색 옷 어른(선수 아님, 정답 extras). 코트 선 밖 1.5m 안쪽은 엔진 코트 마스크 안이라 움직이는 덩어리로 잡힌다
const WALKERS = [
  { label: '어른(회색 옷)', rgb: [92, 92, 96], motion: keys([[0, 2, -0.9, 0, 0], [8, 14, -1.1, 0, 0], [12, 14, -1.0, 0, 0], [20, 6, -0.8, 0, 0]]) },
  { label: '어른(흰 옷)', rgb: [222, 222, 218], motion: keys([[0, 33, 14.6, 0, 0], [10, 22, 14.8, 0, 0], [20, 30, 14.5, 0, 0]]) },
  { label: '어른(검은 옷)', rgb: [44, 44, 46], motion: keys([[0, 36.0, 2, 0, 0], [9, 36.1, 10, 0, 0], [20, 35.9, 4, 0, 0]]) },
  { label: '선생님(밝은 회색 옷, 코트 안)', rgb: [170, 170, 168], motion: keys([[0, 3, 13.2, 0, 0], [6, 10, 12.9, 0, 0], [12, 17.5, 13.3, 0, 0], [20, 26, 13.1, 0, 0]]) },
  { label: '어른(진회색 옷)', rgb: [70, 72, 75], motion: keys([[0, -1.0, 9, 0, 0], [10, -1.2, 4, 0, 0], [20, -0.9, 11, 0, 0]]) },
];
SCENE_DEFS.bigkid = {
  title: '몸 넓이 1.9배인 같은 팀 사람 + 같은 팀 아이 조끼 색 6초 놓침 (덩어리 나누기 위험)',
  motions: INNER(2), bodyR: { 2: 0.31 }, loss: { 1: [[4, 10]] },
  ball: [{ kid: 3, t0: 0, t1: 3 }, { kid: 4, t0: 3.8, t1: 7 }, { kid: 8, t0: 7.8, t1: 11 }, { kid: 3, t0: 11.8, t1: 15 }, { kid: 4, t0: 15.8, t1: 20 }],
  events: [{ name: '파랑 2 조끼 색 6초 놓침 (팀 인원 모자람)', kids: [1, 2], t0: 4, t1: 10 }],
};
SCENE_DEFS['bigkid-early'] = { ...SCENE_DEFS.bigkid, title: '몸 넓이 1.9배인 같은 팀 사람 + 같은 팀 아이 조끼 색 처음 6초 놓침 (팀이 처음부터 모자람)', loss: { 1: [[0, 6]] },
  events: [{ name: '파랑 2 조끼 색 처음 6초 놓침', kids: [1, 2], t0: 0, t1: 6 }] };
for (const b of ['cross', 'pass', 'colorloss', 'reappear']) {
  SCENE_DEFS[`${b}-clutter`] = { ...SCENE_DEFS[b], title: `${SCENE_DEFS[b].title} + 잡동사니(그림자·조끼 없는 어른 5명·흰 점·압축 잡티)`, extras: WALKERS, clutter: true };
}

// 공: 가진 아이 발밑(움직이는 쪽, 느리면 정한 쪽으로 서서히) → 다음 아이에게 곧게 날아감
function ballFn(def) {
  const own = def.ball, mot = def.motions;
  const vel = (k, t) => { const a = mot[k](t - 0.15), b = mot[k](t + 0.15); return [(b[0] - a[0]) / 0.3, (b[1] - a[1]) / 0.3]; };
  const atFeet = (seg, t) => {
    const [x, y] = mot[seg.kid](t), [vx, vy] = vel(seg.kid, t), sp = Math.hypot(vx, vy), w = Math.min(1, sp / 0.3);
    let dx = (sp ? (w * vx) / sp : 0) + (1 - w) * 1, dy = sp ? (w * vy) / sp : 0; // 느리면 +x 쪽으로
    const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    const r = seg.under && t >= seg.under[0] && t <= seg.under[1] ? UNDER : FOOT;
    return [x + r * dx, y + r * dy];
  };
  return t => {
    for (let i = 0; i < own.length; i++) {
      const s = own[i];
      if (t < s.t0) {
        if (i === 0) return { pos: atFeet(s, s.t0), owner: -1 };
        const p = own[i - 1], a = atFeet(p, p.t1), b = atFeet(s, s.t0), u = (t - p.t1) / (s.t0 - p.t1);
        return { pos: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], owner: -1 };
      }
      if (t <= s.t1) return { pos: atFeet(s, t), owner: s.kid };
    }
    const z = own[own.length - 1]; return { pos: atFeet(z, z.t1), owner: -1 };
  };
}

// ---------- 정답 ----------
const r3 = v => Math.round(v * 1000) / 1000;
/** 장면 정답 (순수 함수: 같은 장면·seed면 같은 값) */
export function makeTruth(scene, { seed = 1 } = {}) {
  const def = SCENE_DEFS[scene];
  if (!def) throw new Error(`모르는 장면: ${scene} (가능: ${[...ALL_SCENES, ...EXTRA_SCENES].join(', ')})`);
  const ball = ballFn(def), ts = Array.from({ length: FRAMES }, (_, i) => +(i * DT).toFixed(1));
  const kids = def.motions.map((f, id) => {
    const team = KID_TEAM[id], no = KID_TEAM.slice(0, id + 1).filter(t => t === team).length;
    const kid = { id, team, label: `${TEAMS[team].name} ${no}`, path: ts.flatMap(t => f(t).map(r3)) };
    if (def.loss?.[id]) kid.loss = def.loss[id];
    if (def.bodyR?.[id]) kid.bodyRadius = def.bodyR[id];
    return kid;
  });
  const bp = [], visible = [], owner = [];
  for (const t of ts) {
    const b = ball(t), [x, y] = b.pos;
    bp.push(r3(x), r3(y)); owner.push(b.owner);
    visible.push(def.motions.every((f, id) => { const [kx, ky] = f(t); return Math.hypot(kx - x, ky - y) > (def.bodyR?.[id] ?? BODY_R); }) ? 1 : 0);
  }
  const passes = def.ball.slice(1).map((s, i) => { const a = def.ball[i]; return { from: a.kid, to: s.kid, t: a.t1, type: KID_TEAM[a.kid] === KID_TEAM[s.kid] ? 'pass' : 'turnover' }; });
  return {
    app: 'futsal-coach-bench-truth', version: 1, scene, title: def.title, seed, dt: DT, fps: FPS, frames: FRAMES, duration: ts[ts.length - 1],
    court: COURT, video: { width: W, height: H, corners: CORNERS }, bodyRadius: BODY_R, ballRadius: BALL_R,
    teams: TEAMS.map(({ name, color }) => ({ name, color })), kids, ball: { path: bp, visible, owner }, passes, events: def.events,
    extras: (def.extras || []).map(e => ({ label: e.label, color: '#' + e.rgb.map(c => c.toString(16).padStart(2, '0')).join(''), path: ts.flatMap(t => e.motion(t).map(r3)) })),
    ...(def.clutter ? { clutter: { walkers: def.extras.length, shadows: true, whiteShoes: true, spareBall: true, flashes: true, blocks: true } } : {}),
  };
}

/** 아무 시각 t(초)의 정답 공 위치(m)·보임(몸에 가려지면 false)·가진 아이 (공 정답 표시 도구 확인용) */
export function ballAt(scene, t) {
  const def = SCENE_DEFS[scene], b = ballFn(def)(t), [x, y] = b.pos;
  return { x, y, owner: b.owner, visible: def.motions.every((f, id) => { const [kx, ky] = f(t); return Math.hypot(kx - x, ky - y) > (def.bodyR?.[id] ?? BODY_R); }) };
}

/** 웹 '작업 설정 파일 받기'와 같은 형식 (js/analysis-file.js parseAnalysisJob 통과). 팀 인원은 비움(자동) */
export function makeJob(scene) {
  return parseAnalysisJob({
    app: 'futsal-coach-job', version: 1, session: { title: `벤치 ${scene}`, date: '2026-11-14', groupId: 'bench' }, sourceName: `${scene}.mp4`,
    config: { width: W, height: H, corners: CORNERS, court: COURT, teams: TEAMS.map(({ name, color, hue, sat }) => ({ name, color, hue, sat })) },
  });
}

// ---------- 그리기 ----------
function homography(src, dst) { // 4점 대응 3×3 (src → dst)
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
const HM = homography([[0, 0], [COURT[0], 0], [COURT[0], COURT[1]], [0, COURT[1]]], CORNERS);
export const toPx = (x, y) => { const w = HM[6] * x + HM[7] * y + HM[8]; return [(HM[0] * x + HM[1] * y + HM[2]) / w, (HM[3] * x + HM[4] * y + HM[5]) / w]; };
const scaleAt = (x, y) => { const [a, b] = toPx(x, y), [c, d] = toPx(x + 0.5, y), [e, f] = toPx(x, y + 0.5); return Math.sqrt(Math.hypot(c - a, d - b) * Math.hypot(e - a, f - b)) / 0.5; };

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 가장자리를 4×4로 나눠 덮인 만큼 섞는 원 (부드러운 테두리)
function disc(buf, cx, cy, r, [R, G, B]) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1)), y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    let a; if (d <= r - 0.75) a = 1; else if (d >= r + 0.75) continue;
    else { let n = 0; for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (Math.hypot(x + (sx + 0.5) / 4 - cx, y + (sy + 0.5) / 4 - cy) <= r) n++; a = n / 16; if (!a) continue; }
    const p = (y * W + x) * 4; buf[p] += (R - buf[p]) * a; buf[p + 1] += (G - buf[p + 1]) * a; buf[p + 2] += (B - buf[p + 2]) * a;
  }
}
function background(seed) {
  const rnd = mulberry32(seed * 7919 + 13), b = new Uint8ClampedArray(W * H * 4);
  const inv = homography(CORNERS, [[0, 0], [COURT[0], 0], [COURT[0], COURT[1]], [0, COURT[1]]]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const w = inv[6] * x + inv[7] * y + inv[8], u = (inv[0] * x + inv[1] * y + inv[2]) / w, v = (inv[3] * x + inv[4] * y + inv[5]) / w;
    const inCourt = u > -0.6 && u < COURT[0] + 0.6 && v > -0.6 && v < COURT[1] + 0.6, light = 0.94 + 0.1 * (x / W) - 0.04 * (y / H), n = (rnd() - 0.5) * 8;
    const c = inCourt ? [47, 125, 91] : [86, 98, 90], p = (y * W + x) * 4;
    b[p] = c[0] * light + n; b[p + 1] = c[1] * light + n; b[p + 2] = c[2] * light + n; b[p + 3] = 255;
  }
  const L = COURT[0], Wd = COURT[1], WHITE = [236, 236, 230];
  const line = pts => { for (let i = 0; i + 1 < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.02); for (let k = 0; k <= n; k++) { const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n, [px, py] = toPx(x, y); disc(b, px, py, 0.04 * scaleAt(x, y), WHITE); } } };
  const arc = (cx, cy, r, a0, a1) => line(Array.from({ length: 49 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / 48; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }));
  line([[0, 0], [L, 0], [L, Wd], [0, Wd], [0, 0]]); line([[L / 2, 0], [L / 2, Wd]]); arc(L / 2, Wd / 2, 3, 0, 2 * Math.PI);
  const r = Math.min(6, Wd * 0.3), off = 1.5 * Math.min(1, Wd / 20); // 앱 코트 그림과 같은 비율의 페널티 구역
  for (const [gx, dir] of [[0, 1], [L, -1]]) {
    arc(gx, Wd / 2 - off, r, dir > 0 ? -Math.PI / 2 : -Math.PI / 2, dir > 0 ? 0 : -Math.PI);
    line([[gx + dir * r, Wd / 2 - off], [gx + dir * r, Wd / 2 + off]]);
    arc(gx, Wd / 2 + off, r, dir > 0 ? 0 : Math.PI, Math.PI / 2);
    line([[gx, Wd / 2 - 1.5], [gx - dir * 0.8, Wd / 2 - 1.5], [gx - dir * 0.8, Wd / 2 + 1.5], [gx, Wd / 2 + 1.5]]); // 골대
  }
  return b;
}
const HEAD = [46, 36, 30], BALL = [246, 246, 244], SHADE = [72, 74, 72], EXTRA_R = 0.26;
const lost = (def, id, t) => (def.loss?.[id] || []).some(([a, b]) => t >= a && t < b);
const shade = rgb => rgb.map((c, i) => Math.round(0.1 * c + 0.9 * SHADE[i])); // 그늘·몸 돌림: 채도가 팀 색 범위 밖으로

// ---------- 잡동사니 (clutter 장면에서만) ----------
const SUN = [0.3, 0.2], SHADOW_K = 0.55, SPARE = keys([[0, 3, -0.6, 0, 0], [20, 31, -0.7, 0, 0]]); // 그림자는 몸 중심에서 (0.3, 0.2)m 옆, 바닥 밝기 55%
// 바닥을 어둡게 하는 타원 그림자 (가장자리는 4×4로 나눠 섞음)
function darken(buf, cx, cy, rx, ry, k) {
  for (let y = Math.max(0, Math.floor(cy - ry - 1)); y <= Math.min(H - 1, Math.ceil(cy + ry + 1)); y++) for (let x = Math.max(0, Math.floor(cx - rx - 1)); x <= Math.min(W - 1, Math.ceil(cx + rx + 1)); x++) {
    let n = 0; for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const u = (x + (sx + 0.5) / 4 - cx) / rx, v = (y + (sy + 0.5) / 4 - cy) / ry; if (u * u + v * v <= 1) n++; }
    if (!n) continue; const a = n / 16, f = 1 - (1 - k) * a, p = (y * W + x) * 4;
    buf[p] *= f; buf[p + 1] *= f; buf[p + 2] *= f;
  }
}
/** 장면·시드마다 같은 잡동사니 계획: 압축 잡티 블록(0.1초마다 5개 0.1~0.3초 + 작은 블록 8개 0.1~0.2초 / 가끔 25개 몰림), 반짝이는 흰 점 */
export function clutterPlan(scene, seed = 1) {
  let h = 7; for (const c of scene) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = mulberry32(seed * 7907 + h), [L, Wd] = COURT, blocks = [], flashes = [];
  const onLine = () => { const r = rnd(); if (r < 0.3) return [rnd() * L, rnd() < 0.5 ? 0 : Wd]; if (r < 0.5) return [rnd() < 0.5 ? 0 : L, rnd() * Wd]; if (r < 0.7) return [L / 2, rnd() * Wd]; const a = rnd() * 2 * Math.PI; return [L / 2 + 3 * Math.cos(a), Wd / 2 + 3 * Math.sin(a)]; };
  const add = (t, life, tiny = false) => {
    const [x, y] = rnd() < 0.5 ? onLine() : [rnd() * L, rnd() * Wd], [px, py] = toPx(x, y);
    const w = tiny ? 4 + Math.floor(rnd() * 3) : [8, 12, 16][Math.floor(rnd() * 3)], bh = tiny ? 4 + Math.floor(rnd() * 3) : [8, 12][Math.floor(rnd() * 2)];
    blocks.push({ t0: t, t1: t + life, px: Math.round(px - w / 2), py: Math.round(py - bh / 2), w, h: bh, d: (rnd() < 0.5 ? -1 : 1) * (45 + Math.floor(rnd() * 25)) });
  };
  for (let i = 0; i < DUR * 10; i++) {
    const t = i / 10;
    for (let k = 0; k < 5; k++) add(t, 0.1 + 0.2 * rnd());
    for (let k = 0; k < 8; k++) add(t, 0.1 + 0.1 * rnd(), true);
    if (rnd() < 0.06) for (let k = 0; k < 25; k++) add(t, 0.3);
  }
  for (let t = 1; t < DUR; t += 2 + rnd()) flashes.push({ t0: t, t1: t + 0.4, x: 2 + rnd() * (L - 4), y: 1 + rnd() * (Wd - 2) });
  return { blocks, flashes };
}
const dirOf = (f, t) => { const a = f(t - 0.05), b = f(t + 0.05), dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy); return n > 0.005 ? [dx / n, dy / n] : [1, 0]; };

function drawFrame(bg, def, ball, t, plan = null) {
  const buf = new Uint8ClampedArray(bg);
  if (def.clutter) for (const f of [...def.motions, ...def.extras.map(e => e.motion)]) { const [x, y] = f(t), s = scaleAt(x, y), [px, py] = toPx(x + SUN[0], y + SUN[1]); darken(buf, px, py, 0.3 * s, 0.2 * s, SHADOW_K); }
  const b = ball(t).pos, [bx, by] = toPx(b[0], b[1]);
  disc(buf, bx, by, BALL_R * scaleAt(b[0], b[1]), BALL); // 공을 먼저: 위에서 보면 아이 몸이 공을 가린다
  if (def.clutter) {
    const [sx, sy] = SPARE(t), [qx, qy] = toPx(sx, sy); disc(buf, qx, qy, BALL_R * scaleAt(sx, sy), BALL); // 코트 밖 예비 공
    for (const fl of plan.flashes) if (t >= fl.t0 && t < fl.t1) { const [qx2, qy2] = toPx(fl.x, fl.y); disc(buf, qx2, qy2, 0.07 * scaleAt(fl.x, fl.y), BALL); } // 반짝이는 흰 점
  }
  def.motions.forEach((f, id) => {
    const [x, y] = f(t), [px, py] = toPx(x, y), s = scaleAt(x, y);
    const rgb = TEAMS[KID_TEAM[id]].rgb;
    disc(buf, px, py, (def.bodyR?.[id] ?? BODY_R) * s, lost(def, id, t) ? shade(rgb) : rgb); disc(buf, px, py, HEAD_R * s, HEAD);
    if (def.clutter && Math.floor((t + id * 0.17) / 0.3) % 2 === 0) { const [dx, dy] = dirOf(f, t), [fx, fy] = toPx(x + 0.2 * dx, y + 0.2 * dy); disc(buf, fx, fy, 0.05 * s, BALL); } // 흰 신발
  });
  for (const e of def.extras || []) { const [x, y] = e.motion(t), [px, py] = toPx(x, y), s = scaleAt(x, y); disc(buf, px, py, EXTRA_R * s, e.rgb); disc(buf, px, py, HEAD_R * s, HEAD); }
  if (def.clutter) for (const k of plan.blocks) if (t >= k.t0 && t < k.t1) { // 압축 잡티: 블록 밝기가 갑자기 바뀜
    for (let y = Math.max(0, k.py); y < Math.min(H, k.py + k.h); y++) for (let x = Math.max(0, k.px); x < Math.min(W, k.px + k.w); x++) { const p = (y * W + x) * 4; buf[p] += k.d; buf[p + 1] += k.d; buf[p + 2] += k.d; }
  }
  return buf;
}

/** 영상 하나 (H.264). 비트레이트는 실제 샘플(약 470kbps)과 비슷하게, 시간마다 달라지는 잡음(시드 고정)을 얹는다 */
export function renderVideo(scene, file, { seed = 1 } = {}) {
  const def = SCENE_DEFS[scene], ball = ballFn(def), bg = background(seed), plan = def.clutter ? clutterPlan(scene, seed) : null;
  return new Promise((resolve, reject) => {
    // 필터·인코더 모두 스레드 1개: 여러 스레드면 같은 시드라도 영상이 매번 조금씩 달라진다 (재현 가능한 기준을 위해)
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      '-vf', `format=yuv420p,noise=alls=5:allf=t+u:all_seed=${seed}`, '-c:v', 'libx264', '-threads', '1', '-preset', 'medium', '-b:v', '470k', '-maxrate', '700k', '-bufsize', '1400k',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('error', reject); p.on('close', c => (c ? reject(new Error(`ffmpeg ${c}: ${err.slice(-300)}`)) : resolve(file)));
    (async () => {
      for (let f = 0; f < DUR * FPS; f++) {
        const frame = drawFrame(bg, def, ball, f / FPS, plan);
        if (!p.stdin.write(Buffer.from(frame.buffer))) await new Promise(r => p.stdin.once('drain', r));
      }
      p.stdin.end();
    })().catch(reject);
  });
}

// ---------- 명령 ----------
async function main(argv) {
  const opt = { out: 'bench-out', seed: 1, scenes: ALL_SCENES, video: true, analyze: false, engine: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opt.out = argv[++i]; else if (a === '--seed') opt.seed = +argv[++i];
    else if (a === '--scenes') opt.scenes = argv[++i].split(',').filter(Boolean);
    else if (a === '--no-video') opt.video = false; else if (a === '--analyze') opt.analyze = true; else if (a === '--engine') opt.engine = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 22).map(l => l.slice(3)).join('\n')); return 0; }
    else throw new Error(`모르는 옵션: ${a}`);
  }
  if (!Number.isInteger(opt.seed)) throw new Error('--seed는 정수');
  fs.mkdirSync(opt.out, { recursive: true });
  const run = { seed: opt.seed, at: new Date().toISOString(), scenes: {} };
  for (const s of opt.scenes) {
    const t0 = Date.now(), truth = makeTruth(s, { seed: opt.seed });
    fs.writeFileSync(path.join(opt.out, `${s}.truth.json`), JSON.stringify(truth));
    fs.writeFileSync(path.join(opt.out, `${s}-작업.json`), JSON.stringify(makeJob(s)));
    const rec = run.scenes[s] = {};
    if (opt.video) { await renderVideo(s, path.join(opt.out, `${s}.mp4`), { seed: opt.seed }); rec.videoSeconds = (Date.now() - t0) / 1000; rec.videoBytes = fs.statSync(path.join(opt.out, `${s}.mp4`)).size; }
    console.log(`${s}: 정답·작업 파일${opt.video ? `·영상 (${rec.videoSeconds.toFixed(1)}초, ${(rec.videoBytes / 1024).toFixed(0)}KB)` : ''}`);
    if (opt.analyze) {
      // 분석 방식은 늘 명시해서 넘긴다 (CLI 기본값이 바뀌어도 '결과'는 기준인 classical-v1, '결과-v2'는 v2)
      const engine = opt.engine || 'classical-v1', tag = engine !== 'classical-v1' ? `-${engine.replace(/^classical-/, '')}` : '';
      const result = path.join(opt.out, `${s}-결과${tag}.json`), work = result + '.work', t1 = Date.now();
      fs.rmSync(work, { recursive: true, force: true }); // 예전 실행이 남긴 중간 저장 (이 폴더는 벤치 전용)
      const code = await new Promise(res => {
        const p = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'analyze.mjs'), path.join(opt.out, `${s}.mp4`), path.join(opt.out, `${s}-작업.json`), result, '--engine', engine], { stdio: ['ignore', 'ignore', 'inherit'] });
        p.on('close', res);
      });
      rec[`analyze${tag}`] = { seconds: (Date.now() - t1) / 1000, exit: code, engine, result: path.basename(result) };
      console.log(`${s}: 분석(${engine}) ${code === 0 ? '끝' : `실패(종료 ${code})`} ${((Date.now() - t1) / 1000).toFixed(1)}초`);
    }
  }
  const runFile = path.join(opt.out, `bench-run${opt.engine && opt.engine !== 'classical-v1' ? '-' + opt.engine.replace(/^classical-/, '') : ''}.json`);
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(e.message); process.exitCode = 2; });
}
