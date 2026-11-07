// 공 추적 정확도 재기: 분석 결과 vs 사람이 표시한 정답
// 사용: node tools/eval-ball.mjs 결과.json 공정답.json [허용오차m=0.75]
//   결과.json: tools/analyze.mjs 출력, 또는 앱 백업 파일(수업이 여럿이면 SESSION=제목일부 로 고르기)
import { readFileSync } from 'node:fs';
import { homography, applyH } from '../js/vision.js';

const [resPath, labPath, tolArg] = process.argv.slice(2);
if (!resPath || !labPath) { console.error('사용: node tools/eval-ball.mjs 결과.json 공정답.json [허용오차m]'); process.exit(1); }
let R = JSON.parse(readFileSync(resPath, 'utf8'));
if (R.app === 'futsal-coach') { // 앱 백업 파일
  const ss = R.sessions.filter(s => !process.env.SESSION || (s.title + ' ' + s.date).includes(process.env.SESSION));
  if (ss.length !== 1) { console.error('수업을 하나로 골라 주세요 (SESSION=제목일부):', R.sessions.map(s => s.title + ' ' + s.date).join(', ')); process.exit(1); }
  R = ss[0].result;
}
const tol = +(tolArg ?? 0.75);
const lab = JSON.parse(readFileSync(labPath, 'utf8'));
const [L, W] = R.court, Hm = homography(R.video.corners, [[0, 0], [L, 0], [L, W], [0, W]]);
const c = { ball: 0, hit: 0, wrong: 0, miss: 0, hidden: 0, hiddenShown: 0 }, errs = [], bad = [];
for (const l of lab.labels) {
  const i = Math.round(l.t / R.dt), bx = R.ball[2 * i], by = R.ball[2 * i + 1], has = bx != null && !Number.isNaN(bx);
  if (l.state === 'hidden') { c.hidden++; if (has) c.hiddenShown++; continue; }
  if (l.state !== 'ball') continue;
  c.ball++;
  const [gx, gy] = applyH(Hm, l.x * R.video.width, l.y * R.video.height);
  if (!has) { c.miss++; bad.push(`${l.t}s 놓침`); continue; }
  const d = Math.hypot(bx - gx, by - gy);
  if (d <= tol) { c.hit++; errs.push(d); } else { c.wrong++; bad.push(`${l.t}s ${d.toFixed(1)}m 틀림`); }
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');
console.log(`공이 보이는 장면 ${c.ball}개 (허용 오차 ${tol}m)`);
console.log(`  맞음   ${c.hit}  ${pct(c.hit, c.ball)}   평균 오차 ${errs.length ? (errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2) : '-'}m`);
console.log(`  틀림   ${c.wrong}  ${pct(c.wrong, c.ball)}   (엉뚱한 곳)`);
console.log(`  놓침   ${c.miss}  ${pct(c.miss, c.ball)}   (공 없다고 함)`);
console.log(`가려진 장면 ${c.hidden}개 중 위치를 추정해 보여 준 곳 ${c.hiddenShown}개`);
if (bad.length) console.log('틀린 장면:', bad.slice(0, 30).join(', '), bad.length > 30 ? '…' : '');
