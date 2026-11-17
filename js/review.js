// 검수·교정 (순수 계산, 화면 없음): 사람이 확인할 구간 찾기, 같은 팀 두 선수의 번호가 바뀐 구간 바로잡기, 통계 다시 계산.
// result는 pipeline.analyzeFrames 출력(= 저장된 결과) 모양이고 players[k].id === k 여야 한다.
// 입력은 절대 고치지 않고 항상 새 결과를 돌려준다. 원본 세션 보존·되돌리기는 화면(UI) 담당이고,
// 여기서는 교정 기록(reviewEdits)과 교정 경계(players[].reviewBreaks)만 결과에 남긴다.
// 통계는 분석 직후(pipeline.analyzeFrames)와 같은 함수로 센다 (stats.fillStats: 저장된 경로·공·가려짐·교정 경계 → 같은 결과면 같은 숫자)
import { fillStats as restat, reviewBreakIndices } from './stats.js'; // 새 파일이라 이름으로 가져와도 캐시 섞임에 안전
export { reviewBreakIndices }; // 예전처럼 review.js에서도 내보냄

/** 검토 후보·교정 경계 기준. 모두 휴리스틱이라 "오류 확정"이 아니라 "사람이 확인할 곳"이다. */
export const REVIEW_RULES = {
  hiddenMinS: 1.0, // 안 보임(가려짐 또는 좌표 없음)이 1초 이상 이어진 곳만 후보. 0.1~0.4초 깜빡임은 흔해서(샘플 5분 영상 302번 중 231번) 목록만 길어짐
  hiddenGapS: 0.5, // 0.5초 이하로 잠깐 보였다 다시 가려지면 한 구간으로 합침
  jumpSpeed: 9, // 보이는 두 칸 사이를 9m/s보다 빠르게 옮겨 가면 순간 이동. 활동량(track.playerStats)이 추적 튐으로 보고 버리는 속도와 같음
  jumpMinM: 1.0, // 그래도 1m 이하는 위치 떨림일 수 있어 뺌 (샘플에서 0.1초 이동의 99%가 0.67m 이하)
  limit: 50, // 후보 최대 개수. 넘치면 이유별로 심한 것(긴 가려짐, 큰 점프)부터 번갈아 고른 뒤 시간순으로 돌려줌
  breakSpeed: 8, // 교정 경계의 한 칸 이동이 8m/s × dt(0.1초면 0.8m)보다 길면 인위적 연결. 아이 최고 속도 가정(track.js 추적과 같음)
};
/** findReviewSegments의 reason 코드 → 화면에 보일 말 */
export const REVIEW_REASONS = { hidden: '오래 가려짐', jump: '순간 이동' };

const num = v => (typeof v === 'number' ? v : NaN); // 저장된 결과의 null(= 모름)은 0이 아니라 NaN으로 계산
const isArr = a => Array.isArray(a) || ArrayBuffer.isView(a);
const secOf = dt => i => Math.round(i * dt * 1000) / 1000; // 칸 번호 → 초 (0.30000000000000004 같은 꼬리 없이)

function check(R) {
  if (!R || typeof R !== 'object') throw new Error('분석 결과가 없어요');
  if (!(R.dt > 0) || !Number.isFinite(R.dt)) throw new Error('결과의 시간 간격(dt)이 잘못됐어요');
  if (!Number.isFinite(R.duration) || R.duration < 0) throw new Error('결과의 영상 길이(duration)가 잘못됐어요');
  if (!isArr(R.players) || !R.players.length) throw new Error('결과에 선수가 없어요');
  if (!isArr(R.ball) || !R.ball.length || R.ball.length % 2) throw new Error('결과의 공 경로 형식이 잘못됐어요');
  const n = R.ball.length / 2;
  R.players.forEach((p, k) => {
    if (!p || typeof p !== 'object' || (p.id !== undefined && p.id !== k)) throw new Error(`선수 번호(id)가 순서와 달라요: ${k}번째 선수`);
    if (!isArr(p.path) || p.path.length !== 2 * n || !isArr(p.hidden) || p.hidden.length !== n) throw new Error(`${k}번 선수의 경로·가려짐 길이가 공 경로와 달라요 (예전 형식 결과일 수 있어요)`);
  });
  return { dt: R.dt, n };
}

// restat(R) = stats.fillStats: R(이미 복사본)의 통계를 경로·가려짐·공·교정 경계에서 처음부터 다시 계산해 채운다 (통계용 마스크 = 가려짐 | 좌표 없음 | 교정 경계)

