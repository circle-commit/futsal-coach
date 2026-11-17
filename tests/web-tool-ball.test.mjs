// node --test tests/
// 웹 분석 경로(js/worker.js → analyzer.detFromWorker → pipeline.analyzeFrames)와 로컬 분석 도구(tools/analyze.mjs)가 같은 장면에서
// 같은 검출 줄·같은 결과인지 (classical-v2, 검출 버전 4의 공 후보 넓이와 공 크기 비용 포함). ffmpeg·ffprobe가 없으면 건너뜀.
// 합성 영상(무손실): 480×270(15px/m), 30fps, 4초(40장). 초록 바닥 위 빨강 둘·파랑 하나가 천천히 걷고, 흰 공이 가운데 띠에서 빠르게(초속 6m 남짓) 오감
// 웹 쪽: worker.js를 node에서 그대로 불러 analyzer.js와 같은 순서로 메시지(background → body → init → frame)를 보내고, det는 analyzer.js가
//   쓰는 detFromWorker로 모아 analyzeFrames. 장면은 도구가 읽는 것과 같게(빈 코트 30장 = 도구 buildBackground와 같은 -ss, 검출 = frameFilter)
// 도구 쪽: ① 보통 작업 설정 — 9번째 장면 뒤 Ctrl+C → --resume으로 끝까지 → 결과 비교
//   ② 40장 전부 줄 비교 — 파랑 인원을 9명으로 적은 작업 설정(인원은 검출에 안 쓰임): 검출을 다 마친 뒤 추적이 '한꺼번에 보이는 장면이 없어요'로
//      멈춰 중간 저장(검출 줄 전부)이 남는다 (성공하면 지워지고, 마지막 장면에서 Ctrl+C를 흉내 내면 ffmpeg가 끝나는 것과 겨뤄 결과가 흔들림)
// 배포 직후 캐시 섞임: 새 pipeline.js + 옛 track.js(ballSize 없음)도 모듈 오류 없이 불러지고 예전 공 고르기로 돎
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFrames, buildBackground, binaries, probeVideo, frameFilter, BG_FRAMES, FPS } from '../tools/local-analysis.mjs';
import { colorFromClick } from '../js/vision.js';
import { analyzeFrames, areaScale } from '../js/pipeline.js';
import { ballSize, trackBall, resample } from '../js/track.js';
import { detFromWorker } from '../js/analyzer.js';
import { parseAnalysisJob, parseAnalysisFile } from '../js/analysis-file.js';

const CLI = fileURLToPath(new URL('../tools/analyze.mjs', import.meta.url));
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version']).status === 0);
const skip = hasFfmpeg ? false : 'ffmpeg·ffprobe가 없어 건너뜀';
const W = 480, H = 270, N = 120;
let dir = null;
const p = f => path.join(dir, f);

function makeVideo(file) {
  const frames = [];
  for (let k = 0; k < N; k++) {
    const f = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) f.set([0x2f, 0x7d, 0x5b], 3 * i);
    const box = (x0, y0, w, h, rgb) => { for (let y = Math.round(y0); y < Math.round(y0) + h; y++) for (let x = Math.round(x0); x < Math.round(x0) + w; x++) f.set(rgb, 3 * (y * W + x)); };
    box(60 + k, 40, 14, 20, [220, 20, 20]); box(300 - 0.8 * k, 50, 14, 20, [220, 20, 20]); box(150 + 0.6 * k, 205, 14, 20, [30, 60, 230]);
    const u = (3.2 * k) % 640, bx = 70 + (u < 320 ? u : 640 - u), by = 135 + 25 * Math.sin(k / 9); // 공: 가운데 띠를 오감 (한 장면 3.2px ≈ 초속 6.4m)
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 6.5) f.set([255, 255, 255], 3 * ((Math.round(by) + y) * W + Math.round(bx) + x));
    frames.push(f);
  }
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', '-', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', file], { input: Buffer.concat(frames), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
}

