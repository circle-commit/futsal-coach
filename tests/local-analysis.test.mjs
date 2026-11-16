// node --test tests/
// 로컬 분석 명령(tools/analyze.mjs) 시험: 합성 영상으로 실제 ffmpeg를 돌린다 (ffmpeg·ffprobe가 없으면 건너뜀).
// 작업 설정 → 결과 파일, Ctrl+C 중단 → --resume 이어 하기가 끊김 없이 돈 결과와 같은지, 바뀐 영상·설정 거부, 잘못된 ffmpeg 안내,
// 경로 겹침 거부, 선수 없음 실패와 원래 결과 파일 보호, 예전 분석 설정(cfg) 입력 유지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackground, decodeFrames, binaries, probeVideo } from '../tools/local-analysis.mjs';
import { colorFromClick } from '../js/vision.js';
import { parseAnalysisJob, parseAnalysisFile } from '../js/analysis-file.js';

const CLI = fileURLToPath(new URL('../tools/analyze.mjs', import.meta.url));
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version']).status === 0);
const skip = hasFfmpeg ? false : 'ffmpeg·ffprobe가 없어 건너뜀';
const W = 320, H = 180, k = W / 640;
let dir = null, job = null, base = null; // base: 끊김 없이 돈 결과

// 640×360 기준으로 그린 뒤 320×180으로 줄인 12초 영상: 초록 바닥 위를 움직이는 빨강 2·파랑 2 (속도 sp배)
function makeVideo(file, { players = true, sp = 1 } = {}) {
  const red = 'color=c=red:s=18x26:r=10:d=12', blue = 'color=c=blue:s=18x26:r=10:d=12';
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f7d5b:s=640x360:r=10:d=12'];
  const fc = players
    ? ['-f', 'lavfi', '-i', red, '-f', 'lavfi', '-i', blue, '-filter_complex',
      `[1]split[r1][r2];[2]split[b1][b2];[0][r1]overlay=x='100+${20 * sp}*t':y=120[a];[a][r2]overlay=x='420-${15 * sp}*t':y=200[b];` +
      `[b][b1]overlay=x='200+${10 * sp}*t':y=250[c];[c][b2]overlay=x='520-${12 * sp}*t':y=90,scale=${W}:${H}`]
    : ['-vf', `scale=${W}:${H}`];
  const r = spawnSync('ffmpeg', [...args, ...fc, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '12', file]);
  assert.equal(r.status, 0, String(r.stderr));
}
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
const p = f => path.join(dir, f);
const read = f => JSON.parse(fs.readFileSync(p(f), 'utf8'));
const lines = f => fs.readFileSync(p(f), 'utf8').split('\n').filter(Boolean).length;

test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futsal-cli-'));
  makeVideo(p('v.mp4'));
  // 웹과 같은 방법으로 팀 색 잡기: 빈 코트 중앙값 + 5초 장면에서 아이를 누른 자리
  const b = binaries(), info = await probeVideo(p('v.mp4'), b);
  const { bg } = await buildBackground({ ffmpeg: b.ffmpeg, video: p('v.mp4'), duration: info.duration, W, H });
  let frame;
  await decodeFrames({ ffmpeg: b.ffmpeg, W, H, args: ['-ss', '5', '-i', p('v.mp4'), '-frames:v', '1', '-vf', `scale=${W}:${H}`], onFrame: f => { frame = new Uint8ClampedArray(f); return false; } });
  const pick = (x, y) => colorFromClick(frame, bg, W, H, Math.round(x * k), Math.round(y * k), 5);
  job = parseAnalysisJob({ app: 'futsal-coach-job', version: 1, session: { title: '시험 수업', date: '2026-11-14', groupId: 'g1' }, sourceName: '원본 영상.mp4',
    config: { width: W, height: H, corners: [[40 * k, 30 * k], [600 * k, 30 * k], [600 * k, 330 * k], [40 * k, 330 * k]], court: [40, 20],
      teams: [{ name: '빨강', ...pick(209, 133) }, { name: '파랑', ...pick(259, 263) }] } });
  fs.writeFileSync(p('job.json'), JSON.stringify(job));
});
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('도움말: --help는 사용법을 보여 주고 0으로 끝남', { skip }, () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /node tools\/analyze\.mjs <영상 파일> <작업 설정 파일\.json> <결과 파일\.json> \[--resume\] \[--engine 이름\]/);
  const bad = run(['--모름']);
  assert.equal(bad.status, 2);
});

