// node --test tests/
// 로컬 분석 도구의 장면 시각 대응 시험 (ffmpeg로 만든 합성 영상, ffmpeg·ffprobe가 없으면 건너뜀).
// classical-v2: 도구의 i번째 장면 = 브라우저가 currentTime i/10초에 보여 주는 장면 = pts ≤ i/10초인 마지막 장면 (첫 장면보다 이르면 첫 장면).
//   30fps · 25fps · 29.97fps · 영상이 소리보다 1/15초 늦게 시작하는 mp4의 장면마다 번호를 흑백 줄무늬로 그려 넣고,
//   도구 디코딩(frameFilter)이 낸 장면의 번호를, ffprobe로 읽은 원본 장면 pts에서 셈한 기대 장면과 맞춰 본다.
// classical-v1: 예전 디코딩 그대로 (필터 글자 그대로, 30fps면 한 장 뒤 장면).
// 실제 명령(tools/analyze.mjs)으로도: 30fps 영상에서 움직이는 아이 자리로 장면 번호를 읽어 v2·v1 대응과, Ctrl+C → --resume 이어 하기가 같은 대응인지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrames, buildBackground, binaries, probeVideo, frameFilter } from '../tools/local-analysis.mjs';
import { colorFromClick } from '../js/vision.js';
import { parseAnalysisJob, parseAnalysisFile } from '../js/analysis-file.js';

const CLI = fileURLToPath(new URL('../tools/analyze.mjs', import.meta.url));
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version']).status === 0);
const skip = hasFfmpeg ? false : 'ffmpeg·ffprobe가 없어 건너뜀';
let dir = null;
const p = f => path.join(dir, f);

// RGB 장면들을 직접 만들어 무손실(H.264 qp 0)로 저장
function encode(file, rate, frames, w, h) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', rate, '-i', '-', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', file],
    { input: Buffer.concat(frames), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
}
// 번호 영상: 128×32, 가로 8칸 줄무늬 (칸 b가 흰색이면 장면 번호의 b번째 비트가 1)
const SW = 128, SH = 32, BITS = 8, CELL = SW / BITS;
const numbered = k => {
  const f = Buffer.alloc(SW * SH * 3);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) f.fill((k >> Math.floor(x / CELL)) & 1 ? 235 : 16, (y * SW + x) * 3, (y * SW + x) * 3 + 3);
  return f;
};
const readNumber = f => {
  let k = 0;
  for (let b = 0; b < BITS; b++) {
    const v = f[((SH >> 1) * SW + b * CELL + (CELL >> 1)) * 4];
    assert.ok(v < 64 || v > 192, `줄무늬 값이 흐려요: ${v}`);
    if (v > 128) k |= 1 << b;
  }
  return k;
};
const decodedNumbers = async (file, engine) => {
  const got = [];
  await decodeFrames({ ffmpeg: binaries().ffmpeg, W: SW, H: SH, args: ['-i', file, '-map', '0:v:0', '-vf', frameFilter(engine, SW, SH)], onFrame: f => { got.push(readNumber(f)); } });
  return got;
};
// 원본 장면 pts(ffprobe, 보여 주는 순서) → 칸 i의 기대 장면: pts ≤ i/10초인 마지막 장면 (시간 단위 정수로 정확히 비교), 첫 장면보다 이르면 첫 장면
function sourceOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:format=start_time:frame=pts', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout), [num, den] = j.streams[0].time_base.split('/').map(Number), pts = j.frames.map(f => f.pts);
  assert.equal(+j.format.start_time, 0, `${file}: 파일 시작이 0초`);
  assert.ok(pts.every((v, k) => Number.isInteger(v) && (!k || v > pts[k - 1])), `${file}: 장면 pts가 차례로 커짐`);
  const sec = v => (v * num) / den;
  return { n: pts.length, first: sec(pts[0]), last: sec(pts[pts.length - 1]), at: i => { let k = 0; while (k + 1 < pts.length && pts[k + 1] * num * 10 <= i * den) k++; return k; } };
}

