// 로컬 분석 도구 본체 (node 전용). ffmpeg로 영상을 읽어 브라우저와 같은 분석 코드(pipeline·vision)를 돌린다. 영상은 이 컴퓨터 밖으로 나가지 않는다.
// - 배경: 영상 전체에서 고르게 최대 30장 → 픽셀별 중앙값 (장수가 영상 길이와 무관하게 유한)
// - 검출: 처음부터 10fps로 순서대로 디코딩(장면 i의 시각 = i/10초). 이어 하기 때도 처음부터 디코딩하되 이미 검출한 장면은 건너뜀
//   classical-v2의 장면 i = 브라우저가 currentTime i/10초에 보여 주는 장면 (frameFilter). classical-v1은 예전 디코딩 그대로
// - 중간 저장: 결과 파일 옆 <결과 파일>.work/ 에 state.json(원자 저장)·background.rgba(원자 저장)·detections.jsonl(주기적으로 덧붙임)
// - 이어 하기(--resume): 같은 영상(sha256·크기)·같은 설정(해시)일 때만. 쓰다 만 마지막 줄은 버리고 이어서
// - 결과: 원자 저장(임시 파일 → 이름 바꾸기). 실패하면 원래 있던 결과 파일은 그대로
// 원시 프레임은 쌓지 않는다(배경용 최대 30장만). 장면마다 검출 결과(m 좌표)만 남긴다.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setup, analyzeFrames, DT, ENGINES, DEFAULT_ENGINE } from '../js/pipeline.js';
import { medianBackground, detect, bodySizes } from '../js/vision.js';
import { validateAnalysisConfig, parseAnalysisJob, parseAnalysisFile, RESULT_APP, FILE_VERSION } from '../js/analysis-file.js';

export const TOOL_VERSION = 1;
// 검출 기록 버전 (classical-v2): 2 = 붙은 덩어리 나누기 후보(split) 추가, 3 = 색 없는 움직임 덩어리(uncol)·아이 한 명 몸덩어리 넓이(kidFg) 추가
// (조끼 색을 잠깐 놓친 아이 잇기), 4 = 장면 시각 맞추기(장면 i가 브라우저가 i/10초에 보여 주는 장면보다 한 장쯤 뒤이던 것을 바로잡음 → frameFilter)
// + 공 후보 줄 넷째 칸에 흰 점 넓이 px(공 크기 비용, track.ballSize·trackBall). 버전이 다른 v2 중간 저장은 섞지 않고 안내 후 거절.
// v1 검출은 예전 그대로(1, 공 줄 3칸)라 예전 v1 중간 저장도 이어 할 수 있다
export const DETECT_VERSION = 4;
const detectVersionOf = engine => (engine === 'classical-v1' ? 1 : DETECT_VERSION);
const DETECT_BEFORE = { 1: '붙은 덩어리 나누기를 넣기 전', 2: '조끼 색을 잠깐 놓친 아이 잇기를 넣기 전', 3: '장면 시각 맞추기를 넣기 전' }; // 예전 v2 검출 기록 버전마다 빠진 것 (거절 안내용)
export const FPS = Math.round(1 / DT); // 10 (결과 격자와 같음)
/** 검출용 디코딩 필터 (처음부터 순서대로 읽어 출력 i번째 = 장면 i, 시각 i/10초).
 * classical-v2: 장면 i = 브라우저가 currentTime i/10초에 보여 주는 장면 = pts ≤ i/10초인 마지막 장면 (첫 장면보다 이르면 첫 장면).
 *   round=up: 장면 시각을 칸 번호로 올려 칸 i에 그 칸 시각 이하의 마지막 장면을 냄 (기본 round=near는 i/10+0.05초보다 이른 마지막 장면 → 30fps면 한 장(33ms) 뒤)
 *   start_time=0: 첫 칸을 0초로 고정 (영상이 소리보다 늦게 시작해도 칸 번호가 밀리지 않고, 첫 장면 전 칸은 첫 장면)
 * classical-v1: 예전 그대로 (v1 결과와 v1 중간 저장 이어 하기를 바꾸지 않음) */
export const frameFilter = (engine, W, H) => `fps=${FPS}${engine === 'classical-v1' ? '' : ':round=up:start_time=0'},scale=${W}:${H}`;
export const BG_FRAMES = 30;
const FLUSH_EVERY = 50; // 검출 50장(영상 5초)마다 중간 저장
const STATE = 'state.json', BG = 'background.rgba', DETS = 'detections.jsonl', LOCK = 'lock';
const OUR_FILES = [STATE, BG, DETS, LOCK]; // 정리할 때 이것만 지운다 (작업 폴더의 다른 파일은 건드리지 않음)

/** 사용자에게 그대로 보여 줄 오류. code: 1 분석 실패 · 2 사용법·환경·파일 문제 · 130 멈춤 */
export class ToolError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
const abortError = () => new ToolError('멈췄어요', 130);

