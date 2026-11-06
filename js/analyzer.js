// 메인 스레드: 영상에서 프레임을 뽑아 워커들에게 나눠 주고 결과를 모은다.
import { DT, analyzeFrames } from './pipeline.js';

const newWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// 분석 해상도: 가로 최대 1280 (공이 보일 만큼 크고, 너무 느리지 않게)
export function procSize(video) {
  const w = Math.min(1280, video.videoWidth);
  return [w, Math.round((video.videoHeight * w) / video.videoWidth)];
}
function grabber(video) {
  const [w, h] = procSize(video), c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  return () => { ctx.drawImage(video, 0, 0, w, h); return ctx.getImageData(0, 0, w, h).data; };
}
export function seek(video, t) {
  return new Promise(res => {
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}
export async function frameAt(video, t) { await seek(video, t); return grabber(video)(); }

/** 영상 전체에서 30장을 골라 픽셀별 중앙값 = 사람이 지워진 빈 코트 */
export async function buildBackground(video, onProgress) {
  const grab = grabber(video), n = 30, frames = [];
  for (let k = 0; k < n; k++) {
    await seek(video, (video.duration * (k + 0.5)) / n);
    frames.push(grab().buffer);
    onProgress?.((k + 1) / (n + 2));
  }
  const wk = newWorker();
  const bg = await new Promise((res, rej) => {
    wk.onmessage = ({ data }) => (data.type === 'error' ? rej(new Error(data.message)) : res(new Uint8ClampedArray(data.bg)));
    wk.onerror = e => rej(new Error(e.message || '워커를 시작하지 못했어요'));
    wk.postMessage({ type: 'background', frames }, frames);
  });
  wk.terminate();
  return bg;
}

/** 영상을 빠르게 재생하며 0.1초마다 한 장씩 워커에 보낸다. 결과 = analyzeFrames 출력 */
export async function runAnalysis(video, cfg, bg, { onProgress, signal } = {}) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) throw new Error('이 브라우저는 영상 분석을 지원하지 않아요. 최신 크롬이나 사파리를 써 주세요.');
  const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: N }, newWorker);
  const stop = () => { workers.forEach(w => w.terminate()); video.pause(); video.playbackRate = 1; };
  try {
    await Promise.all(workers.map(w => new Promise((res, rej) => {
      w.onmessage = ({ data }) => (data.type === 'ready' ? res() : rej(new Error(data.message)));
      w.onerror = e => rej(new Error(e.message || '워커를 시작하지 못했어요'));
      w.postMessage({ type: 'init', cfg, bg: bg.slice().buffer });
    })));
  } catch (e) { stop(); throw e; }

  const grab = grabber(video), dets = [];
  let pending = 0, rr = 0, failed = null, wake = null;
  const fail = e => { failed ??= e; wake?.(); };
  const waitFor = async ok => { while (!ok() && !failed) await new Promise(r => { wake = r; }); if (failed) throw failed; };
  workers.forEach(w => {
    w.onmessage = ({ data: m }) => {
      if (m.type === 'error') return fail(new Error(m.message));
      dets.push({ t: m.t, players: m.players, ball: m.ball });
      pending--; wake?.();
    };
    w.onerror = e => fail(new Error(e.message || '분석 중 오류'));
  });
  const send = t => { const buf = grab().buffer; workers[rr++ % N].postMessage({ type: 'frame', t, buf }, [buf]); pending++; };
  const onAbort = () => fail(new DOMException('분석을 멈췄어요', 'AbortError'));
  signal?.addEventListener('abort', onAbort);
  // 다른 탭을 보면 브라우저가 영상 프레임을 안 넘겨 주므로 그동안 멈춘다
  let hiddenPause = false;
  const onVis = () => {
    if (document.hidden && !video.paused) { hiddenPause = true; video.pause(); onProgress?.(null, '다른 탭을 보는 동안 멈췄어요. 이 탭으로 돌아오면 이어서 해요.'); }
    else if (!document.hidden && hiddenPause) { hiddenPause = false; video.play().catch(fail); }
  };
  document.addEventListener('visibilitychange', onVis);
  try {
    // 1단계: 빠르게 재생하며 0.1초마다 한 장씩
    await seek(video, 0);
    video.muted = true;
    video.playbackRate = 3; // 디코딩이 따라오는 선에서 빠르게
    let next = 0, ended = false;
    const onFrame = (_, meta) => {
      if (ended || failed) return;
      const t = meta.mediaTime;
      if (t + 1e-3 >= next) {
        send(t);
        next = (Math.floor(t / DT + 1e-6) + 1) * DT;
        onProgress?.(Math.min(1, t / video.duration) * 0.95);
        if (pending >= 2 * N) video.pause(); // 워커가 밀리면 잠깐 멈춤
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    const endP = new Promise(r => { video.onended = () => { ended = true; r(); }; });
    if (!document.hidden) await video.play(); else hiddenPause = true;
    while (!ended && !failed) {
      await Promise.race([endP, new Promise(r => { wake = r; })]);
      if (!ended && video.paused && !hiddenPause && !document.hidden && pending < N) await video.play();
    }
    await waitFor(() => !pending);
    // 2단계: 재생 중 놓친 장면(탭 숨김·디코딩 밀림)을 하나씩 찾아가서 채운다
    const have = dets.map(d => d.t).sort((a, b) => a - b), missing = [];
    let k = 0;
    for (let t = 0; t <= video.duration - DT / 2; t += DT) {
      while (k < have.length - 1 && have[k + 1] <= t) k++;
      const near = Math.min(Math.abs((have[k] ?? -9) - t), Math.abs((have[k + 1] ?? -9) - t));
      if (near > 0.15) missing.push(+t.toFixed(2));
    }
    for (let j = 0; j < missing.length; j++) {
      await waitFor(() => pending < 2 * N);
      await seek(video, missing[j]);
      send(missing[j]);
      onProgress?.((have.length + j + 1) / (have.length + missing.length), `빠진 장면 채우는 중 (${j + 1}/${missing.length})`);
    }
    await waitFor(() => !pending);
    dets.sort((a, b) => a.t - b.t);
    return analyzeFrames(dets, cfg);
  } finally {
    stop();
    document.removeEventListener('visibilitychange', onVis);
    signal?.removeEventListener('abort', onAbort);
  }
}