test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futsal-webtool-'));
  makeVideo(p('v.mp4'));
});
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('웹 분석 경로(워커 → detFromWorker → analyzeFrames)와 로컬 분석 도구가 같은 장면에서 40장 전부 같은 검출 줄(공 줄 넓이 포함)·같은 결과 (공 크기 비용이 켜진 영상)', { skip }, async () => {
  const b = binaries(), info = await probeVideo(p('v.mp4'), b);
  // 팀 색: 웹처럼 빈 코트 + 1초 장면에서 아이를 누른 자리
  const { bg: bg0 } = await buildBackground({ ffmpeg: b.ffmpeg, video: p('v.mp4'), duration: info.duration, W, H });
  let one;
  await decodeFrames({ ffmpeg: b.ffmpeg, W, H, args: ['-ss', '1', '-i', p('v.mp4'), '-frames:v', '1', '-vf', `scale=${W}:${H}`], onFrame: f => { one = new Uint8ClampedArray(f); return false; } });
  const red = colorFromClick(one, bg0, W, H, 97, 50, 5), blue = colorFromClick(one, bg0, W, H, 175, 215, 5);
  assert.ok(red && blue, '팀 색을 잡음');
  const jobOf = (blueCount) => parseAnalysisJob({ app: 'futsal-coach-job', version: 1, session: { title: '웹·도구 시험', date: '2026-11-17', groupId: 'g1' },
    config: { width: W, height: H, corners: [[0, 0], [W, 0], [W, H], [0, H]], court: [32, 18], teams: [{ name: '빨강', ...red }, { name: '파랑', ...blue, ...(blueCount ? { count: blueCount } : {}) }] } });
  const job = jobOf(), cfg = job.config;
  fs.writeFileSync(p('job.json'), JSON.stringify(job));
  fs.writeFileSync(p('job9.json'), JSON.stringify(jobOf(9)));

  // 웹: worker.js를 그대로 불러 메시지로 (postMessage는 바로 모아 둠), det는 analyzer.js의 detFromWorker로
  const inbox = [];
  globalThis.postMessage = m => inbox.push(m);
  globalThis.onmessage = null;
  await import('../js/worker.js');
  const send = data => { inbox.length = 0; globalThis.onmessage({ data }); const m = inbox[0]; assert.ok(m && m.type !== 'error', m?.message); return m; };
  const shots = []; // 도구 buildBackground와 같은 장면 (영상 전체에서 고르게 30장)
  for (let k = 0; k < BG_FRAMES; k++) {
    const t = (info.duration * (k + 0.5)) / BG_FRAMES;
    await decodeFrames({ ffmpeg: b.ffmpeg, W, H, args: ['-ss', t.toFixed(3), '-i', p('v.mp4'), '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${W}:${H}`], onFrame: f => { shots.push(new Uint8ClampedArray(f)); return false; } });
  }
  const bg = new Uint8ClampedArray(send({ type: 'background', frames: shots.map(f => f.slice().buffer) }).bg);
  assert.deepEqual(bg, bg0, '빈 코트가 도구와 같음');
  const { bodyPx } = send({ type: 'body', frames: shots.map(f => f.slice().buffer), cfg, bg: bg.slice().buffer });
  assert.equal(send({ type: 'init', cfg, bg: bg.slice().buffer, bodyPx }).type, 'ready');
  const dets = [];
  await decodeFrames({ ffmpeg: b.ffmpeg, W, H, args: ['-i', p('v.mp4'), '-map', '0:v:0', '-vf', frameFilter('classical-v2', W, H)], onFrame: (f, i) => {
    const m = send({ type: 'frame', t: i / FPS, buf: new Uint8ClampedArray(f).buffer });
    dets.push(detFromWorker(m)); // analyzer.js runAnalysis와 같은 함수
  } });
  assert.equal(dets.length, 40, '4초 = 40장');
  assert.ok(dets.filter(d => d.ball.some(r => r[2] === 1 && r[3] > 0)).length >= 20, '혼자 떨어진 공 후보(넓이 칸 포함)가 여러 장면에 있음');
  const am = ballSize(dets, cfg.court, areaScale(cfg));
  assert.ok(am > 0, `공 넓이를 잼 (공 크기 비용이 켜짐): ${am}`);

  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
  // 도구 ②: 40장 전부 줄 비교 (파랑 인원 9명 → 검출을 다 마친 뒤 추적이 멈춰 검출 줄이 남음)
  const stuck = run(['v.mp4', 'job9.json', 'all.json']);
  assert.equal(stuck.status, 1, stuck.stderr);
  assert.match(stuck.stderr, /분석하지 못했어요: '파랑' 팀 아이 9명이 코트 안에서 한꺼번에 보이는 장면이 없어요/);
  const lines = fs.readFileSync(p('all.json.work/detections.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, dets.length, '도구도 40장 전부 검출');
  assert.ok(lines.every(d => d.ball.every(r => r.length === 4 && r[3] > 0)), 'v2 검출 기록의 공 줄은 4칸·넓이 > 0');
  lines.forEach(({ i, ...d }) => assert.deepEqual(dets[i], d, `${i}번째 장면 검출 줄`)); // i 칸만 도구에 더 있음

  // 도구 ①: 보통 작업 설정, 9번째 장면 뒤 Ctrl+C → --resume으로 끝까지 → 웹 경로 결과와 같음
  assert.equal(run(['v.mp4', 'job.json', 'r.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '8' }).status, 130);
  const cont = run(['v.mp4', 'job.json', 'r.json', '--resume']);
  assert.equal(cont.status, 0, cont.stderr);
  const tool = parseAnalysisFile(JSON.parse(fs.readFileSync(p('r.json'), 'utf8')));
  assert.equal(tool.analysis.engine, 'classical-v2');
  assert.equal(tool.analysis.detectVersion, 4);
  assert.equal(tool.analysis.resumed, true);
  assert.deepEqual(analyzeFrames(dets, cfg), tool.result);
});

test('배포 직후 캐시 섞임: 새 pipeline.js와 옛 track.js(ballSize를 안 내보냄)가 만나도 모듈 오류 없이 불러지고 예전 공 고르기로 돎', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'futsal-oldtrack-'));
  try {
    for (const f of ['pipeline.js', 'vision.js', 'track.js']) fs.copyFileSync(fileURLToPath(new URL(`../js/${f}`, import.meta.url)), path.join(tmp, f));
    const src = fs.readFileSync(path.join(tmp, 'track.js'), 'utf8');
    assert.equal(src.split('export function ballSize(').length, 2);
    fs.writeFileSync(path.join(tmp, 'track.js'), src.replace('export function ballSize(', 'function ballSize(')); // 옛 track.js 흉내: ballSize를 안 내보냄
    const old = await import(pathToFileURL(path.join(tmp, 'pipeline.js')).href); // 이름으로 가져오면 여기서 SyntaxError
    const cfg = { width: 640, height: 360, corners: [[0, 0], [640, 0], [640, 360], [0, 360]], court: [32, 18], teams: [{ name: '빨강', color: '#ff0000', hue: [350, 10], sat: [100, 255] }] };
    // 앞 3초 혼자 빠르게 구르는 공 크기 점(공 넓이를 잴 수 있음), 뒤 1초 아이 발밑 공 + 옆의 신발 끝 크기 혼자 점
    const area = 0.11 * 400, dets = Array.from({ length: 40 }, (_, i) => ({ t: i / 10, players: [[[10, 4]]],
      ball: i < 30 ? [[2 + 0.4 * i, 9, 1, area]] : [[2 + 0.4 * i, 9, 0, area], [2 + 0.4 * i, 9.5, 1, 0.2 * area]] }));
    const R = old.analyzeFrames(dets, cfg), now = analyzeFrames(dets, cfg);
    const r2 = a => Array.from(a, v => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));
    assert.deepEqual(R.ball, r2(resample(dets.map(d => d.t), trackBall(dets), 0.1)), '옛 track.js면 크기 비용 없이 예전 공 고르기');
    assert.notDeepEqual(R.ball, now.ball, '새 track.js면 크기 비용 (이 장면에선 공 자리가 다름)');
    assert.deepEqual(R.players, now.players, '선수는 그대로');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