export const USAGE = `풋살 코치 로컬 분석 (영상은 이 컴퓨터에서만 읽어요)

사용:
  node tools/analyze.mjs <영상 파일> <작업 설정 파일.json> <결과 파일.json> [--resume] [--engine 이름]
  node tools/analyze.mjs --help

  작업 설정 파일  웹의 '새 수업 분석'에서 받은 파일 (…-작업.json)
  결과 파일      분석이 끝나면 생겨요. 웹 홈의 '분석 결과 가져오기'로 넣으면 수업 기록이 돼요.
  --engine 이름  분석 방식: classical-v2(기본, 브라우저 분석과 같음: 움직임을 예측해 따라가고, 가려졌던 아이는
                 코트 가장자리·밖 검출을 여러 장면 맞을 때만 다시 잡음. 팀 인원은 선 밖 0.75m 넘는 사람을 빼고 세고,
                 0.3초 이하로 잠깐 안 보인 아이는 앞뒤를 이어 줌. 조끼 색을 잠깐 놓친 아이는 1.5초까지 그 자리의 색 없는
                 움직임으로 잇되 색으로 다시 잡혀야 남김. 공은 영상에서 스스로 잰 공 크기에 가까운 흰 점을 따라감)
                 또는 classical-v1(예전 방식, 비교용). 결과 파일에 적혀요.
  --resume       Ctrl+C로 멈췄던 분석을 이어서 해요 (같은 영상·같은 작업 설정일 때만). --engine을 안 주면
                 처음 분석하던 방식으로 이어 해요. 중간 저장은 결과 파일 옆 '<결과 파일>.work' 폴더에 있어요.

  예전 방식: 작업 설정 대신 분석 설정(cfg) JSON을 주면 예전처럼 분석 결과(result)만 저장해요 (결과 파일은 생략 가능).
  ffmpeg·ffprobe가 필요해요. 다른 곳에 설치했다면 FFMPEG=경로, FFPROBE=경로 로 알려 주세요.

종료 코드: 0 성공 · 1 분석 실패 · 2 사용법·환경·파일 문제 · 130 Ctrl+C로 멈춤(--resume으로 이어서)`;

// ---------- ffmpeg·ffprobe ----------
export const binaries = (env = process.env) => ({ ffmpeg: env.FFMPEG || 'ffmpeg', ffprobe: env.FFPROBE || 'ffprobe' });
const tailOf = chunks => Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-3).join(' / ').slice(0, 400);
function notRunnable(cmd, name, e) {
  if (e?.code === 'ENOENT' || e?.code === 'EACCES') {
    return new ToolError(`${name}(${cmd})를 찾을 수 없거나 실행할 수 없어요. ffmpeg를 설치하고(ffprobe가 함께 설치돼요) 터미널에서 '${name} -version'이 되는지 확인해 주세요. `
      + `설치 방법은 README의 로컬 분석 안내에 있어요. 다른 곳에 설치했다면 ${name.toUpperCase()}=실행파일경로 로 알려 주세요.`, 2);
  }
  return new ToolError(`${name}(${cmd})를 실행하지 못했어요: ${e?.message ?? e}`, 2);
}
// 짧은 출력용 실행 (버전 확인·ffprobe)
function runSmall(cmd, name, args) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { reject(notRunnable(cmd, name, e)); return; }
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', e => reject(notRunnable(cmd, name, e)));
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(Object.assign(new ToolError(`${name}가 실패했어요 (종료 코드 ${code}): ${tailOf(err)}`, 2), { stderr: tailOf(err) }))));
  });
}
export async function checkBinaries(b) {
  for (const [name, cmd] of [['ffmpeg', b.ffmpeg], ['ffprobe', b.ffprobe]]) {
    const v = await runSmall(cmd, name, ['-version']).catch(e => { throw e.code === 2 && !e.stderr ? e : notRunnable(cmd, name, e); });
    if (!new RegExp(`^${name} version`, 'm').test(v)) throw new ToolError(`${cmd}는 ${name}가 아닌 것 같아요 ('${name} -version' 결과가 달라요). ${name.toUpperCase()} 경로를 확인해 주세요.`, 2);
  }
}

