/* ================= 📖 교과서 보기 =================
   교과서 PDF(또는 사진)를 올려 화면에 띄우고 필기하며 수업.
   올린 자료와 필기는 이 컴퓨터(브라우저)에 저장돼요 — 교사용 수업 컴퓨터에서 쓰는 기능.
   한글(HWP) 파일은 브라우저가 바로 열 수 없어서 PDF로 저장해서 올리도록 안내. */
import { createInk } from './ink.js';

/* ---------- 이 컴퓨터에 저장 (IndexedDB) ---------- */
const DB_NAME = 'textbook-view', DB_VER = 1;
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('files', { keyPath: 'id' }); d.createObjectStore('ink'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error); });
}
const listFiles = () => tx('files', 'readonly', (s) => s.getAll());
const putFile = (f) => tx('files', 'readwrite', (s) => s.put(f));
const delFile = (id) => tx('files', 'readwrite', (s) => s.delete(id));
const getInk = (key) => tx('ink', 'readonly', (s) => s.get(key));
const putInk = (key, v) => tx('ink', 'readwrite', (s) => s.put(v, key));
async function delInkOf(id) { const d = await idb(); return new Promise((res) => { const t = d.transaction('ink', 'readwrite'); const s = t.objectStore('ink'); const r = s.openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return; if (String(c.key).startsWith(id + ':')) c.delete(); c.continue(); }; t.oncomplete = res; }); }

/* ---------- PDF.js (필요할 때만 불러옴) ---------- */
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) pdfjsP = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.js?url')]).then(([m, w]) => { m.GlobalWorkerOptions.workerSrc = w.default; return m; });
  return pdfjsP;
}
const LS = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } } };

