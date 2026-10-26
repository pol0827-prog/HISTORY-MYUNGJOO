/* ================= 🧑‍🏫 칠판 판서 =================
   settings/board : 지금 칠판 (누구나 읽기, 교사만 쓰기)
   boards/{id}    : 저장된 판서 모음 (교사만)
   칠판 화면에서 바로 쓰고·고치고·지우고, 오른쪽 세로 도구로 필기·도형·지우개를 씀.
   강의 내용 쓰는 법: # 소제목 · - 글머리표 · ! 중요 · **강조** · -> 화살표 · 빈 줄 = 칸 띄우기 */
import { doc, setDoc, deleteDoc, collection, onSnapshot, query, orderBy, serverTimestamp } from 'firebase/firestore';

const FONTS = [
  { k: 'pen', t: '분필 손글씨', css: "'Nanum Pen Script',cursive" },
  { k: 'gaegu', t: '개구 손글씨', css: "'Gaegu',cursive" },
  { k: 'melody', t: '하이멜로디', css: "'Hi Melody',cursive" },
  { k: 'dohyeon', t: '도현 굵은체', css: "'Do Hyeon',sans-serif" },
  { k: 'dodum', t: '고운돋움', css: "'Gowun Dodum',sans-serif" },
  { k: 'batang', t: '고운바탕', css: "'Gowun Batang',serif" },
  { k: 'gothic', t: '고딕', css: "'IBM Plex Sans KR',sans-serif" },
];
const COLORS = [
  { c: '#f4f1e8', t: '흰 분필' }, { c: '#ffe27a', t: '노랑' }, { c: '#ff9fb8', t: '분홍' },
  { c: '#9fd8ff', t: '하늘' }, { c: '#b8f0a0', t: '연두' }, { c: '#ffb870', t: '주황' },
];
const PARTS = [
  // 대단원·소단원·학습 주제·성취기준은 같은 크기로 (칠판 높이의 5%)
  { k: 'unit', t: '대단원명', base: 5 }, { k: 'sub', t: '소단원명', base: 5 }, { k: 'topic', t: '학습 주제', base: 5 },
  { k: 'std', t: '성취기준', base: 5 }, { k: 'body', t: '강의 내용', base: 5 },
];
const DEF_STYLE = {
  unit: { f: 'pen', s: 100, c: '#9fd8ff' }, sub: { f: 'pen', s: 100, c: '#9fd8ff' }, topic: { f: 'pen', s: 100, c: '#ffe27a' },
  std: { f: 'pen', s: 100, c: '#e9e5d8' }, body: { f: 'pen', s: 0, c: '#f4f1e8' },   // 강의 내용 s=0 → 자동 맞춤
};
const EMPTY = () => ({ id: '', unit: '', sub: '', topic: '', std: '', body: '', body2: '', cols: 1, style: JSON.parse(JSON.stringify(DEF_STYLE)), ink: [], viz: null, noteAlt: null });
const TXT = ['unit', 'sub', 'topic', 'std', 'body', 'body2'];
const clean = (b) => {
  const x = EMPTY(); if (!b) return x;
  TXT.forEach((k) => (x[k] = typeof b[k] === 'string' ? b[k] : ''));
  x.id = b.id || ''; x.cols = b.cols === 2 ? 2 : 1;
  PARTS.forEach(({ k }) => (x.style[k] = { ...DEF_STYLE[k], ...(b.style?.[k] || {}) }));
  x.ink = Array.isArray(b.ink) ? b.ink : []; x.viz = b.viz && b.viz.data ? b.viz : null;
  x.noteAlt = b.noteAlt && typeof b.noteAlt.body === 'string' ? { body: b.noteAlt.body, body2: b.noteAlt.body2 || '', isOrig: !!b.noteAlt.isOrig } : null;
  return x;
};

