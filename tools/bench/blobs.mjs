// 움직이는 덩어리 세기 (합성 벤치마크 잡동사니를 실제 영상과 맞추는 잣대). 영상은 이 컴퓨터에서만 읽고 숫자만 낸다.
// 엔진과 같은 설정(js/pipeline.js setup: 코트+1.5m 마스크·배경과의 차 40·열기)으로 빈 코트(영상 전체에서 고른 30장 중앙값)와 다른
// 픽셀 덩어리를 장면마다 세고, 그중 팀 조끼 색 픽셀이 선수 기준(minPx)보다 적은 덩어리 = '색 없는 움직이는 덩어리'를 따로 센다.
// 사용: node tools/bench/blobs.mjs <영상> <작업 설정 또는 분석 설정 JSON> [--fps 1] [--min 10]
//   --fps  셀 장면 간격 (초당 장면 수, 기본 1)   --min  덩어리 최소 넓이 px (기본 10: 압축 점 잡음 제외)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../../js/pipeline.js';
import { medianBackground, foreground, components, hsv } from '../../js/vision.js';

const ff = process.env.FFMPEG || 'ffmpeg', fp = process.env.FFPROBE || 'ffprobe';
function frames(video, vf, w, h, onFrame) {
  return new Promise((res, rej) => {
    const p = spawn(ff, ['-v', 'error', '-i', video, '-map', '0:v:0', '-vf', `${vf},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const size = w * h * 4; let buf = Buffer.alloc(0), n = 0;
    p.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) { onFrame(new Uint8ClampedArray(buf.subarray(0, size)), n++); buf = buf.subarray(size); } });
    p.on('error', rej); p.on('close', c => (c ? rej(new Error('ffmpeg ' + c)) : res(n)));
  });
}
const duration = video => new Promise((res, rej) => { const p = spawn(fp, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]); let o = ''; p.stdout.on('data', d => { o += d; }); p.on('close', c => (c ? rej(new Error('ffprobe ' + c)) : res(+o))); });
const inHue = (h, [lo, hi]) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);

/** 영상 하나: 장면마다 { all: 덩어리 수, colorless: 색 없는 덩어리 수 } */
export async function countBlobs(video, cfg, { fps = 1, min = 10 } = {}) {
  const W = cfg.width, H = cfg.height, dur = await duration(video), bgf = [];
  await frames(video, `fps=${(30 / dur).toFixed(6)}`, W, H, f => { if (bgf.length < 30) bgf.push(f); });
  const bg = medianBackground(bgf), { det } = setup(cfg, bg), T = det.teams, out = [];
  await frames(video, `fps=${fps}`, W, H, f => {
    const fg = foreground(f, bg, det.roi, W, H, det.thr, det.openR), { lab, n } = components(fg, W, H);
    const area = new Int32Array(n + 1), team = new Int32Array(n + 1);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const l = lab[i]; if (!l) continue;
      area[l]++;
      const [h, s, v] = hsv(f[p], f[p + 1], f[p + 2]);
      if (v > 60 && T.some(t => inHue(h, t.hue) && s >= t.sat[0] && s <= t.sat[1])) team[l]++;
    }
    let all = 0, colorless = 0;
    for (let l = 1; l <= n; l++) if (area[l] >= min) { all++; if (team[l] < det.minPx) colorless++; }
    out.push({ all, colorless });
  });
  return out;
}
export function summarize(rows) {
  const q = (a, x) => { const s = [...a].sort((p, r) => p - r); return s[Math.min(s.length - 1, Math.floor(x * s.length))]; };
  const c = rows.map(r => r.colorless), a = rows.map(r => r.all);
  return { frames: rows.length, colorlessMean: c.reduce((s, v) => s + v, 0) / (c.length || 1), colorlessMedian: q(c, 0.5), colorlessP90: q(c, 0.9), allMean: a.reduce((s, v) => s + v, 0) / (a.length || 1) };
}

async function main(argv) {
  const opt = { fps: 1, min: 10 }, pos = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--fps') opt.fps = +argv[++i]; else if (argv[i] === '--min') opt.min = +argv[++i]; else pos.push(argv[i]); }
  if (pos.length !== 2) { console.error('사용: node tools/bench/blobs.mjs <영상> <작업 설정 또는 분석 설정 JSON> [--fps 1] [--min 10]'); return 2; }
  const doc = JSON.parse(fs.readFileSync(pos[1], 'utf8')), cfg = doc.app === 'futsal-coach-job' ? doc.config : doc;
  const s = summarize(await countBlobs(pos[0], cfg, opt));
  console.log(JSON.stringify({ video: path.basename(pos[0]), ...opt, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +(+v).toFixed(1)])) }));
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(e.message); process.exitCode = 2; });