test.before(() => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futsal-frames-'));
  encode(p('p30.mp4'), '30', Array.from({ length: 60 }, (_, k) => numbered(k)), SW, SH);
  encode(p('p25.mp4'), '25', Array.from({ length: 50 }, (_, k) => numbered(k)), SW, SH);
  encode(p('ntsc.mp4'), '30000/1001', Array.from({ length: 60 }, (_, k) => numbered(k)), SW, SH);
  // 영상이 소리보다 1/15초 늦게 시작하는 mp4 (소리는 0초부터)
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-itsoffset', (1 / 15).toFixed(6), '-i', p('p30.mp4'),
    '-map', '1:v', '-map', '0:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', p('late.mp4')]);
  assert.equal(r.status, 0, String(r.stderr));
});
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('v2 장면 대응: 30·25·29.97fps·늦게 시작하는 mp4에서 도구의 장면 i = pts ≤ i/10초인 마지막 장면 (첫 장면보다 이르면 첫 장면)', { skip }, async () => {
  for (const [file, head] of [
    ['p30.mp4', [0, 3, 6, 9, 12]], // 장면이 칸 시각에 딱 맞음 → 그 장면 (예전엔 한 장 뒤 1, 4, 7, …)
    ['p25.mp4', [0, 2, 5, 7, 10]], // 0.08초·0.2초·0.28초… (0/−20ms 번갈아)
    ['ntsc.mp4', [0, 2, 5, 8, 11]], // 칸 시각보다 0~33ms 이른 장면
    ['late.mp4', [0, 1, 4, 7, 10]], // 0초 칸은 첫 장면 전이라 첫 장면(1/15초), 0.1초 칸은 1/15+1/30 = 0.1초 장면
  ]) {
    const s = sourceOf(p(file)), got = await decodedNumbers(p(file), 'classical-v2');
    if (file === 'late.mp4') assert.ok(Math.abs(s.first - 1 / 15) < 1e-3, `늦게 시작: 첫 장면 ${s.first}초`);
    else assert.equal(s.first, 0);
    assert.deepEqual(got.slice(0, head.length), head, `${file} 앞 칸`);
    assert.deepEqual(got, got.map((_, i) => s.at(i)), `${file} 모든 칸`);
    // 칸은 마지막 장면 시각까지 빠짐없이 (영상 끝 시각의 칸은 없을 수 있음: 30fps 60장이면 0~1.9초 20칸)
    assert.ok(got.length >= Math.floor(s.last * 10) + 1 && got.length <= Math.ceil(s.last * 10) + 2, `${file}: 칸 ${got.length}개 (마지막 장면 ${s.last}초)`);
  }
});

test('v1은 예전 디코딩 그대로: 필터 글자가 그대로이고 30fps면 칸 i에 원본 3i+1 장면 (v2만 바뀜)', { skip }, async () => {
  assert.equal(frameFilter('classical-v1', 320, 180), 'fps=10,scale=320:180'); // 636586b까지 쓰던 필터 글자 그대로
  assert.equal(frameFilter('classical-v2', 320, 180), 'fps=10:round=up:start_time=0,scale=320:180');
  assert.deepEqual((await decodedNumbers(p('p30.mp4'), 'classical-v1')).slice(0, 5), [1, 4, 7, 10, 13]);
});