export function initBoard(ctx) {
  const { $, esc, toast, db, auth, DAYS } = ctx;
  let board = EMPTY();          // 지금 칠판 (화면에 보이는 것)
  let dirty = false;            // 저장 안 된 필기·모양 바꾸기
  let editing = false;          // 내용 편집 중
  let saved = [];               // 저장된 판서 목록 (교사)
  let unsubSaved = null;

  /* ---------- 글자 모양 ---------- */
  const fontCss = (k) => (FONTS.find((f) => f.k === k) || FONTS[0]).css;
  const partStyle = (k, extra = '') => partStyleOf(editing && draft ? draft : board, k, extra);
  const partStyleOf = (b, k, extra = '') => { const s = b.style[k], base = PARTS.find((p) => p.k === k).base;
    return `font-family:${fontCss(s.f)};color:${s.c};${s.s ? `font-size:calc(var(--cb-u) * ${(base * s.s / 100).toFixed(2)})` : ''};${extra}`; };
  const chalkInline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<em>$1</em>').replace(/(->|=>)/g, '→');
  function chalkBody(body) {
    let html = '', inList = false;
    const close = () => { if (inList) { html += '</ul>'; inList = false; } };
    String(body || '').replace(/\r/g, '').split('\n').forEach((ln) => {
      const t = ln.trim();
      if (!t) { close(); html += '<div class="cb-gap"></div>'; return; }
      const h = t.match(/^#+\s*(.+)/), li = t.match(/^[-•*·]\s*(.+)/), imp = t.match(/^!\s*(.+)/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${chalkInline(li[1])}</li>`; return; }
      close();
      html += h ? `<h3>${chalkInline(h[1])}</h3>` : imp ? `<p class="imp">${chalkInline(imp[1])}</p>` : `<p>${chalkInline(t)}</p>`;
    });
    close(); return html;
  }
  const dateText = (withTime) => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})${withTime ? ` <b>${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${p(d.getMinutes())}</b>` : ''}`; };

  /* ---------- 칠판 그리기 (내용) ---------- */
  const isFull = () => !!document.fullscreenElement || !!$('#boardWrap').classList.contains('cb-fake-full');
  function headHTML(b) {
    const tag = (t, cls = '') => `<span class="cb-tag ${cls}">${t}</span>`;
    const path = [b.unit ? `<span class="cb-unit" style="${partStyle('unit')}">${tag('대단원', 'sky')}${chalkInline(b.unit)}</span>` : '',
      b.sub ? `<span class="cb-sub" style="${partStyle('sub')}">${tag('소단원', 'sky')}${chalkInline(b.sub)}</span>` : ''].filter(Boolean).join('');
    return `<div class="cb-head">
      ${path ? `<div class="cb-path">${path}</div>` : ''}
      ${b.topic ? `<h2 class="cb-topic" style="${partStyle('topic')}">${tag('학습 주제')}${chalkInline(b.topic)}</h2>` : ''}
      ${b.std ? `<div class="cb-std" style="${partStyle('std')}">${tag('성취기준')}${chalkInline(b.std)}</div>` : ''}
    </div>`;
  }
  function bodyHTML(b) {
    if (b.viz?.show && b.viz.data) return `<div class="cb-body cb-viz">${vizSVG(b.viz)}</div>`;
    const empty = !b.topic && !b.body && !b.body2 && !b.unit && !b.sub;
    if (empty) return `<div class="cb-body"><p class="cb-empty">${ctx.isTeacher() ? '아래 [✏️ 내용 쓰기]를 눌러 오늘 강의 내용을 칠판에 적어 보세요' : '선생님이 아직 칠판에 적지 않았어요'}</p></div>`;
    const st = partStyle('body');
    return b.cols === 2
      ? `<div class="cb-body cols2" style="${st}"><div class="cb-col">${chalkBody(b.body)}</div><div class="cb-col">${chalkBody(b.body2)}</div></div>`
      : `<div class="cb-body" style="${st}"><div class="cb-col">${chalkBody(b.body)}</div></div>`;
  }
  function editHTML(b) {
    const inp = (k, ph, max = 80) => `<input class="cb-in" data-k="${k}" maxlength="${max}" placeholder="${ph}" value="${esc(b[k])}" style="${partStyle(k)}">`;
    const ta = (k, ph, part = k) => `<textarea class="cb-in" data-k="${k}" maxlength="3000" placeholder="${ph}" style="${partStyle(part === 'body2' ? 'body' : part)}">${esc(b[k])}</textarea>`;
    return `<div class="cb-head cb-edit">
        <div class="cb-path"><span class="cb-unit"><span class="cb-tag sky">대단원</span>${inp('unit', '대단원명')}</span><span class="cb-sub"><span class="cb-tag sky">소단원</span>${inp('sub', '소단원명')}</span></div>
        <div class="cb-topic"><span class="cb-tag">학습 주제</span>${inp('topic', '학습 주제를 적어요')}</div>
        <div class="cb-std" style="color:${b.style.std.c}"><span class="cb-tag">성취기준</span>${inp('std', '성취기준 (예: [12세사04-03] …)', 300)}</div>
      </div>
      <div class="cb-body cb-edit ${b.cols === 2 ? 'cols2' : ''}">
        ${ta('body', b.cols === 2 ? '왼쪽 칸 강의 내용' : '오늘의 강의 내용\n# 소제목   - 글머리표   ! 중요   **강조**   -> 화살표', 'body')}
        ${b.cols === 2 ? ta('body2', '오른쪽 칸 강의 내용', 'body2') : ''}
      </div>
      <div class="cb-edit-hint"># 소제목(노란 분필) · - 글머리표 · ! 중요(분홍) · **강조** · -&gt; 화살표 · 빈 줄 = 칸 띄우기</div>`;
  }
  function renderContent() {
    const b = editing ? draft : board;
    $('#cbContent').innerHTML = (editing ? editHTML(b) : headHTML(b) + bodyHTML(b))
      + `<div class="cb-date" id="cbDate">${dateText(isFull())}</div><div class="cb-tray" aria-hidden="true"><i></i><i class="y"></i><i class="p"></i><b></b></div>`;
    $('#chalkboard').classList.toggle('editing', editing);
    renderTools();
    requestAnimationFrame(() => { fit(); drawInk(); });
  }
  let draft = null;

  /* ---------- 강의 내용 크기 자동 맞춤 ---------- */
  function fit() {
    const el = $('#chalkboard'); if (!el || !el.offsetWidth) return;
    const W = el.clientWidth, H = el.clientHeight, u = Math.min(H, W * 9 / 16) / 100;
    el.style.setProperty('--cb-u', u + 'px');
    const body = el.querySelector('.cb-body:not(.cb-edit):not(.cb-viz)'); if (!body) return;
    const cols = [...body.querySelectorAll('.cb-col')];
    const s = board.style.body.s;
    if (s) { body.style.fontSize = `calc(var(--cb-u) * ${(5 * s / 100).toFixed(2)})`; body.classList.add('fixed'); return; }
    body.classList.remove('fixed');
    const over = () => cols.some((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1);
    let fs = u * (board.cols === 2 ? 4.8 : 6.2); const min = Math.max(11, u * 2.4);
    body.style.fontSize = fs + 'px';
    for (let k = 0; k < 50 && over() && fs > min; k++) { fs *= 0.94; body.style.fontSize = fs + 'px'; }
  }

  /* ---------- 오른쪽 세로 도구 (필기) ---------- */
  const TOOLS = [
    { k: 'none', i: '🖐', t: '손 (필기 끄기)' }, { k: 'pen', i: '✏️', t: '분필 펜' }, { k: 'hl', i: '🖍', t: '형광 분필 (반투명 굵게)' },
    { k: 'line', i: '📏', t: '자로 긋는 곧은 밑줄·선 (거의 수평이면 수평으로 맞춤)' }, { k: 'o', i: '◯', t: '동그라미' }, { k: 'r', i: '▢', t: '네모' },
    { k: 'tri', i: '△', t: '세모' }, { k: 'star', i: '☆', t: '별' }, { k: 'erase', i: '🧽', t: '지우개 (필기만 지워요)' },
  ];
  const WIDTHS = [{ w: 3, t: '가늘게' }, { w: 6, t: '보통' }, { w: 11, t: '굵게' }];
  let tool = 'none', inkColor = COLORS[0].c, inkW = 6;
  function renderTools() {
    $('#cbSide').innerHTML = TOOLS.map((x) => `<button type="button" class="cb-t ${tool === x.k ? 'on' : ''}" data-tool="${x.k}" title="${x.t}" aria-label="${x.t}">${x.i}</button>`).join('')
      + '<i class="cb-sep"></i>'
      + COLORS.map((x) => `<button type="button" class="cb-c ${inkColor === x.c ? 'on' : ''}" data-ink="${x.c}" title="${x.t}" aria-label="필기 색: ${x.t}" style="--dot:${x.c}"></button>`).join('')
      + '<i class="cb-sep"></i>'
      + WIDTHS.map((x) => `<button type="button" class="cb-w ${inkW === x.w ? 'on' : ''}" data-w="${x.w}" title="굵기: ${x.t}" aria-label="굵기: ${x.t}"><i style="height:${Math.max(2, x.w / 2)}px"></i></button>`).join('')
      + '<i class="cb-sep"></i>'
      + '<button type="button" class="cb-t" data-act="undo" title="방금 필기 되돌리기" aria-label="되돌리기">↶</button>'
      + '<button type="button" class="cb-t" data-act="clear" title="필기 모두 지우기" aria-label="필기 모두 지우기">🗑</button>';
    $('#cbInk').classList.toggle('on', tool !== 'none');
    $('#chalkboard').dataset.tool = tool;
  }
  $('#cbSide').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) tool = b.dataset.tool;
    if (b.dataset.ink) { inkColor = b.dataset.ink; if (tool === 'none' || tool === 'erase') tool = 'pen'; }
    if (b.dataset.w) inkW = Number(b.dataset.w);
    if (b.dataset.act === 'undo') { if (board.ink.length) { board.ink = board.ink.slice(0, -1); touch(); drawInk(); } }
    if (b.dataset.act === 'clear') { if (!board.ink.length) return; if (!confirmOnce(b, '한 번 더 누르면 필기를 모두 지워요')) return; board.ink = []; touch(); drawInk(); }
    renderTools();
  });
  // 실수로 지우지 않게 두 번 눌러야 하는 버튼
  function confirmOnce(b, msg) {
    if (b.dataset.armed) { delete b.dataset.armed; return true; }
    b.dataset.armed = '1'; toast(msg); setTimeout(() => delete b.dataset.armed, 3000); return false;
  }

  /* ---------- 필기 (좌표는 칠판 크기의 1/10000 단위로 저장해서 크기가 바뀌어도 같은 자리에) ---------- */
  const N = 10000;
  let cur = null;
  const cvs = () => $('#cbInk');
  function toN(e) { const r = cvs().getBoundingClientRect();
    // 세로 화면에서 돌려 보일 때는 좌표도 돌려서 계산
    if (r.height > r.width && $('#chalkboard').offsetWidth > $('#chalkboard').offsetHeight) {
      return [Math.round(((e.clientY - r.top) / r.height) * N), Math.round((1 - (e.clientX - r.left) / r.width) * N)]; }
    return [Math.round(((e.clientX - r.left) / r.width) * N), Math.round(((e.clientY - r.top) / r.height) * N)]; }
  $('#cbInk').addEventListener('pointerdown', (e) => {
    if (tool === 'none') return; e.preventDefault(); cvs().setPointerCapture(e.pointerId);
    const p = toN(e);
    cur = ['pen', 'hl', 'erase'].includes(tool) ? { t: tool, c: inkColor, w: tool === 'erase' ? inkW * 4 : tool === 'hl' ? inkW * 3 : inkW, p: [...p] }
      : { t: tool, c: inkColor, w: inkW, p: [...p, ...p] };
    drawInk();
  });
  $('#cbInk').addEventListener('pointermove', (e) => {
    if (!cur) return; const [x, y] = toN(e);
    if (['pen', 'hl', 'erase'].includes(cur.t)) { const n = cur.p.length; if (Math.hypot(x - cur.p[n - 2], y - cur.p[n - 1]) > 12) cur.p.push(x, y); }
    else {
      cur.p[2] = x; cur.p[3] = y;
      if (cur.t === 'line') {   // 거의 수평·수직이면 반듯하게
        const dx = x - cur.p[0], dy = y - cur.p[1], ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
        if (ang < 8 || ang > 172) cur.p[3] = cur.p[1]; else if (Math.abs(ang - 90) < 8) cur.p[2] = cur.p[0];
      }
    }
    drawInk();
  });
  const endStroke = () => { if (!cur) return; const big = cur.p.length > 2 && (cur.p.length > 4 || Math.hypot(cur.p[2] - cur.p[0], cur.p[3] - cur.p[1]) > 30);
    if (big || ['pen', 'hl', 'erase'].includes(cur.t)) { board.ink = [...board.ink, cur]; touch(); } cur = null; drawInk(); };
  $('#cbInk').addEventListener('pointerup', endStroke); $('#cbInk').addEventListener('pointercancel', endStroke);

  function starPts(x1, y1, x2, y2) { const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, pts = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? 0.42 : 1; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); } return pts; }
  function drawInk() {
    const c = cvs(); if (!c) return; const W = c.clientWidth, H = c.clientHeight; if (!W) return;
    const dpr = window.devicePixelRatio || 1; if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const X = (v) => (v / N) * W, Y = (v) => (v / N) * H, S = (w) => (w / 1000) * W;
    [...board.ink, ...(cur ? [cur] : [])].forEach((s) => {
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = s.c; g.lineWidth = S(s.w * 1.3);
      g.globalCompositeOperation = s.t === 'erase' ? 'destination-out' : 'source-over';
      g.globalAlpha = s.t === 'hl' ? 0.35 : 0.95;
      if (s.t !== 'erase' && s.t !== 'hl') { g.shadowColor = s.c; g.shadowBlur = S(2); }
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

  /* ---------- 아래 도구줄: 내용 쓰기 · 1단/2단 · 글자 모양 · 구조도 · 노트 정리 · 저장 · 크게 보기 ---------- */
  function renderBar() {
    const T = ctx.isTeacher(), v = board.viz;
    $('#cbBar').innerHTML = editing
      ? `<div class="cb-fmt" id="cbFmt">${fmtHTML()}</div>
         <button type="button" class="sm" data-b="cols">${draft.cols === 2 ? '▥ 1단으로' : '▥ 2단으로 나누기'}</button>
         <button type="button" class="sm danger" data-b="wipe">내용 모두 지우기</button>
         <button type="button" class="sm" data-b="cancel">취소</button>
         <button type="button" class="primary sm" data-b="done">💾 저장하고 칠판에 보이기</button>`
      : `${T ? '<button type="button" class="primary sm" data-b="edit">✏️ 내용 쓰기·고치기</button>' : ''}
         ${T ? `<button type="button" class="sm" data-b="cols">${board.cols === 2 ? '▥ 1단으로' : '▥ 2단으로 나누기'}</button>` : ''}
         ${T ? `<button type="button" class="sm" data-b="viz">🌳 AI 구조도</button>${v?.data ? `<button type="button" class="sm" data-b="vizToggle">${v.show ? '📝 판서 보기' : '🌳 구조도 보기'}</button>` : ''}` : ''}
         ${T ? '<button type="button" class="sm" data-b="note">🗒️ 노트 필기용 정리</button>' : ''}
         ${T && board.noteAlt ? `<button type="button" class="sm" data-b="noteSwap" title="노트 필기용 정리 전후를 바꿔 보여요">${board.noteAlt.isOrig ? '↩ 정리 전 판서로' : '🗒️ 노트 정리본으로'}</button>` : ''}
         ${T ? `<button type="button" class="sm ${dirty ? 'primary' : ''}" data-b="save">💾 저장${dirty ? ' ●' : ''}</button>` : ''}
         <button type="button" class="primary sm" data-b="full">⛶ ${isFull() ? '크게 보기 닫기' : '칠판 크게 보기'}</button>`;
  }
  $('#cbBar').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const a = b.dataset.b;
    if (a === 'edit') { draft = clean(board); editing = true; fmtPart = 'topic'; renderAll(); $('#cbContent [data-k=topic]')?.focus(); }
    if (a === 'cancel') { editing = false; draft = null; renderAll(); }
    if (a === 'wipe') { if (!confirmOnce(b, '한 번 더 누르면 칠판 글을 모두 비워요 (저장해야 반영돼요)')) return; TXT.forEach((k) => (draft[k] = '')); renderAll(); }
    if (a === 'done') { readDraft(); board = { ...board, ...Object.fromEntries(TXT.map((k) => [k, draft[k]])), cols: draft.cols, style: draft.style };
      if (board.viz) board.viz = { ...board.viz, show: false };
      editing = false; draft = null; await save('칠판에 저장했어요'); }
    if (a === 'cols') { const t = editing ? (readDraft(), draft) : board; t.cols = t.cols === 2 ? 1 : 2; if (!editing) touch(); renderAll(); }
    if (a === 'noteSwap' && board.noteAlt) {
      const cur = { body: board.body, body2: board.body2, isOrig: !board.noteAlt.isOrig };
      board.body = board.noteAlt.body; board.body2 = board.noteAlt.body2; board.noteAlt = cur;
      if (board.viz) board.viz = { ...board.viz, show: false };
      renderAll(); await save(cur.isOrig ? '노트 정리본으로 바꿨어요' : '정리 전 원래 판서로 되돌렸어요');
    }
    if (a === 'save') save('판서를 저장했어요');
    if (a === 'full') full();
    if (a === 'viz') openViz();
    if (a === 'vizToggle') { board.viz = { ...board.viz, show: !board.viz.show }; touch(); renderAll(); }
    if (a === 'note') noteAI(b);
  });
  function readDraft() { document.querySelectorAll('#cbContent [data-k]').forEach((el) => (draft[el.dataset.k] = el.value)); }
  $('#cbContent').addEventListener('input', (e) => { if (editing && e.target.dataset.k) draft[e.target.dataset.k] = e.target.value; });

  /* ---------- 글꼴·크기·색: 내용 쓰기·고치기 안에서, 지금 고르고 있는 칸에 바로 ---------- */
  let fmtPart = 'topic';
  const partOf = (k) => (k === 'body2' ? 'body' : k);
  function fmtHTML() {
    const k = fmtPart, t = PARTS.find((p) => p.k === k).t, st = draft.style[k];
    return `<span class="cb-fmt-k" title="글자 모양을 바꿀 칸 (칠판에서 칸을 누르면 바뀌어요)">Aa <b>${t}</b></span>
      <select data-f="font" aria-label="${t} 글꼴">${FONTS.map((f) => `<option value="${f.k}" ${st.f === f.k ? 'selected' : ''} style="font-family:${f.css}">${f.t}</option>`).join('')}</select>
      <span class="cb-size"><button type="button" class="sm" data-f="minus" aria-label="${t} 작게">가−</button><span>${k === 'body' && !st.s ? '자동' : (st.s || 100) + '%'}</span><button type="button" class="sm" data-f="plus" aria-label="${t} 크게">가+</button>${k === 'body' ? `<button type="button" class="sm ${st.s ? '' : 'on'}" data-f="auto" title="칠판에 꽉 차게 자동으로">자동</button>` : ''}</span>
      <span class="cb-cols">${COLORS.map((c) => `<button type="button" class="cb-c ${st.c === c.c ? 'on' : ''}" data-f="color" data-c="${c.c}" title="${c.t}" aria-label="${t} 색: ${c.t}" style="--dot:${c.c}"></button>`).join('')}</span>
      <button type="button" class="sm" data-f="reset" title="이 칸 글자 모양을 처음대로">↺</button>`;
  }
  // 고른 칸의 입력칸 모양만 바로 바꿈 (다시 그리지 않아서 쓰던 자리 그대로)
  function applyFmtLive() {
    document.querySelectorAll('#cbContent [data-k]').forEach((el) => { if (partOf(el.dataset.k) === fmtPart) el.setAttribute('style', partStyleOf(draft, fmtPart)); });
    if (fmtPart === 'std') $('#cbContent .cb-std')?.style.setProperty('color', draft.style.std.c);
    $('#cbFmt').innerHTML = fmtHTML();
  }
  $('#cbContent').addEventListener('focusin', (e) => { const k = e.target.dataset?.k; if (!editing || !k || partOf(k) === fmtPart) return; fmtPart = partOf(k); $('#cbFmt').innerHTML = fmtHTML(); });
  $('#cbBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b || !editing) return; const f = b.dataset.f, st = draft.style[fmtPart];
    if (f === 'minus' || f === 'plus') { let v = st.s || 100; st.s = Math.max(50, Math.min(250, v + (f === 'plus' ? 10 : -10))); }
    if (f === 'auto') st.s = 0;
    if (f === 'color') st.c = b.dataset.c;
    if (f === 'reset') draft.style[fmtPart] = { ...DEF_STYLE[fmtPart] };
    applyFmtLive();
  });
  $('#cbBar').addEventListener('change', (e) => { if (e.target.dataset.f !== 'font' || !editing) return; draft.style[fmtPart].f = e.target.value; applyFmtLive(); });
  $('#cbPop').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const p = b.dataset.p; if (!p) return;
    if (p === 'close') { $('#cbPop').hidden = true; return; }
    if (p === 'vizgo') return makeViz(b.dataset.mode, b);
  });

  /* ---------- 🌳 AI 구조도: 가지치기(마인드맵) · 그물망(개념 연결) ---------- */
  function openViz() {
    $('#cbPop').innerHTML = `<div class="cb-pop-h"><b>🌳 AI 구조도</b><button type="button" class="sm" data-p="close">닫기</button></div>
      <p class="muted" style="margin:0 0 10px">칠판의 강의 내용을 AI가 읽고 한눈에 보이는 그림으로 정리해요. 만든 그림은 칠판에 바로 보이고, [📝 판서 보기]로 언제든 돌아갈 수 있어요.</p>
      <div class="cb-viz-pick">
        <button type="button" data-p="vizgo" data-mode="tree"><b>🌳 가지치기</b><span>주제에서 가지가 뻗어 나가는 마인드맵</span></button>
        <button type="button" data-p="vizgo" data-mode="web"><b>🕸️ 그물망</b><span>개념끼리 원인·결과·관계를 선으로 연결</span></button>
      </div>`;
    $('#cbPop').hidden = false;
  }
  // AI가 안 될 때 쓰는 기본 구조: # 소제목 → 큰 가지, - 내용 → 작은 가지
  function localTree() {
    const nodes = []; let h = null, n = 0;
    `${board.body}\n${board.body2}`.split('\n').forEach((ln) => {
      const t = ln.trim(); if (!t) return;
      const m = t.match(/^#+\s*(.+)/);
      const label = t.replace(/^#+\s*|^[-•*·!]\s*/g, '').replace(/\*\*/g, '').replace(/->/g, '→');
      if (m || !h) { h = 'n' + (++n); nodes.push({ id: h, label: m ? label : '내용', parent: 'root' }); if (m) return; }
      nodes.push({ id: 'n' + (++n), label, parent: h });
    });
    return { root: board.topic || board.sub || board.unit || '오늘의 수업', nodes: nodes.slice(0, 36), links: [] };
  }
  async function makeViz(mode, btn) {
    btn.disabled = true; const label = btn.innerHTML; btn.innerHTML = '<b>AI가 정리하는 중…</b>';
    let data = null, byAI = false;
    try {
      const out = await callAI(mode); if (out?.root && Array.isArray(out.nodes) && out.nodes.length) { data = out; byAI = true; }
    } catch (err) { console.error(err); toast(`AI를 쓰지 못해서 판서 구조대로 만들었어요 (${err.message})`); }
    if (!data) data = localTree();
    board.viz = { mode, data, show: true }; touch(); $('#cbPop').hidden = true; btn.disabled = false; btn.innerHTML = label;
    renderAll(); save(byAI ? `AI ${mode === 'web' ? '그물망' : '가지치기'} 구조도를 칠판에 띄웠어요` : '구조도를 칠판에 띄웠어요');
  }
  async function callAI(mode, extra = {}) {
    const token = await auth.currentUser?.getIdToken?.(); if (!token) throw new Error('교사 관리 모드에 다시 들어와 주세요');
    const r = await fetch('/api/ai-board', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode, unit: board.unit, sub: board.sub, topic: board.topic, std: board.std, body: [board.body, board.body2].filter(Boolean).join('\n\n'), ...extra }) });
    const out = await r.json().catch(() => ({})); if (!r.ok) throw new Error(out.error || `오류 ${r.status}`); return out;
  }
  // 긴 낱말은 줄을 나눠서
  const wrap = (s, n) => { const w = String(s).split(/\s+/), lines = []; let l = '';
    w.forEach((x) => { if ((l + ' ' + x).trim().length > n && l) { lines.push(l); l = x; } else l = (l + ' ' + x).trim(); }); if (l) lines.push(l); return lines.slice(0, 3); };
  function nodeBox(x, y, label, cls, n) {
    const ls = wrap(label, n), fs = cls === 'root' ? 44 : cls === 'l1' ? 34 : 28, lh = fs * 1.15, w = Math.min(n, Math.max(...ls.map((l) => l.length))) * fs * 0.95 + fs, h = ls.length * lh + fs * 0.7;
    return `<g class="vz-n ${cls}"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2.4}"/>${ls.map((l, i) => `<text x="${x}" y="${y - ((ls.length - 1) * lh) / 2 + i * lh}" font-size="${fs}">${esc(l)}</text>`).join('')}</g>`;
  }
  function vizSVG(v) {
    const d = v.data, W = 1600, H = 760, kids = (id) => d.nodes.filter((n) => n.parent === id);
    const L1 = kids('root').length ? kids('root') : d.nodes.filter((n) => !d.nodes.some((m) => m.id === n.parent));
    const leaves = (n) => Math.max(1, kids(n.id).length);
    let lines = '', boxes = '';
    const pos = { root: [W / 2, H / 2] };
    if (v.mode === 'web') {
      // 그물망: 가운데 주제, 큰 개념은 안쪽 원, 작은 개념은 바깥 원
      const total = L1.reduce((a, n) => a + leaves(n), 0) || 1; let acc = 0;
      L1.forEach((n) => { const span = (leaves(n) / total) * Math.PI * 2, mid = -Math.PI / 2 + acc + span / 2;
        pos[n.id] = [W / 2 + Math.cos(mid) * 380, H / 2 + Math.sin(mid) * 210];
        const ks = kids(n.id); ks.forEach((k, i) => { const a = -Math.PI / 2 + acc + (span * (i + 0.5)) / ks.length; pos[k.id] = [W / 2 + Math.cos(a) * 680, H / 2 + Math.sin(a) * 330]; });
        acc += span; });
      d.nodes.forEach((n) => { const a = pos[n.parent] || pos.root, b = pos[n.id]; if (b) lines += `<line class="vz-l" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`; });
      (d.links || []).forEach((l) => { const a = pos[l.from], b = pos[l.to]; if (!a || !b) return; const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - 18;
        lines += `<path class="vz-x" d="M${a[0]} ${a[1]} Q${mx} ${my - 60} ${b[0]} ${b[1]}"/>${l.label ? `<text class="vz-xl" x="${mx}" y="${my - 30}" font-size="24">${esc(l.label)}</text>` : ''}`; });
    } else {
      // 가지치기: 가운데 주제에서 왼쪽·오른쪽으로 가지
      const half = Math.ceil(L1.length / 2), sides = [L1.slice(0, half), L1.slice(half)];
      sides.forEach((list, si) => { const dir = si ? -1 : 1, rows = list.reduce((a, n) => a + leaves(n), 0) || 1; let row = 0;
        list.forEach((n) => { const ks = kids(n.id), span = leaves(n), y = 40 + ((row + span / 2) / rows) * (H - 80);
          pos[n.id] = [W / 2 + dir * 330, y];
          ks.forEach((k, i) => (pos[k.id] = [W / 2 + dir * 640, 40 + ((row + i + 0.5) / rows) * (H - 80)])); row += span; }); });
      d.nodes.forEach((n) => { const a = pos[n.parent] || pos.root, b = pos[n.id]; if (!b) return; const mx = (a[0] + b[0]) / 2;
        lines += `<path class="vz-l ${n.parent === 'root' ? 'l1' : ''}" d="M${a[0]} ${a[1]} C${mx} ${a[1]} ${mx} ${b[1]} ${b[0]} ${b[1]}"/>`; });
    }
    d.nodes.forEach((n) => { const p = pos[n.id]; if (p) boxes += nodeBox(p[0], p[1], n.label, n.parent === 'root' || L1.includes(n) ? 'l1' : 'l2', n.parent === 'root' ? 9 : 11); });
    boxes += nodeBox(W / 2, H / 2, d.root, 'root', 8);
    return `<svg viewBox="-20 -20 ${W + 40} ${H + 40}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${v.mode === 'web' ? '그물망' : '가지치기'} 구조도">${lines}${boxes}</svg>
      <div class="vz-cap">${v.mode === 'web' ? '🕸️ 그물망' : '🌳 가지치기'} 구조도</div>`;
  }

  /* ---------- 🗒️ 노트 필기용 정리 (AI) ---------- */
  async function noteAI(btn) {
    if (!board.body && !board.body2) return toast('먼저 강의 내용을 칠판에 적어 주세요');
    btn.disabled = true; const t0 = btn.textContent; btn.textContent = 'AI가 정리하는 중…';
    try {
      const out = await callAI('note', { cols: board.cols });
      $('#cbPop').innerHTML = `<div class="cb-pop-h"><b>🗒️ 노트 필기용으로 정리한 판서</b><button type="button" class="sm" data-p="close">닫기</button></div>
        <p class="muted" style="margin:0 0 8px">학생이 공책에 옮겨 적기 좋게 핵심어·번호·화살표로 다듬었어요. 고친 뒤 [칠판에 적용]을 누르세요.</p>
        <div class="row2 cb-note-ta"><textarea id="cbNote1" rows="14">${esc(out.body || '')}</textarea>${board.cols === 2 ? `<textarea id="cbNote2" rows="14">${esc(out.body2 || '')}</textarea>` : ''}</div>
        <div class="cb-pop-f"><button type="button" class="sm" data-p="close">그대로 두기</button><button type="button" class="primary sm" id="cbNoteApply">칠판에 적용</button></div>`;
      $('#cbPop').hidden = false;
      $('#cbNoteApply').onclick = async () => {
        board.noteAlt = { body: board.body, body2: board.body2, isOrig: true };   // 정리 전 판서 보관 → [↩ 정리 전 판서로]
        board.body = $('#cbNote1').value; if ($('#cbNote2')) board.body2 = $('#cbNote2').value;
        if (board.viz) board.viz = { ...board.viz, show: false };
        $('#cbPop').hidden = true; renderAll(); await save('노트 필기용으로 정리했어요. [↩ 정리 전 판서로]를 누르면 언제든 되돌려요');
      };
    } catch (err) { console.error(err); toast(`정리하지 못했어요: ${err.message}`); }
    finally { btn.disabled = false; btn.textContent = t0; }
  }
  /* ---------- 저장 (지금 칠판 + 저장된 판서 모음) ---------- */
  let autoT;
  function touch() { dirty = true; renderBar(); clearTimeout(autoT); if (ctx.isTeacher()) autoT = setTimeout(() => save(''), 4000); }
  const payload = () => ({ ...Object.fromEntries(TXT.map((k) => [k, board[k]])), cols: board.cols, style: board.style, ink: board.ink, viz: board.viz || null, noteAlt: board.noteAlt || null });
  async function save(msg) {
    clearTimeout(autoT);
    if (!ctx.isTeacher()) { if (msg) toast('저장은 교사 관리 모드로 들어온 기기에서만 할 수 있어요'); return; }
    const has = TXT.some((k) => board[k].trim()) || board.ink.length;
    try {
      if (!board.id && has) board.id = doc(collection(db, 'boards')).id;
      const data = { ...payload(), id: board.id, updatedAt: serverTimestamp() };
      await setDoc(doc(db, 'settings', 'board'), data);
      if (board.id && has) await setDoc(doc(db, 'boards', board.id), { ...data, savedAt: serverTimestamp() });
      dirty = false; renderBar(); if (msg) toast(msg);
    } catch (err) { console.error(err); toast(err.code === 'permission-denied' ? '저장 권한이 없어요. Firebase 규칙을 새로 게시하고 교사 관리 모드에 다시 들어와 주세요' : '저장하지 못했어요. 다시 눌러 주세요'); }
  }

  /* ---------- 크게 보기 (가로 전체 화면 · 날짜와 시간 표시) ---------- */
  async function full() {
    const wrap = $('#boardWrap');
    try {
      if (isFull()) { if (document.fullscreenElement) await document.exitFullscreen(); else { wrap.classList.remove('cb-fake-full'); document.body.classList.remove('cb-lock'); } }
      else { await (wrap.requestFullscreen?.() || wrap.webkitRequestFullscreen?.() || Promise.reject(new Error('x'))); await screen.orientation?.lock?.('landscape').catch(() => {}); }
    } catch { wrap.classList.add('cb-fake-full'); document.body.classList.add('cb-lock'); }
    setTimeout(renderAll, 150);
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { screen.orientation?.unlock?.(); $('#boardWrap').classList.remove('cb-fake-full'); document.body.classList.remove('cb-lock'); } setTimeout(renderAll, 150); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#boardWrap').classList.contains('cb-fake-full')) { $('#boardWrap').classList.remove('cb-fake-full'); document.body.classList.remove('cb-lock'); renderAll(); } });
  let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { fit(); drawInk(); }, 80); });
  setInterval(() => { const d = $('#cbDate'); if (d && ctx.lesson() === 'board') d.innerHTML = dateText(isFull()); }, 1000);

  /* ---------- 교사 관리 모드: 저장된 판서 · 불러오기 ---------- */
  function renderSaved() {
    const box = $('#bSavedRows'); if (!box) return;
    const fmt = (t) => { const d = t?.toDate?.(); return d ? `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '-'; };
    box.innerHTML = saved.length ? saved.map((s) => `<tr data-id="${esc(s.id)}" class="${s.id === board.id ? 'cur' : ''}">
        <td><b>${esc(s.topic || '(학습 주제 없음)')}</b>${s.id === board.id ? ' <span class="state on">지금 칠판</span>' : ''}<div class="muted">${esc([s.unit, s.sub].filter(Boolean).join(' › '))}</div></td>
        <td class="num">${(s.ink || []).length}개${s.viz?.data ? ' · 🌳' : ''}</td><td class="num">${fmt(s.savedAt)}</td>
        <td class="act"><div class="row"><button type="button" class="sm primary" data-a="load">불러오기</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">아직 저장된 판서가 없어요. 수업 화면의 칠판에서 내용을 쓰고 저장하면 여기에 모여요.</td></tr>';
  }
  $('#bSavedRows')?.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const s = saved.find((x) => x.id === b.closest('tr').dataset.id); if (!s) return;
    if (b.dataset.a === 'load') { if (dirty) await save(''); board = clean(s); dirty = false; await save(`'${s.topic || '판서'}'를 칠판에 불러왔어요`); renderAll(); }
    if (b.dataset.a === 'del') { if (!confirmOnce(b, '한 번 더 누르면 이 저장 판서를 지워요')) return;
      try { await deleteDoc(doc(db, 'boards', s.id)); toast('저장된 판서를 지웠어요'); } catch { toast('지우지 못했어요'); } }
  });
  $('#bNew')?.addEventListener('click', async (e) => {
    if (!confirmOnce(e.target, '한 번 더 누르면 빈 칠판으로 새로 시작해요 (지금 판서는 저장된 판서에 남아요)')) return;
    if (dirty) await save(''); const st = board.style; board = EMPTY(); board.style = st; await save('새 칠판을 열었어요'); renderAll();
  });

  /* ---------- 바깥에서 쓰는 것 ---------- */
  function renderAll() { renderContent(); renderBar(); renderSaved(); }
  return {
    render: renderAll,
    onRemote(x) { if (editing || dirty) return; board = clean(x); renderAll(); },
    teacherOn() { unsubSaved?.(); unsubSaved = onSnapshot(query(collection(db, 'boards'), orderBy('savedAt', 'desc')), (s) => { saved = s.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id })); renderSaved(); }, console.error); renderAll(); },
    teacherOff() { unsubSaved?.(); unsubSaved = null; saved = []; editing = false; renderAll(); },
  };
}