/** 결과의 모든 통계를 저장된 경로·가려짐·공·교정 경계로 다시 계산한 새 결과. 입력은 그대로.
 * 분석 직후 통계도 같은 함수(stats.fillStats)로 저장되는 0.01m 경로에서 세므로, 교정 안 한 결과는 분석 직후 값과 정확히 같다. */
export const recomputeStats = result => (check(result), restat(structuredClone(result)));

const STAT_KEYS = ['distance', 'topSpeed', 'sprints', 'possession', 'touches', 'passes', 'received', 'lost'];

/** 교정 전후 비교: 같은 수업의 두 결과(보통 originalResult와 지금 result)를 선수마다 맞대어 통계 차이를 낸다.
 * 두 쪽 모두 recomputeStats로 저장된 경로(0.01m 반올림)·가려짐·공·교정 경계(reviewBreaks)에서 똑같이 다시 계산한 뒤 비교하므로,
 * 저장된 원본 숫자(분석 직후 반올림 전 값)와의 차이를 교정 효과로 잘못 보이지 않는다. 같은 결과끼리 비교하면 delta는 모두 0.
 * 반환: 모든 선수 [{ id, team, label, before, after, delta }] (id 순), before/after/delta = { distance, topSpeed, sprints, possession,
 *   touches, passes, received, lost }, delta = after - before. label·team은 current 쪽 값.
 * 비교할 수 없으면(두 결과 형식 오류, 선수 수·id·팀·팀 수·dt·코트 크기·영상 길이·장면 수가 다름) 한국어 Error. 입력은 고치지 않는다. */
export function compareReviewResults(original, current) {
  const sides = [['원본', original], ['지금', current]].map(([name, R]) => { try { return { R, ...check(R) }; } catch (e) { throw new Error(`${name} 결과를 비교할 수 없어요: ${e.message}`); } });
  const [a, b] = sides, PA = a.R.players, PB = b.R.players, why = m => new Error(`두 결과를 비교할 수 없어요: ${m}`);
  if (PA.length !== PB.length) throw why(`선수 수가 달라요 (원본 ${PA.length}명, 지금 ${PB.length}명)`);
  if (a.dt !== b.dt) throw why(`시간 간격(dt)이 달라요 (${a.dt}, ${b.dt})`);
  if (a.n !== b.n || a.R.duration !== b.R.duration) throw why(`영상 길이·장면 수가 달라요 (${a.R.duration}초 ${a.n}장면, ${b.R.duration}초 ${b.n}장면)`);
  const ca = isArr(a.R.court) ? Array.from(a.R.court) : [], cb = isArr(b.R.court) ? Array.from(b.R.court) : [];
  if (ca.length !== 2 || cb.length !== 2 || ca.some((v, k) => v !== cb[k])) throw why(`코트 크기가 달라요 (${ca.join('×')}m, ${cb.join('×')}m)`);
  if ((a.R.teams?.length ?? 0) !== (b.R.teams?.length ?? 0)) throw why('팀 수가 달라요');
  PA.forEach((p, k) => {
    if ((p.id ?? k) !== (PB[k].id ?? k)) throw why(`${k}번째 선수의 번호(id)가 달라요`);
    if (p.team !== PB[k].team) throw why(`${k}번 선수의 팀이 달라요`);
  });
  const A = restat(structuredClone(original)), B = restat(structuredClone(current));
  const pick = p => Object.fromEntries(STAT_KEYS.map(k => [k, p[k]]));
  return B.players.map((p, k) => {
    const before = pick(A.players[k]), after = pick(p);
    return { id: k, team: p.team, label: p.label, before, after, delta: Object.fromEntries(STAT_KEYS.map(x => [x, after[x] - before[x]])) };
  });
}

/** 사람이 확인할 만한 구간. 반환: [{ playerId, start, end, reason }] 시간은 초(dt 격자 칸 시각, 양 끝 포함), 시간순.
 * - reason 'hidden': 안 보임(hidden=1 또는 좌표 null/NaN)이 hiddenMinS(1초) 이상 이어진 곳. hiddenGapS(0.5초) 이하 틈은 합침.
 *   start/end = 처음·마지막 안 보인 칸 → 그대로 swapPlayerSegment 구간으로 쓸 수 있음.
 * - reason 'jump': 보이는 두 칸(사이에 안 보인 칸이 있어도 됨) 사이 이동이 jumpMinM(1m)보다 길고 jumpSpeed(9m/s)보다 빠른 곳.
 *   start = 마지막으로 보인 칸, end = 다시 보인 칸. 같은 선수의 점프가 hiddenGapS 안에 이어지면 합침.
 * - 후보가 limit(기본 50, opts.limit로 바꿈)개를 넘으면 이유별로 심한 것(긴 가려짐·큰 점프)부터 번갈아 고름.
 * 오류 확정이 아니라 휴리스틱. 입력은 고치지 않는다. 결과 형식이 잘못되면 한국어 Error. */