/** 첫 영상 스트림의 크기·길이·회전 */
export async function probeVideo(video, b) {
  let out;
  try {
    out = await runSmall(b.ffprobe, 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:stream_side_data=rotation:format=duration', '-of', 'json', video]);
  } catch (e) {
    if (e.stderr != null) throw new ToolError(`영상 파일을 읽지 못했어요 (손상됐거나 영상이 아닐 수 있어요): ${e.stderr}`, 2);
    throw e;
  }
  let j; try { j = JSON.parse(out); } catch { throw new ToolError('ffprobe 결과를 읽지 못했어요.', 2); }
  const st = j.streams?.[0];
  if (!st || !(st.width > 0 && st.height > 0)) throw new ToolError('영상 파일에서 화면(비디오 스트림)을 찾지 못했어요. 수업 영상 파일이 맞는지 확인해 주세요.', 2);
  const duration = +j.format?.duration > 0 ? +j.format.duration : +st.duration;
  if (!(duration > 0)) throw new ToolError('영상 길이를 알 수 없어요. 다른 형식(mp4)으로 저장한 영상으로 해 보세요.', 2);
  const rot = Math.abs(+(st.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0)) % 180;
  const [width, height] = rot === 90 ? [st.height, st.width] : [st.width, st.height]; // ffmpeg는 회전해서 디코딩함 (브라우저와 같음)
  return { width, height, duration };
}

/** ffmpeg 출력에서 W×H RGBA 장면을 하나씩 onFrame(frame, i)에 넘긴다. frame 버퍼는 다음 장면에 다시 쓰이므로 붙잡아 두려면 복사할 것.
 * onFrame이 false를 돌려주면 거기서 그만 읽는다. signal이 abort되면 ffmpeg를 끄고 ToolError(130). 반환: 넘긴 장면 수 */
export function decodeFrames({ ffmpeg, args, W, H, onFrame, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const size = W * H * 4, frame = Buffer.alloc(size), err = [];
    let off = 0, i = 0, settled = false, p;
    const finish = (fn, v) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); fn(v); };
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const onAbort = () => { kill(); finish(reject, abortError()); };
    try {
      // detached: 터미널의 Ctrl+C가 ffmpeg에 바로 가지 않게 (이 도구가 받아서 정리한 뒤 끈다)
      p = spawn(ffmpeg, ['-nostdin', '-v', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) { finish(reject, notRunnable(ffmpeg, 'ffmpeg', e)); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', e => finish(reject, notRunnable(ffmpeg, 'ffmpeg', e)));
    p.stderr.on('data', d => { err.push(d); if (err.length > 40) err.shift(); });
    p.stdout.on('data', chunk => {
      for (let k = 0; k < chunk.length && !settled;) {
        const n = Math.min(size - off, chunk.length - k);
        chunk.copy(frame, off, k, k + n); off += n; k += n;
        if (off < size) continue;
        off = 0;
        let r;
        try { r = onFrame(new Uint8ClampedArray(frame.buffer, frame.byteOffset, size), i++); } catch (e) { kill(); finish(reject, e); return; }
        if (r === false) { kill(); finish(resolve, i); return; }
      }
    });
    p.on('close', code => {
      if (settled) return;
      if (code === 0) finish(resolve, i);
      else finish(reject, new ToolError(`ffmpeg가 영상을 읽다가 멈췄어요 (종료 코드 ${code}). 영상 파일이 손상됐을 수 있어요: ${tailOf(err)}`, 1));
    });
  });
}

/** 영상 전체에서 고르게 n장(최대 30) → 픽셀별 중앙값. measure(frames, bg)가 있으면 같은 장면들로 잰 값을 extra로 (classical-v2 몸 크기) */
export async function buildBackground({ ffmpeg, video, duration, W, H, n = BG_FRAMES, signal, onProgress, measure }) {
  const frames = [];
  for (let k = 0; k < n; k++) {
    if (signal?.aborted) throw abortError();
    const t = (duration * (k + 0.5)) / n;
    await decodeFrames({ ffmpeg, W, H, signal, args: ['-ss', t.toFixed(3), '-i', video, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${W}:${H}`],
      onFrame: f => { frames.push(new Uint8ClampedArray(f)); return false; } });
    onProgress?.(k + 1, n);
  }
  if (!frames.length) throw new ToolError('영상에서 장면을 읽지 못했어요 (빈 코트 만들기). 영상 파일이 맞는지 확인해 주세요.', 1);
  const bg = medianBackground(frames);
  return { bg, count: frames.length, extra: measure ? measure(frames, bg) : undefined };
}

// ---------- 파일 ----------
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** 같은 폴더의 임시 파일에 다 쓰고 fsync한 뒤 이름을 바꾼다 → 중간에 실패해도 원래 파일은 그대로 */
export function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// 검출 한 장면: { i, t=i/10, players: 팀마다 [[x,y],…], ball: v1 [[x,y,혼자1/0],…] · v2 [[x,y,혼자1/0,넓이px],…], split?: [[팀, 번호, [[x,y],…2~4개]],…],
//   uncol?: [[x,y,넓이px],…], kidFg?: 팀마다 [넓이px,…] }  (split·uncol·kidFg는 v2 검출. uncol·kidFg는 검출 버전 3부터 늘 함께, 공 넓이는 검출 버전 4부터)
// 모든 값은 유한한 숫자 (m 좌표, 넓이는 양수). split(v2 나누기 후보)의 번호는 그 팀 players 안의 자리, 같은 자리 두 번은 안 됨
const finite = v => typeof v === 'number' && Number.isFinite(v);
const row = (r, len) => Array.isArray(r) && r.length === len && r.every(finite);
const splitOk = (s, players) => s === undefined || (Array.isArray(s) && s.length > 0 && s.every(e => Array.isArray(e) && e.length === 3
  && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < players.length && Number.isInteger(e[1]) && e[1] >= 0 && e[1] < players[e[0]].length
  && Array.isArray(e[2]) && e[2].length >= 2 && e[2].length <= 4 && e[2].every(r => row(r, 2)))
  && new Set(s.map(e => `${e[0]}:${e[1]}`)).size === s.length);
const bodyOk = (u, kf, nTeams) => (u === undefined && kf === undefined) || (Array.isArray(u) && u.every(r => row(r, 3) && r[2] > 0)
  && Array.isArray(kf) && kf.length === nTeams && kf.every(l => Array.isArray(l) && l.every(v => finite(v) && v > 0)));
const ballOk = (r, v2) => (v2 ? row(r, 4) && r[3] > 0 : row(r, 3)) && (r[2] === 0 || r[2] === 1); // v2 공 줄은 4칸(넓이 > 0), v1은 3칸
export const detectionOk = (d, k, nTeams, engine = 'classical-v1') => !!d && typeof d === 'object' && d.i === k && d.t === k / FPS
  && Array.isArray(d.players) && d.players.length === nTeams && d.players.every(l => Array.isArray(l) && l.every(r => row(r, 2)))
  && Array.isArray(d.ball) && d.ball.every(r => ballOk(r, engine !== 'classical-v1')) && splitOk(d.split, d.players) && bodyOk(d.uncol, d.kidFg, nTeams);

/** 검출 기록(JSONL)을 읽는다. 쓰다 만 마지막 줄(줄바꿈 없음 또는 깨진 마지막 줄)은 버리고 파일도 거기까지 자른다.
 * 중간 줄이 깨졌거나 값이 이상하면(번호·시각·팀 수·좌표 칸 수·유한한 숫자, v2 공 줄은 넓이까지) 이어 하지 않고 오류 */
export function readDetections(file, nTeams, engine = 'classical-v1') {
  if (!fs.existsSync(file)) return { dets: [], dropped: 0 };
  const buf = fs.readFileSync(file);
  let good = buf.lastIndexOf(0x0a) + 1; // 마지막 줄바꿈까지가 온전한 줄들
  const lines = buf.subarray(0, good).toString('utf8').split('\n'); lines.pop();
  const dets = [];
  for (let k = 0; k < lines.length; k++) {
    let d = null;
    try { d = JSON.parse(lines[k]); } catch {}
    if (!detectionOk(d, k, nTeams, engine)) {
      if (k === lines.length - 1) { good = Buffer.byteLength(lines.slice(0, k).map(x => x + '\n').join(''), 'utf8'); break; } // 깨진 마지막 줄만 버림
      throw new ToolError(`중간 저장 기록(${file})의 ${k + 1}번째 줄이 깨졌어요. 처음부터 다시 하려면 그 작업 폴더를 지운 뒤 --resume 없이 실행해 주세요.`, 2);
    }
    dets.push(d);
  }
  const dropped = buf.length - good;
  if (dropped) fs.truncateSync(file, good);
  return { dets, dropped };
}

// ---------- 경로 ----------
const statOf = p => { try { return fs.statSync(p); } catch { return null; } };
const lstatOf = p => { try { return fs.lstatSync(p); } catch { return null; } };
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sameFile = (a, b) => { const x = statOf(a), y = statOf(b); return !!(x && y && x.dev === y.dev && x.ino === y.ino); };
const same = (a, b) => path.resolve(a) === path.resolve(b) || real(a) === real(b) || sameFile(a, b);
const inside = (p, dir) => [[path.resolve(p), path.resolve(dir)], [real(p), real(dir)]].some(([a, d]) => { const r = path.relative(d, a); return !!r && !r.startsWith('..') && !path.isAbsolute(r); });
export const workDirOf = output => `${path.resolve(output)}.work`;

/** 입력·결과·중간 저장 경로가 서로 겹치면 거부 */
export function checkPaths({ video, job, output }) {
  for (const [p, what] of [[video, '영상 파일'], [job, '작업 설정 파일']]) {
    const s = statOf(p);
    if (!s) throw new ToolError(`${what}이 없어요: ${p}`, 2);
    if (!s.isFile()) throw new ToolError(`${what}이 파일이 아니에요: ${p}`, 2);
  }
  if (same(video, job)) throw new ToolError('영상 파일과 작업 설정 파일이 같은 파일이에요.', 2);
  if (!output) return;
  const work = workDirOf(output);
  if (same(output, video) || same(output, job)) throw new ToolError('결과 파일 경로가 입력 파일(영상·작업 설정)과 같아요. 입력을 덮어쓰지 않게 다른 이름으로 정해 주세요.', 2);
  const os = statOf(output);
  if (os && !os.isFile()) throw new ToolError(`결과 파일 경로가 이미 폴더예요: ${output}`, 2);
  const dir = statOf(path.dirname(path.resolve(output)));
  if (!dir?.isDirectory()) throw new ToolError(`결과 파일을 둘 폴더가 없어요: ${path.dirname(path.resolve(output))}`, 2);
  for (const [p, what] of [[video, '영상 파일'], [job, '작업 설정 파일']]) {
    if (same(work, p) || inside(p, work)) throw new ToolError(`${what}이 중간 저장 폴더(${work}) 자리와 겹쳐요. 결과 파일 이름을 바꿔 주세요.`, 2);
  }
  const wl = lstatOf(work);
  if (!wl) return;
  if (wl.isSymbolicLink()) throw new ToolError(`중간 저장 폴더(${work})가 링크(바로 가기)예요. 실제 폴더일 때만 써요. 그 링크를 옮기거나 결과 파일 이름을 바꿔 주세요.`, 2);
  if (!wl.isDirectory()) throw new ToolError(`중간 저장 폴더 자리(${work})에 이미 파일이 있어요. 결과 파일 이름을 바꾸거나 그 파일을 옮겨 주세요.`, 2);
  // 관리 파일은 이 도구가 만든 보통 파일이어야 한다: 링크이거나 다른 파일과 이어져 있으면(하드 링크) 이어 하기의 자르기·덧붙이기가 원본을 망가뜨릴 수 있음
  for (const f of OUR_FILES) {
    const fp = path.join(work, f), st = lstatOf(fp);
    if (!st) continue;
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw new ToolError(`중간 저장 파일(${fp})이 링크이거나 다른 파일과 이어져 있어요. 원본을 망가뜨리지 않게 멈췄어요. 그 작업 폴더를 확인해 주세요.`, 2);
    for (const [p, what] of [[video, '영상 파일'], [job, '작업 설정 파일'], [output, '결과 파일']]) {
      if (sameFile(fp, p)) throw new ToolError(`중간 저장 파일(${fp})이 ${what}과 같은 파일이에요. 원본을 망가뜨리지 않게 멈췄어요.`, 2);
    }
  }
}

// ---------- 작업 폴더 ----------
function lockWork(work) {
  const lp = path.join(work, LOCK);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(lp, String(process.pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(lp, 'utf8') === String(process.pid)) fs.unlinkSync(lp); } catch {} }; // 내 잠금일 때만 풂
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const pid = +fs.readFileSync(lp, 'utf8');
    let alive = false; try { if (pid > 0 && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) throw new ToolError(`이미 다른 창에서 같은 결과 파일로 분석하고 있어요 (프로세스 ${pid}). 그 분석이 끝나거나 멈춘 뒤 다시 해 주세요.`, 2);
    fs.unlinkSync(lp); // 이 도구가 남긴 오래된 잠금 (그 프로세스는 이미 없음)
  }
  throw new ToolError('작업 폴더를 잠그지 못했어요.', 2);
}
// 성공 뒤 정리: 잠금을 쥔 채로 이 실행의 관리 파일(상태·배경·검출)만 지우고 → 잠금을 풀고 → 폴더가 비었을 때만 지운다.
// (잠금을 먼저 풀면 그사이 다른 실행이 잠금을 잡고 만든 파일을 지울 수 있음. 다른 파일이 있으면 폴더는 남김)
function cleanWork(work, release) {
  for (const f of [STATE, BG, DETS]) try { fs.unlinkSync(path.join(work, f)); } catch {}
  release();
  try { fs.rmdirSync(work); } catch {}
}

// ---------- 진행 표시 ----------
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function progressPrinter(err) {
  const tty = !!err.isTTY; let last = 0, open = false;
  return {
    line(text, force = false) {
      if (tty) { err.write('\r' + text.padEnd(72)); open = true; return; }
      const now = Date.now(); if (force || now - last > 3000) { err.write(text + '\n'); last = now; }
    },
    end(text) { if (tty && open) { err.write('\r' + (text ?? '').padEnd(72) + '\n'); open = false; } else if (text) err.write(text + '\n'); },
  };
}

// ---------- 본체 ----------
function parseArgs(argv) {
  const pos = [], flags = new Set();
  let engine; // 안 주면 undefined: 새로 하면 기본값, 이어 하면 중간 저장 기록의 방식
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--help' || a === '-h') flags.add('help');
    else if (a === '--resume') flags.add('resume');
    else if (a === '--engine' || a.startsWith('--engine=')) {
      engine = a === '--engine' ? argv[++k] : a.slice('--engine='.length);
      if (!ENGINES.includes(engine)) throw new ToolError(`모르는 분석 방식(--engine)이에요: ${engine ?? '(없음)'}. ${ENGINES.join(' 또는 ')} 중에서 골라 주세요.`, 2);
    } else if (a.startsWith('-') && a !== '-') throw new ToolError(`모르는 옵션이에요: ${a}\n\n${USAGE}`, 2);
    else pos.push(a);
  }
  return { pos, help: flags.has('help'), resume: flags.has('resume'), engine };
}

/** 작업 설정(JOB) 또는 예전 분석 설정(cfg) 읽기 */
function readJob(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ToolError(`작업 설정 파일을 JSON으로 읽지 못했어요: ${e.message}`, 2); }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'app' in raw) {
    try { const job = parseAnalysisJob(raw); return { kind: 'job', job, config: job.config }; } catch (e) { throw new ToolError(e.message, 2); }
  }
  try { return { kind: 'legacy', job: null, config: validateAnalysisConfig(raw) }; } catch (e) { throw new ToolError(`${e.message} (예전 분석 설정 형식으로 읽음)`, 2); }
}

/** CLI 본체. 반환: 종료 코드 */
export async function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const say = s => err.write(s + '\n');
  let release = () => {}, interrupted = false, onSig = null;
  const ac = new AbortController();
  try {
    const { pos, help, resume, engine: asked } = parseArgs(argv);
    let engine = asked ?? DEFAULT_ENGINE; // 이어 하기면 아래에서 중간 저장 기록의 방식으로 바뀜
    if (help) { out.write(USAGE + '\n'); return 0; }
    const [video, jobFile, output] = pos;
    if (!video || !jobFile || pos.length > 3) throw new ToolError(USAGE, 2);
    checkPaths({ video, job: jobFile, output });
    const { kind, job, config } = readJob(jobFile);
    if (kind === 'job' && !output) throw new ToolError('결과 파일 경로를 적어 주세요 (예: 결과.json).\n\n' + USAGE, 2);
    const b = binaries(env);
    await checkBinaries(b);
    const info = await probeVideo(video, b);
    const W = config.width, H = config.height;
    if (Math.abs(info.width / info.height - W / H) > 0.01 * (W / H)) {
      throw new ToolError(`작업 설정의 화면 비율(${W}×${H})과 영상 비율(${info.width}×${info.height})이 달라요. 작업 설정 파일을 만든 영상과 같은 영상인지 확인해 주세요.`, 2);
    }
    if (job?.sourceName && job.sourceName !== path.basename(video)) say(`알림: 작업 설정의 영상 이름(${job.sourceName})과 넣은 영상 이름(${path.basename(video)})이 달라요. 같은 수업 영상인지 확인해 주세요.`);

    // Ctrl+C: 첫 번째는 지금까지 검출을 저장하고 멈춤, 두 번째는 바로 끝
    onSig = () => { if (interrupted) process.exit(130); interrupted = true; say('\n멈추는 중… 지금까지 검출한 장면을 저장해요 (한 번 더 누르면 바로 끝나요)'); ac.abort(); };
    process.on('SIGINT', onSig);

    say('영상 확인 중 (같은 영상인지 확인하는 지문 계산)…');
    const size = statOf(video).size, videoSha = await sha256File(video);
    if (ac.signal.aborted) throw abortError();
    // 분석 방식도 지문에 넣는다 (v1은 방식이 없던 예전 지문과 같게 → 예전 중간 저장도 이어 할 수 있음). 이어 하면 아래에서 기록의 방식으로 다시 계산
    // v1이 아니면 검출 기록 버전도 넣어, 버전이 다른(예전 도구로 만든) v2 검출 기록과 섞이지 않게 한다
    const hashOf = e => sha256(JSON.stringify({ kind, config, fps: FPS, bgFrames: BG_FRAMES, tool: TOOL_VERSION, ...(e !== 'classical-v1' ? { engine: e, detect: detectVersionOf(e) } : {}) }));
    let settingsHash = hashOf(engine);
    const startedAt = new Date().toISOString(), t0 = Date.now();

    // ----- 중간 저장 준비 -----
    const work = output ? workDirOf(output) : null;
    let state = null, bg = null, bgCount = 0, dets = [], resumed = false, bodyPx = null; // bodyPx: v2 팀별 몸 크기(나누기 기준)
    if (work) {
      if (statOf(work)) {
        // 이 도구의 폴더인지 먼저 읽기만 해서 확인한다 (다른 용도의 폴더·잠금 파일은 일절 건드리지 않게) → 잠금 → 상태를 다시 읽음
        const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(work, STATE), 'utf8')); } catch { return null; } };
        const owned = x => !!x && typeof x === 'object' && x.tool === 'futsal-coach-analyze';
        const notOurs = () => new ToolError(`이 폴더(${work})는 풋살 코치 분석의 중간 저장 기록이 아니거나 기록(state.json)을 읽을 수 없어요. 폴더는 건드리지 않았어요. 결과 파일 이름을 바꿔 실행하거나, 이 도구가 만든 폴더가 맞는지 확인해 주세요.`, 2);
        // 검출 기록 버전이 지금 도구와 다른 중간 저장(기록된 방식 기준)은 어떻게 해도 이어 할 수 없다
        const oldDetect = st => {
          const e = st.engine ?? 'classical-v1', got = st.detect ?? 1, need = detectVersionOf(e); // 방식 기록이 없는 예전 중간 저장은 v1
          if (got === need) return null;
          const by = got < need ? `${DETECT_BEFORE[got] ?? '예전'} 도구로` : '이 도구보다 새 도구로';
          return new ToolError(`이 중간 저장은 ${by} 검출한 ${e} 기록이라 이어 할 수 없어요 (검출 기록 버전 ${got}, 지금 도구는 ${need}). 중간 저장 폴더(${work})를 지운 뒤 --resume 없이 다시 실행해 주세요 (검출을 처음부터 다시 해요).`, 2);
        };
        const first = readState();
        if (owned(first) && oldDetect(first)) throw oldDetect(first); // --resume이 없어도 먼저: "--resume을 붙이라" 했다가 붙이면 거절하는 두 번 걸음을 없앰
        if (!resume) throw new ToolError(`이 결과 파일의 중간 저장 기록이 있어요 (${work}).\n이어서 하려면 같은 명령 끝에 --resume을 붙여 주세요. 처음부터 다시 하려면 그 폴더를 직접 지운 뒤 실행해 주세요.`, 2);
        if (!owned(first)) throw notOurs();
        release = lockWork(work);
        state = readState(); // 잠금을 잡는 사이 다른 실행이 바꿨을 수 있음
        if (!owned(state)) throw notOurs();
        if (state.video?.sha256 !== videoSha || state.video?.size !== size) throw new ToolError('이어서 하려는 영상이 처음 분석하던 영상과 달라요 (파일 내용이 바뀌었어요). 같은 영상으로 다시 실행하거나, 처음부터 하려면 중간 저장 폴더를 지운 뒤 --resume 없이 실행해 주세요.', 2);
        const was = state.engine ?? 'classical-v1'; // 방식 기록이 없는 예전 중간 저장은 v1
        if (asked && asked !== was) throw new ToolError(`처음 분석하던 방식(${was})과 지금 고른 방식(${asked})이 달라요. 이어 하려면 --engine 없이(또는 --engine ${was}로) 실행하고, 새 방식으로 하려면 중간 저장 폴더를 지운 뒤 --resume 없이 실행해 주세요.`, 2);
        engine = was; settingsHash = hashOf(engine);
        if (oldDetect(state)) throw oldDetect(state); // 잠그는 사이 바뀌었을 수 있어 다시 봄
        if (state.settingsHash !== settingsHash || state.kind !== kind) throw new ToolError('작업 설정(코트·팀 색 등)이 처음과 달라요. 같은 작업 설정 파일로 실행하거나, 새 설정으로 처음부터 하려면 중간 저장 폴더를 지운 뒤 --resume 없이 실행해 주세요.', 2);
        resumed = true;
        const bp = path.join(work, BG), bs = statOf(bp);
        // v2는 몸 크기(bodyPx)도 배경과 같이 있어야 이어 씀. 없으면 배경부터 다시 (같은 30장을 다시 읽어 둘 다 만듦)
        if (state.background && bs?.size === W * H * 4 && (engine === 'classical-v1' || Array.isArray(state.bodyPx))) {
          const buf = fs.readFileSync(bp);
          if (sha256(buf) === state.background.sha256) { bg = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length); bgCount = state.background.frames; bodyPx = state.bodyPx ?? null; }
        }
        const r = readDetections(path.join(work, DETS), config.teams.length, engine);
        dets = r.dets;
        say(`이어서 해요(분석 방식 ${engine}): 검출한 장면 ${dets.length}장을 불러왔어요${r.dropped ? ` (쓰다 만 마지막 줄 ${r.dropped}바이트는 버렸어요)` : ''}.`);
      } else {
        if (resume) say('이어서 할 중간 저장 기록이 없어서 처음부터 해요.');
        fs.mkdirSync(work);
        release = lockWork(work);
      }
    }
    const saveState = patch => {
      if (!work) return;
      state = { ...(state || {}), tool: 'futsal-coach-analyze', toolVersion: TOOL_VERSION, kind, engine, detect: detectVersionOf(engine), settingsHash, fps: FPS, width: W, height: H,
        video: { file: path.basename(video), size, sha256: videoSha }, startedAt: state?.startedAt ?? startedAt, ...patch, updatedAt: new Date().toISOString() };
      writeAtomic(path.join(work, STATE), JSON.stringify(state, null, 1));
    };
    const prog = progressPrinter(err);

    // ----- 1. 빈 코트(배경) -----
    if (!bg) {
      saveState({ stage: 'background', background: null, detected: dets.length });
      // v2: 같은 30장으로 팀별 몸 크기도 잰다 (브라우저 분석과 같은 방법: vision.bodySizes)
      const measure = engine === 'classical-v1' ? undefined : (frames, b0) => bodySizes(frames, setup(config, b0).det);
      const r = await buildBackground({ ffmpeg: b.ffmpeg, video, duration: info.duration, W, H, signal: ac.signal, measure, onProgress: (k, n) => prog.line(`빈 코트 만드는 중 ${k}/${n}장`) });
      bg = r.bg; bgCount = r.count; bodyPx = r.extra ?? null;
      prog.end(`빈 코트: ${bgCount}장으로 만들었어요${bodyPx ? ` (팀별 몸 크기 ${bodyPx.join('/')}px)` : ''}`);
      if (work) { const buf = Buffer.from(bg.buffer, bg.byteOffset, bg.length); writeAtomic(path.join(work, BG), buf); saveState({ stage: 'detect', background: { frames: bgCount, sha256: sha256(buf) }, ...(bodyPx ? { bodyPx } : {}) }); }
    }
    const s = setup(config, bg);
    if (bodyPx) s.det.bodyPx = bodyPx; // v2: 붙은 덩어리 나누기 후보·색 없는 덩어리·아이 한 명 몸 넓이도 검출 (검출 버전 3)

    // ----- 2. 장면마다 검출 (처음부터 순서대로 디코딩, 검출한 장면은 건너뜀) -----
    const skip = dets.length, expected = Math.max(1, Math.round(info.duration * FPS));
    let jfd = work ? fs.openSync(path.join(work, DETS), 'a') : null, pending = [], tDet = Date.now();
    const flush = () => {
      if (!pending.length || jfd == null) return;
      fs.writeSync(jfd, pending.join('\n') + '\n'); fs.fsyncSync(jfd); pending = [];
      saveState({ stage: 'detect', detected: dets.length });
    };
    const testStopAt = env.FUTSAL_ANALYZE_TEST_INTERRUPT_AT != null ? +env.FUTSAL_ANALYZE_TEST_INTERRUPT_AT : -1; // 시험용: 이 장면 뒤에 Ctrl+C를 흉내 냄
    if (skip) say(`${skip + 1}번째 장면부터 검출해요 (앞 장면은 시각을 맞추려고 읽기만 해요).`);
    let decoded = 0;
    try {
      decoded = await decodeFrames({ ffmpeg: b.ffmpeg, W, H, signal: ac.signal, args: ['-i', video, '-map', '0:v:0', '-vf', frameFilter(engine, W, H)], onFrame: (f, i) => { // 이어 할 때도 같은 필터 → 같은 장면 대응
        if (i < skip) { if (i % 50 === 0) prog.line(`앞 장면 건너뛰는 중 ${i + 1}/${skip}장`); return; }
        const d = s.toMeters(detect(f, s.det));
        const line = JSON.stringify({ i, t: i / FPS, players: d.players, ball: d.ball, ...(d.split ? { split: d.split } : {}), ...(d.uncol ? { uncol: d.uncol, kidFg: d.kidFg } : {}) }); // v2: 나누기 후보·색 없는 덩어리
        const back = JSON.parse(line); // 이어 하기와 똑같은 입력이 되게 저장한 글자에서 다시 읽은 값을 쓴다
        if (!detectionOk(back, i, config.teams.length, engine)) throw new ToolError(`${i + 1}번째 장면 검출 값이 숫자가 아니에요 (코트 모서리 설정 문제일 수 있어요). 작업 설정을 다시 만들어 주세요.`, 1);
        dets.push(back);
        pending.push(line);
        if (pending.length >= FLUSH_EVERY) flush();
        const el = (Date.now() - tDet) / 1000, q = (i + 1 - skip) / Math.max(1, expected - skip);
        prog.line(`검출 ${i + 1}/${expected}장 (${Math.min(100, Math.round(((i + 1) / expected) * 100))}%)${q > 0.02 ? ` · 남은 시간 약 ${fmtTime((el / q) * (1 - q))}` : ''}`);
        if (i === testStopAt) process.kill(process.pid, 'SIGINT');
      } });
    } finally {
      try { flush(); } finally { if (jfd != null) { fs.closeSync(jfd); jfd = null; } }
    }
    if (ac.signal.aborted) throw abortError();
    if (decoded < dets.length) throw new ToolError('중간 저장 기록이 영상보다 길어요. 처음부터 다시 하려면 중간 저장 폴더를 지운 뒤 --resume 없이 실행해 주세요.', 2);
    if (!dets.length) throw new ToolError('영상에서 장면을 하나도 읽지 못했어요. 영상 파일이 맞는지 확인해 주세요.', 1);
    prog.end(`검출: ${dets.length}장 (${FPS}fps)`);
    saveState({ stage: 'analyze', detected: dets.length });

    // ----- 3. 추적·활동량 -----
    let result;
    try { result = analyzeFrames(dets, config, { engine }); } catch (e) { throw new ToolError(`분석하지 못했어요: ${e.message}${work ? ` 작업 설정을 고쳐 다시 하려면 중간 저장 폴더(${work})를 지운 뒤 --resume 없이 실행해 주세요.` : ''}`, 1); }
    if (!result.players.length) throw new ToolError(`영상에서 선수를 한 명도 찾지 못했어요. 작업 설정의 팀 색·코트 모서리가 이 영상과 맞는지 확인해 주세요 (웹에서 작업 설정 파일을 다시 만들어 보세요).${work ? ` 그다음 중간 저장 폴더(${work})를 지우고 실행해 주세요.` : ''}`, 1);

    // ----- 4. 결과 저장 (원자 저장: 실패해도 원래 결과 파일은 그대로) -----
    let doc = result;
    if (kind === 'job') {
      const analysis = { engine, sourceName: job.sourceName ?? path.basename(video), tool: 'tools/analyze.mjs', toolVersion: TOOL_VERSION,
        video: { file: path.basename(video), sha256: videoSha, width: info.width, height: info.height, duration: +info.duration.toFixed(3) },
        fps: FPS, frames: dets.length, backgroundFrames: bgCount, detectVersion: detectVersionOf(engine), ...(bodyPx ? { bodyPx } : {}), resumed, startedAt: state?.startedAt ?? startedAt, finishedAt: new Date().toISOString(),
        seconds: Math.round((Date.now() - t0) / 1000) };
      try { doc = parseAnalysisFile({ app: RESULT_APP, version: FILE_VERSION, session: job.session, result, analysis }); } // 웹이 읽을 수 있는지 미리 확인
      catch (e) { throw new ToolError(`만든 결과가 결과 파일 형식에 맞지 않아요 (도구 문제): ${e.message}`, 1); }
    }
    if (output) {
      const existed = !!statOf(output);
      writeAtomic(path.resolve(output), JSON.stringify(doc));
      say(`결과 파일을 저장했어요${existed ? ' (원래 있던 파일을 새 결과로 바꿨어요)' : ''}: ${output}`);
      if (work) { saveState({ stage: 'done' }); cleanWork(work, release); release = () => {}; }
    }
    out.write(`인원 ${result.counts.join('/')} · 가려짐 ${(result.hiddenRate * 100).toFixed(1)}% · 공 보임 ${(result.ballSeen * 100).toFixed(1)}%\n`);
    for (const p of result.players) out.write(`${p.label} ${Math.round(p.distance)} m · ${(p.topSpeed * 3.6).toFixed(1)} km/h · 질주 ${p.sprints} · 소유 ${p.possession.toFixed(1)} s · 패스 ${p.passes}\n`);
    if (kind === 'job') say("다음: 웹 홈의 '분석 결과 가져오기'에서 이 결과 파일을 고르세요.");
    return 0;
  } catch (e) {
    if (e instanceof ToolError && e.code === 130) {
      say(`멈췄어요. 지금까지 검출한 장면은 저장해 뒀어요. 이어서 하려면 같은 명령 끝에 --resume을 붙여 다시 실행하세요.`);
      return 130;
    }
    if (e instanceof ToolError) { say(e.message); return e.code; }
    say(`예상하지 못한 문제가 생겼어요: ${e?.stack || e}`);
    return 1;
  } finally {
    release();
    if (onSig) process.removeListener('SIGINT', onSig);
  }
}