test('작업 설정 → 결과 파일: 웹이 읽는 형식, 세션·원본 이름·분석 정보, 배경 30장 이하, 중간 저장 폴더 정리', { skip }, () => {
  const r = run(['v.mp4', 'job.json', 'out.json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = read('out.json'), R = parseAnalysisFile(doc);
  assert.deepEqual(R.session, job.session);
  assert.deepEqual(R.result.counts, [2, 2]);
  assert.equal(R.result.players.length, 4);
  assert.equal(R.result.dt, 0.1);
  assert.equal(R.analysis.engine, 'classical-v2'); // 기본값
  assert.equal(R.analysis.sourceName, '원본 영상.mp4'); // 작업 설정의 원본 이름
  assert.equal(R.analysis.frames, 120);
  assert.ok(R.analysis.backgroundFrames > 0 && R.analysis.backgroundFrames <= 30, String(R.analysis.backgroundFrames));
  assert.equal(R.analysis.resumed, false);
  assert.equal(fs.existsSync(p('out.json.work')), false, '성공하면 중간 저장 폴더를 정리');
  base = doc;
});

test('Ctrl+C 중단 → --resume: 쓰다 만 마지막 줄을 버리고 이어서, 끊김 없이 돈 것과 같은 결과', { skip }, () => {
  assert.ok(base, '앞 시험(끊김 없는 실행)이 먼저 돌아야 함');
  const stop = run(['v.mp4', 'job.json', 'r.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '37' });
  assert.equal(stop.status, 130, stop.stderr);
  assert.match(stop.stderr, /--resume/);
  assert.equal(fs.existsSync(p('r.json')), false, '멈추면 결과 파일을 만들지 않음');
  const n = lines('r.json.work/detections.jsonl');
  assert.ok(n >= 38 && n < 120, `저장된 검출 ${n}장`);
  assert.equal(read('r.json.work/state.json').stage, 'detect');
  fs.appendFileSync(p('r.json.work/detections.jsonl'), '{"i":999,"t":99.9,"players":[[[1,'); // 쓰다 만 줄 (전원이 나간 셈)

  const again = run(['v.mp4', 'job.json', 'r.json']); // --resume 없이는 거부, 기록은 그대로
  assert.equal(again.status, 2);
  assert.match(again.stderr, /--resume/);
  assert.equal(lines('r.json.work/detections.jsonl'), n + 1);

  const res = run(['v.mp4', 'job.json', 'r.json', '--resume']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, new RegExp(`검출한 장면 ${n}장을 불러왔어요 \\(쓰다 만 마지막 줄`));
  const doc = read('r.json');
  assert.deepEqual(doc.result, base.result, '이어 한 결과 = 끊김 없이 돈 결과');
  assert.deepEqual(doc.session, base.session);
  assert.equal(doc.analysis.resumed, true);
  assert.equal(fs.existsSync(p('r.json.work')), false);
});

test('이어 하기 거부: 영상이 바뀌었거나 작업 설정이 바뀌면 멈춘 기록을 건드리지 않고 알려 줌', { skip }, () => {
  fs.copyFileSync(p('v.mp4'), p('c.mp4'));
  assert.equal(run(['c.mp4', 'job.json', 'c.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  const before = fs.readFileSync(p('c.json.work/detections.jsonl'));
  makeVideo(p('c.mp4'), { sp: 1.5 }); // 같은 이름, 다른 내용
  const r = run(['c.mp4', 'job.json', 'c.json', '--resume']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /처음 분석하던 영상과 달라요/);
  assert.equal(fs.existsSync(p('c.json')), false);
  assert.deepEqual(fs.readFileSync(p('c.json.work/detections.jsonl')), before);

  fs.copyFileSync(p('v.mp4'), p('c.mp4')); // 영상은 되돌리고 설정을 바꿈
  fs.writeFileSync(p('job2.json'), JSON.stringify({ ...job, config: { ...job.config, court: [38, 20] } }));
  const r2 = run(['c.mp4', 'job2.json', 'c.json', '--resume']);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /작업 설정\(코트·팀 색 등\)이 처음과 달라요/);
  const ok = run(['c.mp4', 'job.json', 'c.json', '--resume']); // 원래 영상·설정이면 이어서 끝남
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(read('c.json').result, base.result);
});

test('ffmpeg·ffprobe가 없거나 잘못되면 설치 안내와 함께 2로 끝남', { skip }, () => {
  const a = run(['v.mp4', 'job.json', 'e.json'], { FFMPEG: '/없는/경로/ffmpeg' });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /ffmpeg\(\/없는\/경로\/ffmpeg\)를 찾을 수 없거나 실행할 수 없어요.*설치/s);
  const b = run(['v.mp4', 'job.json', 'e.json'], { FFPROBE: '/없는/경로/ffprobe' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /ffprobe\(\/없는\/경로\/ffprobe\)를 찾을 수 없거나/);
  const c = run(['v.mp4', 'job.json', 'e.json'], { FFMPEG: process.execPath }); // ffmpeg가 아닌 프로그램
  assert.equal(c.status, 2);
  assert.match(c.stderr, /ffmpeg가 아닌 것 같아요|ffmpeg\(.*\)를 실행하지 못했어요/);
  assert.equal(fs.existsSync(p('e.json')) || fs.existsSync(p('e.json.work')), false);
});

test('경로 겹침 거부: 결과가 입력과 같거나, 중간 저장 폴더 자리가 입력과 겹치면 아무것도 쓰지 않음', { skip }, () => {
  const jobBefore = fs.readFileSync(p('job.json'), 'utf8');
  for (const args of [['v.mp4', 'job.json', 'job.json'], ['v.mp4', 'job.json', 'v.mp4'], ['v.mp4', 'v.mp4', 'x.json']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /같아요|같은 파일/);
  }
  fs.copyFileSync(p('v.mp4'), p('w.json.work')); // 결과 w.json의 중간 저장 폴더 자리에 입력 영상
  const r = run(['w.json.work', 'job.json', 'w.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /중간 저장 폴더/);
  assert.equal(fs.readFileSync(p('job.json'), 'utf8'), jobBefore);
});

test('선수 없음은 분명한 실패(1)이고, 원래 있던 결과 파일은 그대로', { skip }, () => {
  makeVideo(p('empty.mp4'), { players: false });
  fs.writeFileSync(p('prev.json'), '원래 결과');
  const r = run(['empty.mp4', 'job.json', 'prev.json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /선수/);
  assert.equal(fs.readFileSync(p('prev.json'), 'utf8'), '원래 결과');
});

test('화면 비율이 다른 영상은 거부 (다른 영상으로 만든 작업 설정)', { skip }, () => {
  const k2 = 1; // 640×480 설정
  fs.writeFileSync(p('job43.json'), JSON.stringify({ ...job, config: { ...job.config, width: 640, height: 480, corners: [[40 * k2, 30 * k2], [600, 30], [600, 450], [40, 450]] } }));
  const r = run(['v.mp4', 'job43.json', 'a.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /화면 비율/);
});

test('예전 방식: 분석 설정(cfg)만 주면 분석 결과(result)만 저장 (결과 파일 생략 가능)', { skip }, () => {
  fs.writeFileSync(p('cfg.json'), JSON.stringify(job.config));
  const r = run(['v.mp4', 'cfg.json', 'raw.json']);
  assert.equal(r.status, 0, r.stderr);
  const raw = read('raw.json');
  assert.equal(raw.app, undefined);
  assert.deepEqual(raw, base.result, '같은 설정이면 작업 설정으로 돈 결과의 result와 같음');
  const noOut = run(['v.mp4', 'cfg.json']);
  assert.equal(noOut.status, 0, noOut.stderr);
  assert.match(noOut.stdout, /인원 2\/2/);
});

test('이어 하기 보호: 중간 저장 파일이 하드 링크·폴더가 심볼릭 링크면 거부하고 원본은 그대로', { skip }, () => {
  assert.equal(run(['v.mp4', 'job.json', 'h.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  fs.copyFileSync(p('v.mp4'), p('h-src.mp4'));
  const orig = fs.readFileSync(p('h-src.mp4'));
  fs.rmSync(p('h.json.work/detections.jsonl'));
  fs.linkSync(p('h-src.mp4'), p('h.json.work/detections.jsonl')); // 검출 기록 자리에 영상의 하드 링크 (자르면 영상이 망가짐)
  const r = run(['h-src.mp4', 'job.json', 'h.json', '--resume']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /링크이거나 다른 파일과 이어져|같은 파일이에요/);
  assert.deepEqual(fs.readFileSync(p('h-src.mp4')), orig, '원본 영상이 그대로');

  fs.mkdirSync(p('real-work'));
  fs.symlinkSync(p('real-work'), p('s.json.work'));
  const s = run(['v.mp4', 'job.json', 's.json', '--resume']);
  assert.equal(s.status, 2);
  assert.match(s.stderr, /링크\(바로 가기\)/);
  assert.deepEqual(fs.readdirSync(p('real-work')), []);
});

test('이어 하기 보호: 중간 줄의 값이 깨졌으면(숫자 아님·칸 수 틀림) 이어 하지 않고 알려 줌', { skip }, () => {
  assert.equal(run(['v.mp4', 'job.json', 'm.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  const f = p('m.json.work/detections.jsonl'), ls = fs.readFileSync(f, 'utf8').split('\n');
  const d = JSON.parse(ls[2]); d.players[0] = [[1, 'x']]; ls[2] = JSON.stringify(d); // 3번째 줄: 좌표가 글자
  fs.writeFileSync(f, ls.join('\n'));
  const r = run(['v.mp4', 'job.json', 'm.json', '--resume']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /3번째 줄이 깨졌어요/);
  assert.equal(fs.existsSync(p('m.json')), false);
});

test('성공 뒤 정리는 이 도구의 관리 파일만: 작업 폴더의 다른 파일은 남기고 폴더도 남김', { skip }, () => {
  assert.equal(run(['v.mp4', 'job.json', 'k.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  fs.writeFileSync(p('k.json.work/메모.txt'), '내 메모');
  const r = run(['v.mp4', 'job.json', 'k.json', '--resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(p('k.json.work')), ['메모.txt']);
});

test('영상 스트림이 여럿이면 첫 번째(ffprobe가 본 것)를 분석 (-map 0:v:0)', { skip }, () => {
  makeVideo(p('blank.mp4'), { players: false });
  const big = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', p('blank.mp4'), '-vf', 'scale=640:360', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('blank-big.mp4')]);
  assert.equal(big.status, 0, String(big.stderr));
  // 0번 = 선수 영상(320×180), 1번 = 빈 코트(640×360, ffmpeg가 기본으로 고르는 더 큰 화면)
  const mux = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', p('v.mp4'), '-i', p('blank-big.mp4'), '-map', '0:v', '-map', '1:v', '-c', 'copy', p('two.mp4')]);
  assert.equal(mux.status, 0, String(mux.stderr));
  const r = run(['two.mp4', 'job.json', 'two.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read('two.json').result, base.result);
});

test('다른 용도의 폴더(이 도구의 state.json 없음)·그 안의 lock은 --resume이어도 일절 건드리지 않음', { skip }, () => {
  const snap = d => Object.fromEntries(fs.readdirSync(d).sort().map(f => [f, fs.readFileSync(path.join(d, f), 'utf8')]));
  fs.mkdirSync(p('f.json.work'));
  fs.writeFileSync(p('f.json.work/lock'), '12345'); // 다른 프로그램의 잠금 (그 프로세스는 없음)
  fs.writeFileSync(p('f.json.work/자료.txt'), '다른 용도');
  const before = snap(p('f.json.work'));
  for (const args of [['v.mp4', 'job.json', 'f.json', '--resume'], ['v.mp4', 'job.json', 'f.json']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(snap(p('f.json.work')), before, `${args.join(' ')}: 폴더 내용 그대로`);
  }
  assert.match(run(['v.mp4', 'job.json', 'f.json', '--resume']).stderr, /중간 저장 기록이 아니거나/);
  fs.writeFileSync(p('f.json.work/state.json'), JSON.stringify({ tool: '다른-도구' })); // 다른 도구의 state
  const b2 = snap(p('f.json.work'));
  assert.equal(run(['v.mp4', 'job.json', 'f.json', '--resume']).status, 2);
  assert.deepEqual(snap(p('f.json.work')), b2);
  assert.equal(fs.existsSync(p('f.json')), false);
});

test('분석 방식(--engine): 모르는 이름 거부, v2로 끝까지, 다른 방식으로 이어 하기 거부, 결과 파일에 기록', { skip }, async t => {
  const bad = run(['v.mp4', 'job.json', 'g.json', '--engine', 'classical-v9']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /모르는 분석 방식\(--engine\)이에요: classical-v9/);
  assert.equal(fs.existsSync(p('g.json')) || fs.existsSync(p('g.json.work')), false);

  fs.writeFileSync(p('cfg2.json'), JSON.stringify(job.config)); // 예전 방식(결과만)은 결과 형식 검사 없이 v2로 끝까지
  const raw = run(['v.mp4', 'cfg2.json', 'raw2.json', '--engine=classical-v2']);
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(read('raw2.json').players.length, 4);

  assert.equal(run(['v.mp4', 'job.json', 'e2.json', '--engine', 'classical-v1'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130); // 비교용 v1로 시작
  assert.equal(read('e2.json.work/state.json').engine, 'classical-v1');
  const mix = run(['v.mp4', 'job.json', 'e2.json', '--resume', '--engine', 'classical-v2']);
  assert.equal(mix.status, 2);
  assert.match(mix.stderr, /처음 분석하던 방식\(classical-v1\)과 지금 고른 방식\(classical-v2\)이 달라요/);
  const cont = run(['v.mp4', 'job.json', 'e2.json', '--resume']); // --engine 없이 이어 하면 기록의 방식(v1)으로
  assert.equal(cont.status, 0, cont.stderr);
  assert.match(cont.stderr, /이어서 해요\(분석 방식 classical-v1\)/);
  assert.equal(read('e2.json').analysis.engine, 'classical-v1');

  // 방식 기록이 없는 예전 중간 저장(v1 지문)도 --engine 없이 v1로 이어 짐
  assert.equal(run(['v.mp4', 'job.json', 'o1.json', '--engine', 'classical-v1'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  const st = read('o1.json.work/state.json'); delete st.engine; delete st.detect; // 방식·검출 버전 기록이 없던 때 fs.writeFileSync(p('o1.json.work/state.json'), JSON.stringify(st));
  const old = run(['v.mp4', 'job.json', 'o1.json', '--resume']);
  assert.equal(old.status, 0, old.stderr);
  assert.equal(read('o1.json').analysis.engine, 'classical-v1');

  // 작업 설정 → v2 결과 파일: 결과 형식 검사기(QA 담당)가 classical-v2를 받을 때만
  const v2ok = (() => { try { parseAnalysisFile({ ...base, analysis: { ...base.analysis, engine: 'classical-v2' } }); return true; } catch { return false; } })();
  if (!v2ok) { t.diagnostic('결과 형식 검사기가 아직 classical-v2를 받지 않아 작업 설정 v2 기록 확인은 건너뜀'); return; }
  const v2 = run(['v.mp4', 'job.json', 'v2.json', '--engine', 'classical-v2']);
  assert.equal(v2.status, 0, v2.stderr);
  assert.equal(parseAnalysisFile(read('v2.json')).analysis.engine, 'classical-v2');
});

test('검출 버전: 덩어리 나누기 전 v2 중간 저장은 안내와 함께 거부, 나누기 후보가 든 기록은 검사해서 이어 감', { skip }, () => {
  assert.equal(run(['v.mp4', 'job.json', 'd2.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130); // 기본(v2)
  const st = read('d2.json.work/state.json');
  assert.equal(st.engine, 'classical-v2');
  assert.equal(st.detect, 2);
  assert.ok(Array.isArray(st.bodyPx) && st.bodyPx.length === 2 && st.bodyPx.every(v => v > 0), `팀별 몸 크기 ${JSON.stringify(st.bodyPx)}`);

  // 나누기 후보가 든 줄: 맞는 후보는 받아들이고, 번호가 틀린 후보는 깨진 줄로 거부
  const f = p('d2.json.work/detections.jsonl'), ls = fs.readFileSync(f, 'utf8').split('\n');
  const good = JSON.parse(ls[3]); good.split = [[0, 0, [[good.players[0][0][0] - 0.2, good.players[0][0][1]], [good.players[0][0][0] + 0.2, good.players[0][0][1]]]]];
  fs.writeFileSync(f, [...ls.slice(0, 3), JSON.stringify(good), ...ls.slice(4)].join('\n'));
  const ok = run(['v.mp4', 'job.json', 'd2.json', '--resume']);
  assert.equal(ok.status, 0, ok.stderr);

  assert.equal(run(['v.mp4', 'job.json', 'd3.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  const f3 = p('d3.json.work/detections.jsonl'), l3 = fs.readFileSync(f3, 'utf8').split('\n');
  const bad = JSON.parse(l3[3]); bad.split = [[0, 9, [[1, 1], [2, 2]]]]; // 그 팀 players에 9번이 없음
  fs.writeFileSync(f3, [...l3.slice(0, 3), JSON.stringify(bad), ...l3.slice(4)].join('\n'));
  const r3 = run(['v.mp4', 'job.json', 'd3.json', '--resume']);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /4번째 줄이 깨졌어요/);

  // 나누기 전 도구로 만든 v2 중간 저장(검출 버전 기록 없음) → 이어 하지 않고 지운 뒤 다시 하라고 안내, 폴더는 그대로
  assert.equal(run(['v.mp4', 'job.json', 'd4.json'], { FUTSAL_ANALYZE_TEST_INTERRUPT_AT: '20' }).status, 130);
  const s4 = read('d4.json.work/state.json'); delete s4.detect; delete s4.bodyPx;
  fs.writeFileSync(p('d4.json.work/state.json'), JSON.stringify(s4));
  const before = fs.readFileSync(p('d4.json.work/detections.jsonl'));
  const r4 = run(['v.mp4', 'job.json', 'd4.json', '--resume']);
  assert.equal(r4.status, 2);
  assert.match(r4.stderr, /붙은 덩어리 나누기를 넣기 전 도구로 검출한 classical-v2 기록이라 이어 할 수 없어요.*지운 뒤 --resume 없이 다시 실행/s);
  assert.deepEqual(fs.readFileSync(p('d4.json.work/detections.jsonl')), before);
});
