// 픽셀 처리 (순수 함수). 브라우저 워커와 node 도구가 같이 쓴다.
// 프레임은 RGBA Uint8ClampedArray(w*h*4), 색상은 H 0~360, S·V 0~255.

// 4점 대응으로 3x3 호모그래피 (src → dst). 코트 모서리(px) ↔ 실제 좌표(m)
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) { // 가우스 소거
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('코트 모서리 4점이 한 줄 위에 있어요');
    for (let r = 0; r < 8; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return [h, mx ? (d / mx) * 255 : 0, mx];
}
const inHue = (h, [lo, hi]) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi); // lo>hi면 0°를 넘어가는 범위(분홍·빨강)

// 여러 프레임의 픽셀별 중앙값 = 움직이는 사람이 지워진 빈 코트
export function medianBackground(frames) {
  const n = frames.length, len = frames[0].length, out = new Uint8ClampedArray(len), buf = new Uint8Array(n);
  for (let i = 0; i < len; i++) {
    if ((i & 3) === 3) { out[i] = 255; continue; }
    for (let k = 0; k < n; k++) buf[k] = frames[k][i];
    buf.sort();
    out[i] = buf[n >> 1];
  }
  return out;
}

// 정사각 커널 팽창/침식. 가로·세로를 따로 돌며 창 안의 1 개수를 센다 (O(픽셀))
export function morph(mask, w, h, r, dilate) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = 0; x < Math.min(r, w); x++) s += mask[o + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) s += mask[o + x + r];
      if (x - r - 1 >= 0) s -= mask[o + x - r - 1];
      const n = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
      tmp[o + x] = dilate ? (s > 0 ? 1 : 0) : (s === n ? 1 : 0);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < Math.min(r, h); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) s += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * w + x];
      const n = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
      out[y * w + x] = dilate ? (s > 0 ? 1 : 0) : (s === n ? 1 : 0);
    }
  }
  return out;
}

// 8방향 연결 덩어리 번호 매기기
export function components(mask, w, h) {
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    lab[i] = ++n; let sp = 0; stack[sp++] = i;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
      }
    }
  }
  return { lab, n };
}

// 코트(여유 pad m 포함) 안쪽만 1인 마스크
export function courtMask(Hpx2m, w, h, L, W, pad) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = applyH(Hpx2m, x, y);
    m[y * w + x] = u > -pad && u < L + pad && v > -pad && v < W + pad ? 1 : 0;
  }
  return m;
}

// 배경과 다른(=움직이는) 픽셀
export function foreground(frame, bg, roi, w, h, thr, openR) {
  const fg = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (!roi[i]) continue;
    const d = Math.max(Math.abs(frame[p] - bg[p]), Math.abs(frame[p + 1] - bg[p + 1]), Math.abs(frame[p + 2] - bg[p + 2]));
    fg[i] = d > thr ? 1 : 0;
  }
  return morph(morph(fg, w, h, openR, false), w, h, openR, true); // 열기: 라인 떨림·잡티 제거
}

// 붙은 같은 팀 덩어리 나누기 (classical-v2): 덩어리 안 그 팀 색 픽셀이 몸 크기의 ratio배 이상이면 k = round(픽셀 ÷ 몸 크기)명(2~maxK)으로 보고
// 그 팀 색 픽셀을 k-평균으로 나눈 후보를 함께 낸다. 나눈 조각이 몸 크기의 minPart배보다 작으면 k를 줄인다(팔·자세로 커진 한 아이를 둘로 만들지 않게).
// 후보를 실제로 쓸지는 추적 단계가 정한다: 팀이 모자라고, 그 덩어리를 이어 온 트랙이 있고, 그 트랙이 혼자서도 큰 사람이 아닐 때만 (track.js runTeamV2)
export const SPLIT = Object.freeze({ ratio: 1.6, maxK: 4, minPart: 0.5 });