export function initBook({ $, esc, toast, lesson, setLesson, isTeacher, DAYS }) {
  let files = [], file = null, pdf = null, imgs = [], page = 1, pages = 0, fitMode = LS.get('bkFit') || 'page', zoom = 1;
  let strokes = [], renderTask = null, loading = false, lastWrite = Promise.resolve(), savedNote = '';
  // 같은 컴퓨터의 다른 창(교사 관리 모드 ↔ 수업 화면)끼리 "이 교과서 열기"를 주고받음
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('textbook-view') : null;
  bc?.addEventListener('message', (e) => { if (e.data?.open) { LS.set('bkLast', e.data.open); if (e.data.page) LS.set('bkPage:' + e.data.open, String(e.data.page)); if (started) refresh(e.data.open); } else if (e.data?.changed) refreshList(); });
  function markSaved() { savedNote = '✔ 이 컴퓨터에 저장됨'; const el = $('#bkSaved'); if (el) el.textContent = savedNote; }
  const key = () => `${file.id}:${page}`;

  const ink = createInk({
    canvas: $('#bkInk'), sideEl: $('#bkSide'), toast,
    get: () => strokes,
    set: (a) => { strokes = a; if (file) { lastWrite = putInk(key(), a).catch(console.error); markSaved(); } },
  });

  /* ---------- 아래 도구줄 ---------- */
  function renderBar() {
    const opts = files.map((f) => `<option value="${esc(f.id)}" ${file?.id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    $('#bkBar').innerHTML = `
      <label class="btn sm primary file-btn" title="PDF 또는 사진을 올리면 이 컴퓨터에 저장돼서 다음에도 바로 열려요">📂 자료 올리기 및 저장<input type="file" id="bkFile" accept=".pdf,application/pdf,image/*,.hwp,.hwpx" multiple hidden></label>
      ${files.length ? `<select id="bkPick" aria-label="자료 고르기">${opts}</select>` : ''}
      ${file ? `<span class="cb-pages"><button type="button" class="sm" data-k="prev" ${page > 1 ? '' : 'disabled'} aria-label="앞쪽">◀</button>
        <b><input id="bkPageIn" type="number" min="1" max="${pages}" value="${page}" aria-label="쪽 번호"> / ${pages}쪽</b>
        <button type="button" class="sm" data-k="next" ${page < pages ? '' : 'disabled'} aria-label="다음 쪽">▶</button></span>
        <button type="button" class="sm" data-k="zoomOut" aria-label="작게">－</button><span class="bk-zoom">${Math.round(zoom * 100)}%</span><button type="button" class="sm" data-k="zoomIn" aria-label="크게">＋</button>
        <button type="button" class="sm" data-k="fit">${fitMode === 'page' ? '↔ 폭에 맞추기' : '▣ 한 쪽 다 보기'}</button>
        <button type="button" class="sm" data-k="save" title="자료와 필기, 보던 쪽을 이 컴퓨터에 저장해요">💾 저장</button><span class="cb-autonote" id="bkSaved">${savedNote}</span>
        <button type="button" class="sm danger" data-k="del" title="이 자료를 이 컴퓨터에서 지워요">자료 지우기</button>` : ''}
      <button type="button" class="primary sm" data-k="full">⛶ ${isFull() ? '크게 보기 닫기' : '크게 보기'}</button>`;
  }
  const isFull = () => document.fullscreenElement === $('#bookWrap') || $('#bookWrap').classList.contains('cb-fake-full');
  $('#bkBar').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const k = b.dataset.k;
    if (k === 'prev') go(page - 1);
    if (k === 'next') go(page + 1);
    if (k === 'zoomIn' || k === 'zoomOut') { zoom = Math.max(0.5, Math.min(3, +(zoom + (k === 'zoomIn' ? 0.1 : -0.1)).toFixed(2))); draw(); }
    if (k === 'fit') { fitMode = fitMode === 'page' ? 'width' : 'page'; zoom = 1; LS.set('bkFit', fitMode); draw(); }
    if (k === 'full') full();
    if (k === 'save') { await lastWrite; try { await putInk(key(), strokes); await putFile({ ...file, pages, lastPage: page, savedAt: Date.now() }); } catch (err) { console.error(err); return toast('저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요'); }
      LS.set('bkPage:' + file.id, String(page)); markSaved(); bc?.postMessage({ changed: true }); toast(`'${file.name}' ${page}쪽까지 자료와 필기를 이 컴퓨터에 저장했어요`); }
    if (k === 'del') {
      if (!b.dataset.armed) { b.dataset.armed = '1'; toast('한 번 더 누르면 이 자료와 필기를 이 컴퓨터에서 지워요'); setTimeout(() => delete b.dataset.armed, 3000); return; }
      await delFile(file.id); await delInkOf(file.id); toast('자료를 지웠어요'); file = null; pdf = null; bc?.postMessage({ changed: true }); await refresh(); }
  });
  $('#bkBar').addEventListener('change', async (e) => {
    if (e.target.id === 'bkPick') open(e.target.value);
    if (e.target.id === 'bkPageIn') go(Number(e.target.value) || 1);
    if (e.target.id === 'bkFile') { const fs = [...(e.target.files || [])]; e.target.value = ''; await upload(fs); }
  });

  /* ---------- 올리기 ---------- */
  async function upload(fs) {
    if (!fs.length) return;
    const hwp = fs.filter((f) => /\.hwpx?$/i.test(f.name));
    if (hwp.length) showHwpHelp(hwp[0].name);
    const pdfs = fs.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    const images = fs.filter((f) => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    let last = null;
    try {
      for (const f of pdfs) { last = { id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6), name: f.name.replace(/\.pdf$/i, ''), kind: 'pdf', blob: f, at: Date.now() }; await putFile(last); }
      if (images.length) { last = { id: 'f' + Date.now() + 'i', name: images.length > 1 ? `${images[0].name.replace(/\.[^.]+$/, '')} 외 ${images.length - 1}장` : images[0].name.replace(/\.[^.]+$/, ''), kind: 'img', blobs: images, at: Date.now() }; await putFile(last); }
    } catch (err) { console.error(err); toast('자료를 저장하지 못했어요. 파일이 너무 크거나 브라우저 저장 공간이 부족할 수 있어요'); return; }
    if (last) { toast('자료를 올리고 이 컴퓨터에 저장했어요. 교사 관리 모드의 [저장된 교과서]에서도 불러올 수 있어요'); bc?.postMessage({ changed: true }); await refresh(last.id); }
  }
  function showHwpHelp(name) {
    $('#bkPop').innerHTML = `<div class="cb-pop-h"><b>한글(HWP) 파일은 PDF로 바꿔서 올려 주세요</b><button type="button" class="sm" data-x="close">닫기</button></div>
      <p style="margin:0 0 8px">'${esc(name)}'은(는) 한글 문서라 웹 브라우저가 바로 열 수 없어요. 아래처럼 PDF로 저장한 뒤 [📂 자료 올리기 및 저장]으로 올리면 똑같이 보여요.</p>
      <ol style="margin:0;padding-left:20px;line-height:1.8"><li>한글에서 파일을 열어요.</li><li>[파일] → <b>[PDF로 저장하기]</b>를 눌러요. (또는 [인쇄] → 프린터에서 'Microsoft Print to PDF')</li><li>저장한 PDF를 여기에 올려요.</li></ol>`;
    $('#bkPop').hidden = false;
  }
  $('#bkPop').addEventListener('click', (e) => { if (e.target.closest('[data-x=close]')) $('#bkPop').hidden = true; });
  // 끌어다 놓기로도 올리기
  $('#bookStage').addEventListener('dragover', (e) => { e.preventDefault(); $('#bookStage').classList.add('drop'); });
  $('#bookStage').addEventListener('dragleave', () => $('#bookStage').classList.remove('drop'));
  $('#bookStage').addEventListener('drop', (e) => { e.preventDefault(); $('#bookStage').classList.remove('drop'); upload([...(e.dataTransfer?.files || [])]); });

  /* ---------- 열기 · 쪽 넘기기 · 그리기 ---------- */
  async function refresh(openId) {
    try { files = (await listFiles()).sort((a, b) => b.at - a.at); } catch (err) { console.error(err); files = []; }
    const id = openId || file?.id || LS.get('bkLast');
    if (id && files.some((f) => f.id === id)) await open(id); else if (files[0]) await open(files[0].id); else { file = null; show(); }
  }
  async function open(id) {
    const f = files.find((x) => x.id === id); if (!f) return;
    loading = true; file = f; pdf = null; imgs.forEach((u) => URL.revokeObjectURL(u)); imgs = []; show();
    try {
      if (f.kind === 'pdf') { const m = await pdfjs(); pdf = await m.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise; pages = pdf.numPages; }
      else { imgs = f.blobs.map((b) => URL.createObjectURL(b)); pages = imgs.length; }
      LS.set('bkLast', f.id); savedNote = '';
      if (f.pages !== pages) putFile({ ...f, pages }).then(() => { f.pages = pages; bc?.postMessage({ changed: true }); }).catch(() => {});
      page = Math.min(Math.max(1, Number(LS.get('bkPage:' + f.id)) || 1), pages);
    } catch (err) { console.error(err); toast('자료를 열지 못했어요. 다른 PDF로 해 주세요'); file = null; }
    loading = false; await go(page, true);
  }
  async function go(n, force) {
    if (!file) return show();
    n = Math.max(1, Math.min(n, pages)); if (n === page && !force) return;
    page = n; LS.set('bkPage:' + file.id, String(page));
    try { const v = await getInk(key()); strokes = Array.isArray(v) ? v : []; } catch { strokes = []; }
    await draw();
  }
  function show() {
    $('#bookEmpty').hidden = !!file || loading;
    $('#bookPage').hidden = !file;
    $('#bkSide').hidden = !file;
    renderBar();
  }
  async function draw() {
    show(); if (!file || loading) return;
    const stage = $('#bookStage'), cv = $('#bookCanvas'), box = $('#bookPage');
    const SW = stage.clientWidth - 16, SH = stage.clientHeight - 16; if (SW <= 0) return;
    let w0, h0, src = null, pg = null;
    if (pdf) { pg = await pdf.getPage(page); const v = pg.getViewport({ scale: 1 }); w0 = v.width; h0 = v.height; }
    else { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = imgs[page - 1]; }); w0 = src.naturalWidth; h0 = src.naturalHeight; }
    const base = fitMode === 'page' ? Math.min(SW / w0, SH / h0) : SW / w0, sc = base * zoom;
    const W = Math.floor(w0 * sc), H = Math.floor(h0 * sc), dpr = Math.min(2.5, window.devicePixelRatio || 1);
    box.style.width = W + 'px'; box.style.height = H + 'px';
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    if (pdf) {
      renderTask?.cancel?.();
      renderTask = pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: sc * dpr }) });
      try { await renderTask.promise; } catch (err) { if (err?.name !== 'RenderingCancelledException') console.error(err); }
    } else { g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(src, 0, 0, cv.width, cv.height); }
    ink.redraw();
  }

  /* ---------- 크게 보기 ---------- */
  async function full() {
    const wrap = $('#bookWrap');
    try {
      if (isFull()) { if (document.fullscreenElement) await document.exitFullscreen(); else { wrap.classList.remove('cb-fake-full'); document.body.classList.remove('cb-lock'); } }
      else await (wrap.requestFullscreen?.() || Promise.reject(new Error('x')));
    } catch { wrap.classList.add('cb-fake-full'); document.body.classList.add('cb-lock'); }
    setTimeout(draw, 150);
  }
  document.addEventListener('fullscreenchange', () => { if (lesson() === 'book') setTimeout(draw, 150); });
  let rT; window.addEventListener('resize', () => { if (lesson() !== 'book') return; clearTimeout(rT); rT = setTimeout(draw, 120); });
  document.addEventListener('keydown', (e) => {
    if (lesson() !== 'book' || !file || $('#v-class').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (['ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); go(page + 1); }
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(page - 1); }
    if (e.key === 'Escape' && $('#bookWrap').classList.contains('cb-fake-full')) { $('#bookWrap').classList.remove('cb-fake-full'); document.body.classList.remove('cb-lock'); draw(); }
  });

  /* ---------- 교사 관리 모드: 저장된 교과서 불러오기 ---------- */
  async function refreshList() {
    const box = $('#bkSavedRows'); if (!box) return;
    let list = []; try { list = (await listFiles()).sort((a, b) => b.at - a.at); } catch { list = []; }
    const cur = LS.get('bkLast'), mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + 'MB';
    const when = (t) => { if (!t) return '-'; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]})`; };
    box.innerHTML = list.length ? list.map((f) => `<tr data-id="${esc(f.id)}" class="${f.id === cur ? 'cur' : ''}">
        <td><b>${esc(f.name)}</b>${f.id === cur ? ' <span class="state on">수업 화면에 열림</span>' : ''}<div class="muted">${f.kind === 'pdf' ? 'PDF' : '사진'} · ${f.pages ? f.pages + '쪽' : '쪽 수 확인 전'}${f.lastPage ? ` · ${f.lastPage}쪽까지 봄` : ''}</div></td>
        <td class="num">${mb(f.kind === 'pdf' ? f.blob?.size || 0 : (f.blobs || []).reduce((n, b) => n + b.size, 0))}</td><td class="num">${when(f.at)}${f.savedAt ? `<div class="muted">저장 ${when(f.savedAt)}</div>` : ''}</td>
        <td class="act"><div class="row"><button type="button" class="sm primary" data-a="load">불러오기</button><button type="button" class="sm" data-a="ren">이름 바꾸기</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">이 컴퓨터에 저장된 교과서가 없어요. 수업 화면 → 📖 교과서 보기에서 [📂 자료 올리기 및 저장]으로 올려 주세요.</td></tr>';
  }
  $('#bkSavedRows')?.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const id = b.closest('tr').dataset.id;
    const list = await listFiles(); const f = list.find((x) => x.id === id); if (!f) return;
    if (b.dataset.a === 'load') {
      LS.set('bkLast', id); bc?.postMessage({ open: id, page: f.lastPage || Number(LS.get('bkPage:' + id)) || 1 });
      if (started) refresh(id);
      if (isTeacher()) await setLesson('book');
      toast(`'${f.name}'을(를) 수업 화면의 교과서 보기에 띄웠어요`); refreshList();
    }
    if (b.dataset.a === 'ren') {
      const name = prompt('교과서 이름', f.name); if (!name || !name.trim()) return;
      await putFile({ ...f, name: name.trim().slice(0, 60) }); bc?.postMessage({ changed: true }); if (file?.id === id) file.name = name.trim().slice(0, 60); renderBar(); refreshList();
    }
    if (b.dataset.a === 'del') {
      if (!b.dataset.armed) { b.dataset.armed = '1'; toast('한 번 더 누르면 이 교과서와 필기를 이 컴퓨터에서 지워요'); setTimeout(() => delete b.dataset.armed, 3000); return; }
      await delFile(id); await delInkOf(id); bc?.postMessage({ changed: true }); if (file?.id === id) { file = null; pdf = null; if (started) refresh(); } toast('지웠어요'); refreshList();
    }
  });

  let started = false;
  return {
    show() { if (!started) { started = true; refresh(); } else draw(); },
    refreshList,
  };
}
