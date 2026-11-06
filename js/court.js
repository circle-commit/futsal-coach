// 코트·히트맵 그리기 (m 좌표 → 캔버스)
export function fit(c, w, h) {
  const r = devicePixelRatio || 1;
  c.width = Math.round(w * r); c.height = Math.round(h * r);
  c.style.height = h + 'px';
  const x = c.getContext('2d'); x.setTransform(r, 0, 0, r, 0, 0);
  return x;
}
export const courtHeight = (w, L, W) => (w * (W + 2)) / (L + 2); // 둘레 1m 여백

/** 코트를 그리고 m→px 변환을 돌려준다 */
export function drawCourt(ctx, w, L, W) {
  const pad = w / (L + 2), s = (w - 2 * pad) / L, h = W * s + 2 * pad;
  ctx.fillStyle = '#2f7d5b'; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(pad, pad); ctx.scale(s, s);
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2 / s;
  ctx.strokeRect(0, 0, L, W);
  ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.lineTo(L / 2, W); ctx.stroke();
  ctx.beginPath(); ctx.arc(L / 2, W / 2, Math.min(3, W * 0.15), 0, 7); ctx.stroke();
  const r = Math.min(6, W * 0.3, L * 0.15), off = 1.5 * Math.min(1, W / 20), H = Math.PI / 2; // 표준 풋살 비율을 코트 크기에 맞춤
  for (const [gx, dir] of [[0, 1], [L, -1]]) {
    const ccw = dir < 0;
    ctx.beginPath();
    ctx.arc(gx, W / 2 - off, r, -H, ccw ? -Math.PI : 0, ccw);
    ctx.lineTo(gx + dir * r, W / 2 + off);
    ctx.arc(gx, W / 2 + off, r, ccw ? Math.PI : 0, H, ccw);
    ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillRect(gx - (dir > 0 ? 0.5 : 0), W / 2 - off, 0.5, 2 * off);
  }
  ctx.restore();
  return { X: m => pad + m * s, s, pad, h };
}

/** 머문 곳 밀도 → 흐린 열지도 캔버스 (코트 크기에 늘려 그리면 됨). paths: [x0,y0,x1,y1,...] 배열들 */
export function heatCanvas(paths, L, W) {
  const gx = 140, gy = Math.max(10, Math.round((gx * W) / L)), g = new Float32Array(gx * gy);
  for (const p of paths) for (let k = 0; k < p.length; k += 2) {
    if (p[k] == null) continue;
    const i = Math.floor((p[k] / L) * gx), j = Math.floor((p[k + 1] / W) * gy);
    if (i >= 0 && i < gx && j >= 0 && j < gy) g[j * gx + i]++;
  }
  const raw = new OffscreenCanvas(gx, gy), rc = raw.getContext('2d'), rd = rc.createImageData(gx, gy);
  let mx = 1; g.forEach(v => { if (v > mx) mx = v; });
  g.forEach((v, k) => { rd.data[k * 4 + 3] = Math.min(255, (v / mx) * 255 * 3); });
  rc.putImageData(rd, 0, 0);
  const c = document.createElement('canvas'); c.width = gx; c.height = gy;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.filter = 'blur(3px)'; x.drawImage(raw, 0, 0); x.filter = 'none';
  const b = x.getImageData(0, 0, gx, gy); let m2 = 1;
  for (let k = 3; k < b.data.length; k += 4) m2 = Math.max(m2, b.data[k]);
  for (let k = 0; k < gx * gy; k++) {
    const a = b.data[k * 4 + 3] / m2;
    const gg = a < 0.5 ? 460 * a : 230 - 400 * (a - 0.5);
    b.data.set([255, gg, 0, a > 0.04 ? 70 + a * 160 : 0], k * 4);
  }
  x.putImageData(b, 0, 0);
  return c;
}

export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
