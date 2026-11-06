// 분석 워커: 프레임을 받아 선수·공을 찾고 m 좌표로 돌려준다.
import { setup } from './pipeline.js';
import { detect, medianBackground } from './vision.js';

let s = null;
onmessage = ({ data: m }) => {
  try {
    if (m.type === 'background') {
      const bg = medianBackground(m.frames.map(b => new Uint8ClampedArray(b)));
      postMessage({ type: 'background', bg: bg.buffer }, [bg.buffer]);
    } else if (m.type === 'init') {
      s = setup(m.cfg, new Uint8ClampedArray(m.bg));
      postMessage({ type: 'ready' });
    } else if (m.type === 'frame') {
      const d = s.toMeters(detect(new Uint8ClampedArray(m.buf), s.det));
      postMessage({ type: 'det', t: m.t, ...d, buf: m.buf }, [m.buf]); // 버퍼는 돌려줘서 다시 씀
    }
  } catch (e) {
    postMessage({ type: 'error', message: e.message });
  }
};