export function findReviewSegments(result, opts = {}) {
  const { dt, n } = check(result), sec = secOf(dt), rule = REVIEW_RULES;
  const limit = opts?.limit ?? rule.limit;
  if (!(limit >= 0)) throw new Error('후보 개수(limit)는 0 이상이어야 해요');
  const gap = Math.round(rule.hiddenGapS / dt), minLen = Math.round(rule.hiddenMinS / dt);
  const hid = [], jump = [];
  result.players.forEach((p, id) => {
    const x = i => num(p.path[2 * i]), y = i => num(p.path[2 * i + 1]);
    const seen = i => !p.hidden[i] && Number.isFinite(x(i)) && Number.isFinite(y(i));
    for (const r of runs(n, i => !seen(i), gap)) if (r.e - r.s + 1 >= minLen) hid.push({ id, s: r.s, e: r.e, w: r.e - r.s + 1, reason: 'hidden' });
    for (let i = 0, last = -1; i < n; i++) {
      if (!seen(i)) continue;
      if (last >= 0) {
        const d = Math.hypot(x(i) - x(last), y(i) - y(last));
        if (d > rule.jumpMinM && d / ((i - last) * dt) > rule.jumpSpeed) {
          const l = jump[jump.length - 1];
          if (l && l.id === id && last - l.e <= gap) { l.e = i; l.w = Math.max(l.w, d); } else jump.push({ id, s: last, e: i, w: d, reason: 'jump' });
        }
      }
      last = i;
    }
  });
  const worst = a => [...a].sort((u, v) => v.w - u.w);
  return alternate([worst(hid), worst(jump)], limit)
    .sort((u, v) => u.s - v.s || u.id - v.id || u.reason.localeCompare(v.reason))
    .map(g => ({ playerId: g.id, start: sec(g.s), end: sec(g.e), reason: g.reason }));
}

// on(i)가 참인 칸의 연속 구간들. 사이 틈이 gap칸 이하면 한 구간으로 합침
function runs(n, on, gap) {
  const out = [];
  for (let i = 0; i < n; i++) if (on(i)) { const l = out[out.length - 1]; if (l && i - l.e - 1 <= gap) l.e = i; else out.push({ s: i, e: i }); }
  return out;
}
// 목록마다 앞에서부터 하나씩 번갈아 limit개까지
function alternate(lists, limit) {
  const out = [], at = lists.map(() => 0);
  while (out.length < limit && lists.some((l, k) => at[k] < l.length)) lists.forEach((l, k) => { if (out.length < limit && at[k] < l.length) out.push(l[at[k]++]); });
  return out;
}

// 교정 경계 판단: 칸 j-1 → j 한 칸 이동이 breakSpeed × dt보다 길면 인위적 연결.
// 어느 한쪽 좌표가 없으면(null) 연결 자체가 없고 통계 마스크가 이미 빼므로 경계로 치지 않음 (NaN > x = false).
const artificial = (path, j, dt) => Math.hypot(num(path[2 * j]) - num(path[2 * j - 2]), num(path[2 * j + 1]) - num(path[2 * j - 1])) > REVIEW_RULES.breakSpeed * dt;
const setBreaks = (p, set, sec) => { if (set.size) p.reviewBreaks = [...set].sort((u, v) => u - v).map(sec); else delete p.reviewBreaks; };