// 결정적 k-평균: 덩어리 중심에서 가장 먼 점, 그다음 이미 고른 점들에서 가장 먼 점… 을 시작점으로 10번 반복 (같으면 번호 작은 쪽)
function kmeans2(xs, ys, k) {
  const n = xs.length; let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += xs[i]; cy += ys[i]; }
  cx /= n; cy /= n;
  const C = []; let bi = 0, bv = -1;
  for (let i = 0; i < n; i++) { const d = (xs[i] - cx) ** 2 + (ys[i] - cy) ** 2; if (d > bv) { bv = d; bi = i; } }
  C.push([xs[bi], ys[bi]]);
  while (C.length < k) {
    bi = 0; bv = -1;
    for (let i = 0; i < n; i++) { let m = Infinity; for (const c of C) m = Math.min(m, (xs[i] - c[0]) ** 2 + (ys[i] - c[1]) ** 2); if (m > bv) { bv = m; bi = i; } }
    C.push([xs[bi], ys[bi]]);
  }
  const lab = new Int32Array(n);
  for (let it = 0; it < 10; it++) {
    for (let i = 0; i < n; i++) { let b = 0, d0 = Infinity; for (let j = 0; j < C.length; j++) { const d = (xs[i] - C[j][0]) ** 2 + (ys[i] - C[j][1]) ** 2; if (d < d0) { d0 = d; b = j; } } lab[i] = b; }
    const S = C.map(() => [0, 0, 0]);
    for (let i = 0; i < n; i++) { S[lab[i]][0] += xs[i]; S[lab[i]][1] += ys[i]; S[lab[i]][2]++; }
    S.forEach((s, j) => { if (s[2]) C[j] = [s[0] / s[2], s[1] / s[2]]; });
  }
  const sz = C.map(() => 0); for (let i = 0; i < n; i++) sz[lab[i]]++;
  return C.map((c, j) => ({ x: c[0], y: c[1], n: sz[j] })).filter(c => c.n > 0);
}

// 팀 색 덩어리: 픽셀마다 팀을 정하고 조끼 조각을 한 사람으로 묶어, 덩어리마다 남길 팀 검출을 고른다 (detect·bodySizes가 같이 씀)
function teamBlobs(frame, cfg) {
  const { w, h, teams } = cfg, N = w * h;
  const fg = foreground(frame, cfg.bg, cfg.roi, w, h, cfg.thr, cfg.openR);
  const T = teams.length, teamOf = new Int8Array(N).fill(-1), any = new Uint8Array(N), white = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (!fg[i]) continue;
    const [H, S, V] = hsv(frame[p], frame[p + 1], frame[p + 2]);
    if (V > 60) {
      // 범위 안에 드는 팀 중 색 중심이 가장 가까운 팀 (파랑 조끼 그늘 vs 연보라 옷처럼 범위가 겹칠 때)
      let best = -1, bd = Infinity;
      for (let t = 0; t < T; t++) {
        const tm = teams[t];
        if (!inHue(H, tm.hue) || S < tm.sat[0] || S > tm.sat[1]) continue;
        const dh = (((H - tm.mid[0] + 540) % 360) - 180) / 15, ds = (S - tm.mid[1]) / 60, d = dh * dh + ds * ds;
        if (d < bd) { bd = d; best = t; }
      }
      if (best >= 0) { teamOf[i] = best; any[i] = 1; }
    }
    if (S < 60 && V > 170) white[i] = 1;
  }
  // 조끼 조각을 한 사람으로 묶고, 붙어 있는 다른 팀 선수는 색별로 따로 센다
  const { lab, n } = components(morph(any, w, h, cfg.joinR, true), w, h);
  const cnt = new Float64Array((n + 1) * T), sx = new Float64Array((n + 1) * T), sy = new Float64Array((n + 1) * T);
  for (let i = 0; i < N; i++) {
    const t = teamOf[i]; if (t < 0) continue;
    const k = lab[i] * T + t; cnt[k]++; sx[k] += i % w; sy[k] += (i / w) | 0;
  }
  const kept = []; // 남길 팀 검출 { t, n: 색 픽셀 수, x, y, key: 덩어리×팀 } (players에 들어갈 순서 그대로)
  for (let l = 1; l <= n; l++) {
    let top = 0; for (let t = 0; t < T; t++) top = Math.max(top, cnt[l * T + t]);
    // 한 덩어리 안의 적은 쪽 색은 옷 가장자리·그늘일 가능성이 커서, 큰 쪽의 30% 이상이고
    // 중심이 떨어져 있을 때(=실제로 두 아이가 붙어 있을 때)만 따로 센다
    const keep = [];
    for (let t = 0; t < T; t++) {
      const k = l * T + t;
      if (cnt[k] >= cfg.minPx && cnt[k] >= 0.3 * top) keep.push({ t, n: cnt[k], x: sx[k] / cnt[k], y: sy[k] / cnt[k], key: k });
    }
    keep.sort((a, b) => b.n - a.n);
    const near = 2.5 * cfg.joinR; // 약 0.4m
    keep.forEach((c, i) => { if (keep.slice(0, i).every(o => Math.hypot(o.x - c.x, o.y - c.y) > near)) kept.push(c); });
  }
  return { fg, white, teamOf, lab, T, kept };
}

