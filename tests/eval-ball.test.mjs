// node --test tests/
// 공 정확도 재기(tools/eval-ball.mjs): 로컬 분석 도구 결과 파일(RESULT)·앱 백업 파일·예전 결과 그대로를 모두 읽고 같은 점수를 내는지 (합성 자료만)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/eval-ball.mjs', import.meta.url));
// 20×12m 코트 = 200×120px 화면(1m = 10px). 공은 0.1초마다 (5+t×10, 6)m로 굴러가고 0.8초부터 안 보임(null)
const result = {
  dt: 0.1, court: [20, 12], video: { width: 200, height: 120, corners: [[0, 0], [200, 0], [200, 120], [0, 120]] },
  players: [], passes: [], turnovers: [],
  ball: Array.from({ length: 10 }, (_, i) => (i < 8 ? [5 + i, 6] : [null, null])).flat(),
};
// 정답(화면 비율 좌표): 0.2초 맞음(7m, 0.1m 차이) · 0.5초 틀림(정답 15m) · 0.8초 놓침 · 0.9초 가려짐(위치 안 보여 줌) · 0.3초 건너뜀
const labels = { video: 'synthetic.mp4', labels: [
  { t: 0.2, state: 'ball', x: 7.1 / 20, y: 0.5 }, { t: 0.5, state: 'ball', x: 15 / 20, y: 0.5 },
  { t: 0.8, state: 'ball', x: 0.6, y: 0.5 }, { t: 0.9, state: 'hidden' }, { t: 0.3, state: 'skip' },
] };
function run(doc, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ball-'));
  try {
    const rp = path.join(dir, 'result.json'), lp = path.join(dir, 'labels.json');
    fs.writeFileSync(rp, JSON.stringify(doc)); fs.writeFileSync(lp, JSON.stringify(labels));
    return spawnSync(process.execPath, [TOOL, rp, lp], { encoding: 'utf8', env: { ...process.env, ...env } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const score = out => ['맞음', '틀림', '놓침'].map(k => Number(out.match(new RegExp(`${k}\\s+(\\d+)`))?.[1]));

test('결과 파일(RESULT)은 감싼 result를 풀어 채점하고 분석 방식을 보여 줌', () => {
  const r = run({ app: 'futsal-coach-analysis', version: 1, analysis: { engine: 'classical-v2' }, result });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /분석 방식: classical-v2/);
  assert.deepEqual(score(r.stdout), [1, 1, 1], r.stdout);
  assert.match(r.stdout, /공이 보이는 장면 3개/);
  assert.match(r.stdout, /가려진 장면 1개 중 위치를 추정해 보여 준 곳 0개/);
});

test('예전 결과 그대로(감싸지 않은 결과)와 앱 백업 파일도 같은 점수', () => {
  const raw = run(result);
  assert.equal(raw.status, 0, raw.stderr);
  assert.deepEqual(score(raw.stdout), [1, 1, 1]);
  assert.doesNotMatch(raw.stdout, /분석 방식/, '방식 기록이 없으면 안 보여 줌');
  const backup = { app: 'futsal-coach', sessions: [{ title: '수업 가', date: '2026-11-14', result, analysis: { engine: 'classical-v1' } }, { title: '수업 나', date: '2026-11-15', result }] };
  const b = run(backup, { SESSION: '수업 가' });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /분석 방식: classical-v1/);
  assert.deepEqual(score(b.stdout), [1, 1, 1]);
  const many = run(backup, { SESSION: '' });
  assert.equal(many.status, 1, '수업이 여럿이면 하나로 골라 달라고 함');
});