/** 같은 팀 두 선수의 [start, end] 구간 경로·가려짐을 맞바꾼 새 결과 (번호 바뀜 바로잡기).
 * 구간: start·end(초)를 각각 가장 가까운 dt 격자 칸으로 맞춘 뒤(eval-ball.mjs와 같은 Math.round, 마지막 칸 넘으면 마지막 칸) 양 끝 포함.
 *   그래서 start = end면 한 칸만, 0.3/0.1 = 2.9999…도 3번 칸부터.
 * 검사(어기면 한국어 Error, 입력은 그대로): playerA·playerB는 서로 다른 0 이상 정수이고 있는 선수, 같은 팀,
 *   start·end는 유한한 숫자이고 0 ≤ start ≤ end ≤ duration.
 * 맞바꾸는 것: path(x,y)와 hidden만, 정확히 그 칸들. hidden은 원래 뜻(검출 가려짐) 그대로라 경계 때문에 고치지 않는다.
 *   null 좌표는 null 그대로 옮긴다. 공·id·팀·이름표·다른 선수 경로는 그대로.
 * 교정 경계 정책(가짜 이동·질주 방지): 구간 양 끝(칸 i0, 칸 i1+1)에서 앞 칸과의 한 칸 이동이 breakSpeed × dt(0.1초면 0.8m)보다 길면
 *   그 선수 reviewBreaks(초)에 그 칸을 기록한다. 실제로 이어지는 올바른 교정(대개 두 아이가 겹친 순간)은 경계로 안 쳐서 빼는 게 없다.
 *   통계(뛴 거리·최고 속도·질주)는 경계 칸을 가려짐처럼 다룬 임시 마스크로만 계산해서 경계 점프가 안 들어간다(computeTactics 누적 거리도 같은 경계를 뺌).
 *   기존 경계는 데이터와 함께 움직인다: 구간 안쪽(i0 < j ≤ i1)은 맞바뀌고, 양 끝은 새로 판단하고, 나머지는 그대로라
 *   여러 번 교정해도 경계를 잃거나 엉뚱한 선수에 붙지 않는다. 같은 구간을 두 번 바꾸면 경계도 없어져 원래 통계로 돌아온다.
 * 다시 계산: 모든 선수의 distance·topSpeed·sprints·possession·touches·passes·received·lost와 passes·turnovers·hiddenRate.
 *   계산 때만 null 좌표·null 공을 NaN으로 바꿔(0 아님) 그 칸은 이동·공 소유에서 빠진다. 저장값은 null 그대로.
 * 결과에 reviewEdits(교정 기록 [{type:'swap', playerA, playerB, start, end}], 실제로 바뀐 칸의 초)를 덧붙인다. JSON으로 저장해도 그대로. */
export function swapPlayerSegment(result, opts) {
  const { dt, n } = check(result), P = result.players, sec = secOf(dt);
  if (!opts || typeof opts !== 'object') throw new Error('바꿀 두 선수(playerA, playerB)와 구간(start, end 초)을 넣어 주세요');
  const { playerA: a, playerB: b, start, end } = opts;
  for (const [k, v] of [['playerA', a], ['playerB', b]]) if (!Number.isInteger(v) || v < 0 || v >= P.length) throw new Error(`${k}: 없는 선수 번호예요 (${v})`);
  if (a === b) throw new Error('서로 다른 두 선수를 골라 주세요');
  if (P[a].team !== P[b].team) throw new Error('같은 팀 선수끼리만 바꿀 수 있어요');
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`시작·끝 시간(초)이 숫자가 아니에요 (${start}~${end})`);
  if (start < -1e-9 || end < start || end > result.duration + 1e-9) throw new Error(`구간이 잘못됐어요: 0 ≤ 시작 ≤ 끝 ≤ ${result.duration}초여야 해요 (${start}~${end})`);
  const idx = t => Math.min(n - 1, Math.max(0, Math.round(t / dt))), i0 = idx(start), i1 = idx(end);
  const R = structuredClone(result), A = R.players[a], B = R.players[b];
  for (let i = i0; i <= i1; i++) {
    for (const d of [2 * i, 2 * i + 1]) [A.path[d], B.path[d]] = [B.path[d], A.path[d]];
    [A.hidden[i], B.hidden[i]] = [B.hidden[i], A.hidden[i]];
  }
  const outside = j => j < i0 || j > i1 + 1, inside = j => j > i0 && j <= i1;
  const ba = reviewBreakIndices(P[a], dt), bb = reviewBreakIndices(P[b], dt);
  const na = new Set([...ba.filter(outside), ...bb.filter(inside)]), nb = new Set([...bb.filter(outside), ...ba.filter(inside)]);
  for (const j of [i0, i1 + 1]) if (j > 0 && j < n) { if (artificial(A.path, j, dt)) na.add(j); if (artificial(B.path, j, dt)) nb.add(j); }
  setBreaks(A, na, sec); setBreaks(B, nb, sec);
  R.reviewEdits = [...(result.reviewEdits || []), { type: 'swap', playerA: a, playerB: b, start: sec(i0), end: sec(i1) }];
  return restat(R);
}