// 큰 덩어리(몸 크기 ratio배 이상)의 나누기 후보: [[팀, players[팀]에서의 번호, [[x,y],…]], …] (덩어리 번호 순)
function splitBlobs(kept, teamOf, lab, T, w, N, bodyPx) {
  const big = new Map(), seen = new Array(T).fill(0);
  for (const c of kept) {
    const j = seen[c.t]++, s1 = bodyPx[c.t];
    if (s1 > 0 && c.n >= SPLIT.ratio * s1) big.set(c.key, { c, j, k: Math.min(SPLIT.maxK, Math.max(2, Math.round(c.n / s1))) });
  }
  if (!big.size) return [];
  const pts = new Map([...big.keys()].map(k => [k, { xs: [], ys: [] }])); // 큰 덩어리만 그 팀 색 픽셀을 모은다
  for (let i = 0; i < N; i++) { const t = teamOf[i]; if (t < 0) continue; const q = pts.get(lab[i] * T + t); if (q) { q.xs.push(i % w); q.ys.push((i / w) | 0); } }
  const out = [];
  for (const [key, { c, j, k }] of [...big.entries()].sort((a, b) => a[0] - b[0])) {
    const { xs, ys } = pts.get(key);
    for (let kk = k; kk >= 2; kk--) {
      const parts = kmeans2(xs, ys, kk);
      if (parts.length === kk && parts.every(p => p.n >= SPLIT.minPart * bodyPx[c.t])) {
        out.push([c.t, j, parts.sort((a, b) => a.x - b.x || a.y - b.y).map(p => [p.x, p.y])]);
        break;
      }
    }
  }
  return out;
}

/** 팀별 몸 크기(조끼 색 픽셀 수): 영상 전체에서 고르게 고른 장면들(배경을 만든 30장)에서, 그 팀 검출 수가 가장 흔한 수(=인원)인
 * 장면들의 검출 색 픽셀 수 중앙값. 팀이 안 보이면 0(나누지 않음). cfg = setup(...).det (배경 포함) */
export function bodySizes(frames, cfg) {
  const T = cfg.teams.length, per = Array.from({ length: T }, () => []);
  for (const f of frames) {
    const by = Array.from({ length: T }, () => []);
    for (const c of teamBlobs(f, cfg).kept) by[c.t].push(c.n);
    by.forEach((l, t) => per[t].push(l));
  }
  return per.map(lists => {
    const freq = new Map(); for (const l of lists) freq.set(l.length, (freq.get(l.length) || 0) + 1);
    let mode = 0, best = -1;
    for (const [len, c] of [...freq].sort((a, b) => a[0] - b[0])) if (c > best || (c === best && len > mode)) { best = c; mode = len; } // 같으면 큰 수
    const ns = lists.filter(l => l.length === mode).flat().sort((a, b) => a - b);
    return mode > 0 && ns.length ? ns[ns.length >> 1] : 0;
  });
}

/** 한 프레임에서 팀별 선수 위치와 공 후보(px)를 찾는다.
 * cfg: { bg, roi, w, h, thr, openR, joinR, minPx, teams:[{hue:[lo,hi], sat:[lo,hi]}], ball:{minA, maxA}, bodyPx? }
 * cfg.bodyPx(팀별 몸 크기, classical-v2)가 있으면 붙은 덩어리 나누기 후보 split도 낸다. players는 그것과 상관없이 늘 같다 */
