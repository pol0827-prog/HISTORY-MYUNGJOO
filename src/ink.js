/* 필기 도구 (교과서 보기용): 펜 · 형광펜 · 곧은 선 · 동그라미·네모·세모·별 · 지우개
   좌표는 쪽 크기의 1/10000 단위로 저장해서 확대·축소해도 같은 자리에 남음 */
const N = 10000;
export const INK_TOOLS = [
  { k: 'none', i: '🖐', t: '손 (필기 끄기, 화면 넘기기)' }, { k: 'pen', i: '✏️', t: '펜' }, { k: 'hl', i: '🖍', t: '형광펜 (반투명 굵게)' },
  { k: 'line', i: '📏', t: '자로 긋는 곧은 밑줄·선 (거의 수평이면 수평으로 맞춤)' }, { k: 'o', i: '◯', t: '동그라미' }, { k: 'r', i: '▢', t: '네모' },
  { k: 'tri', i: '△', t: '세모' }, { k: 'star', i: '☆', t: '별' }, { k: 'erase', i: '🧽', t: '지우개 (필기만 지워요)' },
];
export const INK_COLORS = [
  { c: '#e53935', t: '빨강' }, { c: '#1e63d6', t: '파랑' }, { c: '#111111', t: '검정' },
  { c: '#18a058', t: '초록' }, { c: '#ffd400', t: '노랑' }, { c: '#ff7a00', t: '주황' },
];
const WIDTHS = [{ w: 2, t: '가늘게' }, { w: 4, t: '보통' }, { w: 8, t: '굵게' }];

function starPts(x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, pts = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? 0.42 : 1; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); }
  return pts;
}

export function drawStrokes(c, strokes) {
  const W = c.clientWidth, H = c.clientHeight; if (!W) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const X = (v) => (v / N) * W, Y = (v) => (v / N) * H, S = (w) => (w / 1000) * W;
  strokes.forEach((s) => {
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = s.c; g.lineWidth = Math.max(1, S(s.w * 1.2));
    g.globalCompositeOperation = s.t === 'erase' ? 'destination-out' : s.t === 'hl' ? 'multiply' : 'source-over';
    g.globalAlpha = s.t === 'hl' ? 0.4 : 1;
    const p = s.p; g.beginPath();
    if (['pen', 'hl', 'erase'].includes(s.t)) {
      g.moveTo(X(p[0]), Y(p[1])); if (p.length === 2) g.lineTo(X(p[0]) + 0.1, Y(p[1]));
      for (let i = 2; i < p.length - 2; i += 2) { const mx = (X(p[i]) + X(p[i + 2])) / 2, my = (Y(p[i + 1]) + Y(p[i + 3])) / 2; g.quadraticCurveTo(X(p[i]), Y(p[i + 1]), mx, my); }
      if (p.length > 2) g.lineTo(X(p[p.length - 2]), Y(p[p.length - 1]));
    } else {
      const [x1, y1, x2, y2] = [X(p[0]), Y(p[1]), X(p[2]), Y(p[3])];
      if (s.t === 'line') { g.moveTo(x1, y1); g.lineTo(x2, y2); }
      if (s.t === 'r') g.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      if (s.t === 'o') g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      if (s.t === 'tri') { g.moveTo((x1 + x2) / 2, Math.min(y1, y2)); g.lineTo(Math.max(x1, x2), Math.max(y1, y2)); g.lineTo(Math.min(x1, x2), Math.max(y1, y2)); g.closePath(); }
      if (s.t === 'star') { starPts(x1, y1, x2, y2).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }
    }
    g.stroke(); g.restore();
  });
}

/* canvas 위에서 필기하고, sideEl에 세로 도구를 그림
   get(): 지금 쪽의 필기 배열, set(arr): 바뀐 필기를 저장 */
export function createInk({ canvas, sideEl, get, set, toast }) {
  let tool = 'none', color = INK_COLORS[0].c, width = 4, cur = null;
  const redraw = () => drawStrokes(canvas, [...get(), ...(cur ? [cur] : [])]);
  function renderSide() {
    sideEl.innerHTML = INK_TOOLS.map((x) => `<button type="button" class="cb-t ${tool === x.k ? 'on' : ''}" data-tool="${x.k}" title="${x.t}" aria-label="${x.t}">${x.i}</button>`).join('')
      + '<i class="cb-sep"></i>'
      + INK_COLORS.map((x) => `<button type="button" class="cb-c ${color === x.c ? 'on' : ''}" data-ink="${x.c}" title="${x.t}" aria-label="필기 색: ${x.t}" style="--dot:${x.c}"></button>`).join('')
      + '<i class="cb-sep"></i>'
      + WIDTHS.map((x) => `<button type="button" class="cb-w ${width === x.w ? 'on' : ''}" data-w="${x.w}" title="굵기: ${x.t}" aria-label="굵기: ${x.t}"><i style="height:${Math.max(2, x.w)}px"></i></button>`).join('')
      + '<i class="cb-sep"></i>'
      + '<button type="button" class="cb-t" data-act="undo" title="방금 필기 되돌리기" aria-label="되돌리기">↶</button>'
      + '<button type="button" class="cb-t" data-act="clear" title="이 쪽 필기 모두 지우기" aria-label="이 쪽 필기 모두 지우기">🗑</button>';
    canvas.classList.toggle('on', tool !== 'none');
    canvas.dataset.tool = tool;
  }
  sideEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) tool = b.dataset.tool;
    if (b.dataset.ink) { color = b.dataset.ink; if (tool === 'none' || tool === 'erase') tool = 'pen'; }
    if (b.dataset.w) width = Number(b.dataset.w);
    if (b.dataset.act === 'undo') { const a = get(); if (a.length) { set(a.slice(0, -1)); redraw(); } }
    if (b.dataset.act === 'clear') {
      if (!get().length) return;
      if (!b.dataset.armed) { b.dataset.armed = '1'; toast('한 번 더 누르면 이 쪽 필기를 모두 지워요'); setTimeout(() => delete b.dataset.armed, 3000); return; }
      set([]); redraw();
    }
    renderSide();
  });
  const toN = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * N), Math.round(((e.clientY - r.top) / r.height) * N)]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (tool === 'none') return; e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    const p = toN(e);
    cur = ['pen', 'hl', 'erase'].includes(tool) ? { t: tool, c: color, w: tool === 'erase' ? width * 5 : tool === 'hl' ? width * 4 : width, p: [...p] } : { t: tool, c: color, w: width, p: [...p, ...p] };
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return; const [x, y] = toN(e);
    if (['pen', 'hl', 'erase'].includes(cur.t)) { const n = cur.p.length; if (Math.hypot(x - cur.p[n - 2], y - cur.p[n - 1]) > 8) cur.p.push(x, y); }
    else {
      cur.p[2] = x; cur.p[3] = y;
      if (cur.t === 'line' || cur.t === 'hl') {
        const dx = x - cur.p[0], dy = y - cur.p[1], ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
        if (ang < 8 || ang > 172) cur.p[3] = cur.p[1]; else if (Math.abs(ang - 90) < 8) cur.p[2] = cur.p[0];
      }
    }
    redraw();
  });
  const end = () => {
    if (!cur) return;
    const ok = ['pen', 'hl', 'erase'].includes(cur.t) || Math.hypot(cur.p[2] - cur.p[0], cur.p[3] - cur.p[1]) > 20;
    if (ok) set([...get(), cur]); cur = null; redraw();
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  renderSide();
  return { redraw, renderSide, isDrawing: () => tool !== 'none' };
}