test('명령 실행: 30fps 영상에서 v2 결과의 칸 i = 원본 3i 장면, v1은 3i+1, Ctrl+C → --resume 이어 하기도 같은 대응·같은 결과', { skip }, async () => {
  // 320×180 초록 바닥 위를 빨강 아이(18×26)가 장면마다 2px씩 오른쪽으로 감 → 자리로 원본 장면 번호를 읽음
  const W = 320, H = 180, N = 90, frames = [];
  for (let k = 0; k < N; k++) {
    const f = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) f.set([0x2f, 0x7d, 0x5b], 3 * i);
    for (let y = 80; y < 106; y++) for (let x = 40 + 2 * k; x < 58 + 2 * k; x++) f.set([220, 20, 20], 3 * (y * W + x));
    frames.push(f);
  }
  encode(p('run30.mp4'), '30', frames, W, H);
  const b = binaries(), info = await probeVideo(p('run30.mp4'), b);
  const { bg } = await buildBackground({ ffmpeg: b.ffmpeg, video: p('run30.mp4'), duration: info.duration, W, H });
  let one;
  await decodeFrames({ ffmpeg: b.ffmpeg, W, H, args: ['-ss', '1', '-i', p('run30.mp4'), '-frames:v', '1', '-vf', `scale=${W}:${H}`], onFrame: f => { one = new Uint8ClampedArray(f); return false; } });
  const team = colorFromClick(one, bg, W, H, 109, 93, 5); // 1초(원본 30번) 장면의 아이 가운데
  assert.ok(team, '팀 색을 잡음');
  const job = parseAnalysisJob({ app: 'futsal-coach-job', version: 1, session: { title: '시각 시험', date: '2026-11-17', groupId: 'g1' },
    config: { width: W, height: H, corners: [[0, 0], [W, 0], [W, H], [0, H]], court: [32, 18], teams: [{ name: '빨강', ...team }] } });
  fs.writeFileSync(p('job30.json'), JSON.stringify(job));
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
  const result = f => parseAnalysisFile(JSON.parse(fs.readFileSync(p(f), 'utf8')));
  // 칸마다 보인 자리 → 원본 장면 번호 (자리 x = (40 + 2k + 8.5)px ÷ 10px/m)
  const sourceFrames = R => {
    const pl = R.result.players[0], ks = [];
    for (let i = 0; i < pl.hidden.length; i++) {
      if (pl.hidden[i]) continue;
      const k = (pl.path[2 * i] - 4.85) / 0.2;
      assert.ok(Math.abs(k - Math.round(k)) < 0.1, `칸 ${i}: 자리 ${pl.path[2 * i]}m가 장면 자리와 안 맞음`);
      ks.push([i, Math.round(k)]);
    }
    assert.ok(ks.length >= 0.9 * pl.hidden.length, `보인 칸 ${ks.length}/${pl.hidden.length}`);
    return ks;
  };

  const v2 = run(['run30.mp4', 'job30.json', 'a.json']);
  assert.equal(v2.status, 0, v2.stderr);
  const A = result('a.json');
  assert.equal(A.analysis.engine, 'classical-v2');
  assert.equal(A.analysis.detectVersion, 4);
  for (const [i, k] of sourceFrames(A)) assert.equal(k, Math.min(3 * i, N - 1), `v2 칸 ${i}`);

  const v1 = run(['run30.mp4', 'job30.json', 'b.json', '--engine', 'classical-v1']);
  assert.equal(v1.status, 0, v1.stderr);
  for (const [i, k] of sourceFrames(result('b.json'))) assert.equal(k, Math.min(3 * i + 1, N - 1), `v1 칸 ${i}`);

  // 8번째 장면 뒤에 멈춤 → 이어 하기: 앞 장면은 같은 필터로 읽고 건너뜀 → 같은 장면 대응, 끊김 없이 돈 것과 같은 결과
  assert.equal(run(['run30.mp4', 'job30.json', 'c.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '7' }).status, 130);
  const cont = run(['run30.mp4', 'job30.json', 'c.json', '--resume']);
  assert.equal(cont.status, 0, cont.stderr);
  const Cr = result('c.json');
  assert.equal(Cr.analysis.resumed, true);
  assert.deepEqual(Cr.result, A.result);
  for (const [i, k] of sourceFrames(Cr)) assert.equal(k, Math.min(3 * i, N - 1), `이어 한 v2 칸 ${i}`);
});
