// 결과 통계 (순수 계산, 화면 없음): 분석 직후(pipeline.analyzeFrames)와 검수 다시 계산(review.recomputeStats·교정)이 같은 함수·같은 입력으로 센다.
// 입력은 저장되는 모양 그대로: players[].path(0.01m 반올림, null = 모름)·players[].hidden·players[].reviewBreaks(교정 경계)·ball(0.01m, null)·dt.
// 그래서 교정 안 한 결과를 다시 계산하면 분석 직후 숫자와 정확히 같다 (예전엔 분석 직후만 반올림 전 위치로 세서 조금씩 달랐음).
// 새 파일이라 이름으로 가져와도 된다. 여기서 track.js는 예전부터 있던 이름(playerStats·possession)만 가져온다 (배포 직후 옛 track.js가 캐시에 남아도 모듈 오류 없음)
import { playerStats, possession } from './track.js';

const num = v => (typeof v === 'number' ? v : NaN); // 저장된 결과의 null(= 모름)은 0이 아니라 NaN으로 계산

/** 선수의 교정 경계를 격자 칸 번호로. 칸 j가 경계면 (j-1 → j) 연결이 교정으로 생긴 인위적 연결이다 (실제 이동 아님). */
export const reviewBreakIndices = (p, dt) => Array.from(p?.reviewBreaks || [], t => Math.round(t / dt)).filter(Number.isInteger);

// 통계용 임시 마스크(저장 안 함) = 가려짐 | 좌표 없음(null) | 교정 경계.
// playerStats는 마스크 칸 j가 있으면 0.5초 평균 위치로 잰 속도 v[j-5..j]를 0으로 친다.
// (j-1 → j) 점프가 섞이는 속도는 정확히 v[j-5..j-1], 칸 j의 NaN이 섞이는 속도는 v[j-5..j]라서
// 경계 점프·모르는 좌표가 뛴 거리·최고 속도·질주 어디에도 남지 않는다.
function statMask(p, pos, n, dt) {
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = p.hidden[i] || Number.isNaN(pos[2 * i]) || Number.isNaN(pos[2 * i + 1]) ? 1 : 0;
  for (const j of reviewBreakIndices(p, dt)) if (j >= 0 && j < n) m[j] = 1;
  return m;
}

/** R(저장 모양 결과, 고쳐도 되는 것)의 통계를 경로·가려짐·공·교정 경계에서 처음부터 세어 채우고 R을 돌려준다.
 * 선수마다 distance·topSpeed·sprints·possession·touches·passes·received·lost, 전체 passes·turnovers·hiddenRate (이미 있는 칸은 자리 그대로 값만 바뀜) */
export function fillStats(R) {
  const dt = R.dt, pos = R.players.map(p => Float32Array.from(p.path, num));
  const pz = possession(Float32Array.from(R.ball, num), R.players.map((p, k) => ({ team: p.team, pos: pos[k] })), dt); // NaN 선수·공은 소유 판정에서 빠짐
  R.players.forEach((p, k) => {
    const s = playerStats(pos[k], statMask(p, pos[k], p.hidden.length, dt), dt);
    Object.assign(p, {
      distance: s.distance, topSpeed: s.topSpeed, sprints: s.sprints, possession: pz.time[k], touches: pz.touches[k],
      passes: pz.passes.filter(x => x.from === k).length, received: pz.passes.filter(x => x.to === k).length, lost: pz.turnovers.filter(x => x.from === k).length,
    });
  });
  R.passes = pz.passes; R.turnovers = pz.turnovers;
  R.hiddenRate = R.players.reduce((a, p) => a + p.hidden.reduce((x, y) => x + (y ? 1 : 0), 0) / p.hidden.length, 0) / R.players.length; // 진짜 가려짐만 (경계는 안 셈)
  return R;
}
