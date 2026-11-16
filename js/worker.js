// 분석 워커: 프레임을 받아 선수·공을 찾고 m 좌표로 돌려준다. 검출 코드는 로컬 분석 도구(tools/local-analysis.mjs)와 같다.
import { setup } from './pipeline.js';
import { detect, medianBackground, bodySizes } from './vision.js';

let s = null;
onmessage = ({ data: m }) => {
  try {
    if (m.type === 'background') {
      const bg = medianBackground(m.frames.map(b => new Uint8ClampedArray(b)));
      postMessage({ type: 'background', bg: bg.buffer }, [bg.buffer]);
    } else if (m.type === 'body') { // classical-v2: 배경과 같은 30장으로 팀별 몸 크기 (붙은 덩어리 나누기 기준, 도구와 같은 vision.bodySizes)
      const s0 = setup(m.cfg, new Uint8ClampedArray(m.bg));
      postMessage({ type: 'body', bodyPx: bodySizes(m.frames.map(b => new Uint8ClampedArray(b)), s0.det) });
    } else if (m.type === 'init') {
      s = setup(m.cfg, new Uint8ClampedArray(m.bg));
      if (m.bodyPx) s.det.bodyPx = m.bodyPx; // classical-v2: 붙은 덩어리 나누기 후보(split)도 검출
      postMessage({ type: 'ready' });
    } else if (m.type === 'frame') {
      const d = s.toMeters(detect(new Uint8ClampedArray(m.buf), s.det));
      postMessage({ type: 'det', t: m.t, ...d, buf: m.buf }, [m.buf]); // 버퍼는 돌려줘서 다시 씀
    }
  } catch (e) {
    postMessage({ type: 'error', message: e.message });
  }
};