export function detect(frame, cfg) {
  const { w, h, teams } = cfg, N = w * h;
  const { fg, white, teamOf, lab: tlab, T, kept } = teamBlobs(frame, cfg);
  const players = teams.map(() => []);
  for (const c of kept) players[c.t].push([c.x, c.y]);
  const split = cfg.bodyPx ? splitBlobs(kept, teamOf, tlab, T, w, N, cfg.bodyPx) : [];
  const ball = [];
  if (cfg.ball) {
    const { lab, n } = components(white, w, h);
    // 흰 점이 아이 몸(다리)과 이어진 덩어리면 양말·신발이거나 발밑 공, 따로 떨어져 있으면 굴러가는 공
    const body = components(fg, w, h), bodyArea = new Int32Array(body.n + 1), first = new Int32Array(n + 1).fill(-1);
    for (let i = 0; i < N; i++) if (body.lab[i]) bodyArea[body.lab[i]]++;
    const cnt = new Float64Array(n + 1), sx = new Float64Array(n + 1), sy = new Float64Array(n + 1);
    const x0 = new Float64Array(n + 1).fill(1e9), x1 = new Float64Array(n + 1).fill(-1), y0 = new Float64Array(n + 1).fill(1e9), y1 = new Float64Array(n + 1).fill(-1);
    for (let i = 0; i < N; i++) {
      const l = lab[i]; if (!l) continue;
      const x = i % w, y = (i / w) | 0;
      cnt[l]++; sx[l] += x; sy[l] += y; if (first[l] < 0) first[l] = i;
      if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x; if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
    }
    for (let l = 1; l <= n; l++) {
      const bw = x1[l] - x0[l] + 1, bh = y1[l] - y0[l] + 1;
      if (cnt[l] < cfg.ball.minA || cnt[l] > cfg.ball.maxA) continue;
      if (Math.max(bw, bh) > 2 * Math.min(bw, bh) || cnt[l] < 0.45 * bw * bh) continue; // 공은 동그랗고 꽉 참
      const bx = Math.round(sx[l] / cnt[l]), by = Math.round(sy[l] / cnt[l]);
      if (nearWhite(cfg.bg, w, h, bx, by, 3)) continue; // 원래 흰 라인이 있던 자리(라인 떨림)
      ball.push([sx[l] / cnt[l], sy[l] / cnt[l], bodyArea[body.lab[first[l]]] < 3 * cnt[l] ? 1 : 0]); // 셋째 값: 1 = 혼자 떨어진 공
    }
  }
  return split.length ? { players, ball, split } : { players, ball }; // 후보가 없으면 예전과 같은 모양
}

function nearWhite(bg, w, h, cx, cy, r) {
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
    const p = (y * w + x) * 4, [, S, V] = hsv(bg[p], bg[p + 1], bg[p + 2]);
    if (S < 70 && V > 150) return true;
  }
  return false;
}

// 선생님이 찍은 점 주변의 움직이는 색 픽셀로 팀 색 범위를 잡는다
export function colorFromClick(frame, bg, w, h, cx, cy, r) {
  const hs = [], ss = [];
  for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) {
    const p = (y * w + x) * 4;
    const d = Math.max(Math.abs(frame[p] - bg[p]), Math.abs(frame[p + 1] - bg[p + 1]), Math.abs(frame[p + 2] - bg[p + 2]));
    if (d < 40) continue;
    const [H, S, V] = hsv(frame[p], frame[p + 1], frame[p + 2]);
    if (S > 50 && V > 60) { hs.push(H); ss.push(S); }
  }
  if (hs.length < 15) return null;
  // 색상은 원형이라 가장 많이 모인 곳을 중심으로 잡고 거기서 ±각도를 잰다
  const bins = new Array(36).fill(0); hs.forEach(x => bins[Math.floor(x / 10) % 36]++);
  const c = (bins.indexOf(Math.max(...bins)) + 0.5) * 10;
  const near = hs.map((x, i) => [((x - c + 540) % 360) - 180, ss[i]]).filter(([d]) => Math.abs(d) < 35);
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
  const dh = near.map(a => a[0]), sv = near.map(a => a[1]);
  const lo = (c + pct(dh, 0.1) - 6 + 360) % 360, hi = (c + pct(dh, 0.9) + 6) % 360;
  const rgb = hsvToRgb(c, 200, 220);
  return {
    hue: [Math.round(lo), Math.round(hi)], sat: [Math.max(40, Math.round(pct(sv, 0.1) - 25)), Math.min(255, Math.round(pct(sv, 0.9) + 25))],
    mid: [Math.round((c + pct(dh, 0.5) + 360) % 360), Math.round(pct(sv, 0.5))], color: rgb,
  };
}

const span = ([lo, hi]) => (lo <= hi ? [[lo, hi]] : [[lo, 360], [0, hi]]);
export const hueOverlap = (a, b) => span(a).some(([x0, x1]) => span(b).some(([y0, y1]) => x0 <= y1 && y0 <= x1));
export const colorsOverlap = (a, b) => hueOverlap(a.hue, b.hue) && a.sat[0] <= b.sat[1] && b.sat[0] <= a.sat[1];

export function hsvToRgb(h, s, v) {
  s /= 255; const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(q => Math.round(q + m).toString(16).padStart(2, '0')).join('');
}
