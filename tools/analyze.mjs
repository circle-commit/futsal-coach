// 브라우저와 같은 분석 코드를 node + ffmpeg로 돌려 보는 도구 (개발·검증용).
// 사용: node tools/analyze.mjs samples/sample.mp4 samples/sample.config.json [out.json]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup, analyzeFrames } from '../js/pipeline.js';
import { medianBackground, detect } from '../js/vision.js';

const [video, cfgPath, out] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const W = cfg.width, H = Math.round(cfg.height);

function frames(filter, onFrame) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `${filter},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const size = W * H * 4; let buf = Buffer.alloc(0), i = 0;
    p.stdout.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= size) { onFrame(new Uint8ClampedArray(buf.subarray(0, size)), i++); buf = buf.subarray(size); }
    });
    p.on('close', c => (c ? rej(new Error('ffmpeg ' + c)) : res(i)));
  });
}

const t0 = Date.now();
const bgFrames = [];
await frames('fps=1/10', f => bgFrames.push(f));
const bg = medianBackground(bgFrames);
const s = setup(cfg, bg);
console.log('배경', bgFrames.length, '장', Date.now() - t0, 'ms', 'ppm', s.ppm.toFixed(1));
const dets = [];
await frames('fps=10', (f, i) => dets.push({ t: i / 10, ...s.toMeters(detect(f, s.det)) }));
console.log('검출', dets.length, '프레임', Date.now() - t0, 'ms');
const result = analyzeFrames(dets, cfg);
console.log('인원', result.counts, '가려짐', (result.hiddenRate * 100).toFixed(1) + '%', '공 보임', (result.ballSeen * 100).toFixed(1) + '%');
for (const p of result.players) console.log(p.label, Math.round(p.distance), 'm', (p.topSpeed * 3.6).toFixed(1), 'km/h', p.sprints, '질주', '소유', p.possession.toFixed(1), 's', '패스', p.passes);
if (out) writeFileSync(out, JSON.stringify(result));
