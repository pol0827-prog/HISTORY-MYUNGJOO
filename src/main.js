import './style.css';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc, onSnapshot, query, where,
  getDocs, getDocsFromServer, serverTimestamp, writeBatch, orderBy, Timestamp,
} from 'firebase/firestore';
import { signInAnonymously, signOut, onAuthStateChanged } from 'firebase/auth';
import QRCode from 'qrcode';
import { db, auth, configured } from './firebase.js';
import { PRESETS, CFG_KEYS } from './presets.js';

document.getElementById('noRun')?.remove();

/* ================= 공통 ================= */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const hm = (d) => (d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '-');
const linkFor = (v) => `${location.origin}${location.pathname}#${v}`;
const ts = (e) => e.at?.getTime?.() ?? 0;
const label = (e) => `[${e.sid}] ${e.nick}`;
/* 반 구분: 문서 ID 앞에 반 이름을 붙여 저장 ("2학년%201반~랜덤ID"). 반 없는 예전 기록은 '' */
const clsPrefix = (c) => (c ? encodeURIComponent(c) + '~' : '');
const clsOf = (id) => { const i = String(id).indexOf('~'); if (i < 0) return ''; try { return decodeURIComponent(id.slice(0, i)); } catch { return ''; } };
const rawId = (id) => String(id).slice(String(id).indexOf('~') + 1);
const newId = (col, c) => clsPrefix(c) + doc(collection(db, col)).id;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2400); }
function checkStudent(sid, name) {
  if (!sid) return '학번을 적어 주세요.';
  if (!/^[0-9]{4,6}$/.test(sid)) return '학번은 숫자 4~6자리로 적어 주세요. 예: 20101';
  if (!name) return '이름을 적어 주세요.';
  return '';
}

/* ================= 상태 ================= */
let isTeacher = false;
let pubEntries = [], allEntries = [], names = new Map();   // 배움 마무리
let pubIntro = [], allIntro = [];                         // 배움 시작
let pubPresents = [], allPresents = [];                   // 발표 자료
let picks = { teacher: null, best: [null, null, null] };
let aiSel = { id: null, reason: '' };
let cfg = { ...PRESETS.history };
let lesson = 'close';

const toEntry = (d) => { const x = d.data({ serverTimestamps: 'estimate' }); return { id: d.id, cls: clsOf(d.id), ...x, hidden: !!x.hidden, at: x.createdAt?.toDate?.() ?? null }; };
// 교사는 전체(이름 포함), 그 외에는 숨기지 않은 글만
// 지금 수업하는 반의 기록만 (반마다 따로)
const inCls = (e) => e.cls === className;
const entries = () => (isTeacher ? allEntries.filter(inCls).map((e) => ({ ...e, name: names.get(e.id)?.name || '' })) : pubEntries.filter(inCls));
const visible = () => entries().filter((e) => !e.hidden);
const byId = (id) => entries().find((e) => e.id === id);
// 배움 시작은 원본처럼 학생당 1건: 같은 학번은 가장 최근 제출만
function latestPerSid(list) { const m = new Map(); list.forEach((e) => { const o = m.get(e.sid); if (!o || ts(e) >= ts(o)) m.set(e.sid, e); }); return [...m.values()]; }
const introRecords = () => (isTeacher ? allIntro : pubIntro).filter(inCls);
const intro = () => latestPerSid(introRecords());
const iVisible = () => intro().filter((e) => !e.hidden);

/* ================= 키워드 · 자동 추천 · 단어 집계 ================= */
const STOP = new Set(['오늘', '수업', '하지만', '그리고', '되었다', '같다', '된다', '있다', '없다', '재밌었다', '있어야', '대한', '우리', '정말', '너무']);
const JOSA = /(들은|들을|들이|들의|에서|에게|으로|이다|하다|은|는|이|가|을|를|의|에|도|로|와|과|만)$/;
function keywords(list) {
  const cnt = {};
  list.forEach((e) => (String(e.body).match(/[가-힣]{2,}/g) || []).forEach((w) => {
    const k = w.replace(JOSA, ''); if (k.length < 2 || STOP.has(w) || STOP.has(k)) return; cnt[k] = (cnt[k] || 0) + 1;
  }));
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map((x) => x[0]);
}
function aiPick(list) {
  const top = keywords(list);
  return list.map((e) => {
    let s = Math.min(String(e.body).length, 60) / 10;
    top.forEach((k) => { if (e.body.includes(k)) s += 3; });
    if (/[?]|인가|일까|생각/.test(e.body)) s += 4;
    return { e, s };
  }).sort((a, b) => b.s - a.s)[0]?.e;
}
function currentAi(list) {
  const g = list.find((e) => e.id === aiSel.id);
  return g ? { e: g, reason: aiSel.reason, gemini: true } : { e: aiPick(list), reason: '', gemini: false };
}
const normW = (w) => String(w).replace(/\s+/g, ' ').trim();
function wordCounts(list) {
  const c = new Map(); list.forEach((e) => [e.w1, e.w2].forEach((w) => { w = normW(w); if (w) c.set(w, (c.get(w) || 0) + 1); }));
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
}

/* ================= 화면 설정 (settings/config) ================= */
const fillT = (t) => t.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? '').trim();
function applyCfg() {
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = fillT(el.dataset.t); el.hidden = /^["\-\s]*$/.test(el.textContent); });
  document.querySelectorAll('[data-ph]').forEach((el) => (el.placeholder = fillT(el.dataset.ph)));
  document.title = cfg.title || '배움 일기';
}
const fillCfgForm = (c) => CFG_KEYS.forEach((k) => { const el = $('#c-' + k); if (el) el.value = c[k] || ''; });
let cfgDirty = false;
$('#cfgForm').addEventListener('input', () => (cfgDirty = true));
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { fillCfgForm(PRESETS[b.dataset.preset]); cfgDirty = true; toast('예시를 불러왔어요. 설정 저장을 눌러야 반영돼요'); }));
$('#cfgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {}; CFG_KEYS.forEach((k) => (next[k] = ($('#c-' + k)?.value || '').trim()));
  try { await setDoc(doc(db, 'settings', 'config'), next); cfgDirty = false; toast('설정을 저장했어요. 모든 화면에 반영됐어요'); }
  catch { toast('저장하지 못했어요. 교사 관리 모드에 다시 들어와 주세요'); }
});

/* ================= 오늘 배움 시작 / 마무리 ================= */
function showLesson(m) {
  lesson = m === 'intro' || m === 'present' ? m : 'close';
  document.documentElement.dataset.lesson = lesson;
  document.querySelectorAll('button[data-lesson]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lesson === lesson));
  renderAll(); if (document.getElementById('qrFloat')) renderQrFloat();
}
document.querySelectorAll('button[data-lesson]').forEach((b) => (b.onclick = async () => {
  showLesson(b.dataset.lesson);
  const msg = { intro: '오늘 배움 시작 화면으로 바꿨어요', close: '오늘 배움 마무리 화면으로 바꿨어요', present: '발표 화면으로 바꿨어요' }[lesson];
  if (isTeacher) { try { await setDoc(doc(db, 'settings', 'state'), { lesson }, { merge: true }); } catch { /* 이 화면만 바뀜 */ } }
  toast(msg);
}));

/* ================= 수업 화면 ================= */
const CLOUD_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
function renderClose() {
  const v = visible();
  if (lesson === 'close') setStu(new Set(v.map((e) => e.sid)).size);
  $('#kw').innerHTML = '<strong>🔥 자주 등장한 핵심 키워드 Top 5:</strong>' + keywords(v).map((k) => `<span>#${esc(k)}</span>`).join('');
  $('#list').innerHTML = v.length ? [...v].sort((a, b) => ts(b) - ts(a)).map((e) =>
    `<div class="card"><div class="who">👤 ${esc(e.nick)} <span class="no">${esc(e.sid)}</span></div><q>${esc(e.body)}</q></div>`).join('')
    : '<div class="empty">아직 제출된 일기가 없어요. QR 코드로 첫 일기를 받아 보세요.</div>';
  const t = v.find((e) => e.id === picks.teacher);
  $('#tQuote').textContent = t ? `"${t.body}"` : '교사 관리 모드에서 추천 일기를 골라 주세요';
  $('#tBy').textContent = t ? '- ' + label(t) : '';
  const { e: a, reason } = currentAi(v);
  $('#aiQuote').textContent = a ? `"${a.body}"` : '';
  $('#aiBy').textContent = a ? '- ' + label(a) : '';
  $('#aiWhy').textContent = a && reason ? `💡 ${reason}` : '';
  $('#trio').innerHTML = picks.best.map((id, i) => { const e = v.find((x) => x.id === id); if (!e) return '';
    return `<div class="card"><div class="rank">✨ 추천 ${i + 1} (${esc(e.sid)})</div><div class="nick">"${esc(e.nick)}"</div></div>`; }).join('')
    || '<div class="empty">교사 관리 모드에서 별명 명작을 골라 주세요</div>';
}
function renderIntro() {
  const v = iVisible(), wc = wordCounts(v), max = wc[0]?.[1] || 1;
  const people = new Set(v.map((e) => e.sid)).size;
  if (lesson === 'intro') setStu(people);
  $('#iCount').textContent = people + '명';
  $('#iTop3').textContent = wc.length ? wc.slice(0, 3).map(([w, c]) => `${w} (${c}회)`).join(' | ') : '아직 제출된 단어가 없어요';
  const order = []; wc.slice(0, 40).forEach((x, i) => (i % 2 ? order.push(x) : order.unshift(x)));
  $('#cloud').innerHTML = wc.length ? order.map(([w, c], i) => `<span style="font-size:${14 + Math.round((c / max) * 34)}px;color:${CLOUD_COLORS[(w.length + i) % CLOUD_COLORS.length]}" title="${c}회">${esc(w)}</span>`).join('')
    : '<div class="empty">QR 코드로 학생들의 연상 단어를 받아 보세요.</div>';
  const top = wc.slice(0, 5), tmax = Math.max(1, top[0]?.[1] || 1), ticks = []; for (let t = 0; t <= tmax; t++) ticks.push(t);
  $('#bars').innerHTML = top.length ? `<div class="axis">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="plot"><div class="grid">${ticks.map(() => '<i></i>').join('')}</div>${top.map(([w, c]) => `<div class="col"><div class="bar" style="height:${(c / tmax) * 100}%"><b>${c}</b></div><span class="lab" title="${esc(w)}">${esc(w)}</span></div>`).join('')}</div>`
    : '<div class="empty" style="grid-column:1/-1">아직 제출된 단어가 없어요.</div>';
  $('#iList').innerHTML = v.length ? [...v].sort((a, b) => a.sid.localeCompare(b.sid)).map((e) => `<div class="card"><div class="who">${esc(e.sid)} ${esc(e.name)}</div><div style="margin-top:4px">💡 단어1: ${esc(e.w1)} / 단어2: ${esc(e.w2)}</div></div>`).join('')
    : '<div class="empty">아직 제출이 없어요.</div>';
}
function renderAll() { renderClose(); renderIntro(); renderPresent(); if (isTeacher) { renderTeacherClose(); renderTeacherIntro(); renderTeacherPresent(); } }

$('#btnRefresh').onclick = async () => {
  try {
    const [a, b] = await Promise.all([
      getDocsFromServer(query(collection(db, 'entries'), where('hidden', '==', false))),
      getDocsFromServer(query(collection(db, 'intro'), where('hidden', '==', false))),
    ]);
    pubEntries = a.docs.map(toEntry); pubIntro = b.docs.map(toEntry); renderAll(); toast('최신 데이터를 불러왔어요');
  } catch { toast('불러오지 못했어요. 인터넷 연결을 확인해 주세요'); }
};
async function showQr(hash, title) {
  const url = linkFor(hash);
  await QRCode.toCanvas($('#qr'), url, { width: 720, margin: 1 });
  $('#qrUrl').textContent = url; $('#qrTitle').textContent = title; $('#qrModal').hidden = false;
}
// 학생 제출 링크: 반 이름이 들어가서 반마다 QR이 달라짐
const submitHash = (c = className, l = lesson) => ({ intro: 'intro', present: 'present' }[l] || 'write') + (c ? `?c=${encodeURIComponent(c)}` : '');
const qrTitleFor = (c = className, l = lesson) => `${c ? `[${c}] ` : ''}휴대폰으로 찍으면 ${{ intro: '연상 단어 제출', present: '발표 자료 올리기' }[l] || '일기 제출'} 화면이 열려요`;
$('#btnQR').onclick = () => showQr(submitHash(), qrTitleFor());
// 위쪽 막대의 QR: 학생 휴대폰으로 수업 화면을 볼 때만 가끔 씀
$('#navQr').onclick = () => showQr('class', '휴대폰으로 찍으면 수업 화면이 열려요');
// 위쪽 막대가 두 줄이 되어도 QR 카드가 그 아래에 오도록 높이를 따라감
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--tb-h', Math.ceil(e.target.getBoundingClientRect().height) + 'px')).observe($('.topbar'));
$('#qrClose').onclick = () => ($('#qrModal').hidden = true);

/* 오른쪽 위에 항상 떠 있는 제출 QR (수업 화면에서만) */
// 처음에는 항상 펼친 상태로 시작
let qfMini = false;
let qfDrawn = '';
async function renderQrFloat() {
  const onClass = !$('#v-class').hidden && configured;
  // 접으면 QR 카드를 아예 치우고, 위쪽 막대의 작은 버튼으로만 남겨서 보드판이 자리를 다 쓰게 함
  $('#qrFloat').hidden = !onClass || qfMini;
  $('#qfOpen').hidden = !onClass || !qfMini;
  document.documentElement.dataset.qr = onClass && !qfMini ? 'open' : '';
  if (!onClass || qfMini) return;
  $('#qfToggle').textContent = 'QR 접기';
  $('#qfTitle').textContent = { intro: '🚪 배움 시작 제출', present: '🎤 발표 자료 올리기' }[lesson] || '🏁 배움 마무리 제출';
  const url = linkFor(submitHash());
  $('#qfCap').textContent = className ? `${className} 전용 · 휴대폰 카메라로 찍으세요` : '휴대폰 카메라로 찍으세요';
  if (!qfMini && qfDrawn !== url) { await QRCode.toCanvas($('#qfCanvas'), url, { width: 160, margin: 1 }); qfDrawn = url; }
}
$('#qfToggle').onclick = () => { qfMini = true; renderQrFloat(); };
$('#qfOpen').onclick = () => { qfMini = false; renderQrFloat(); };
$('#qfBig').onclick = () => $('#btnQR').click();
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

/* 지도: public/map.jpg 가 있으면 사진, 없으면 직접 그린 지도 */
let drawnMapUrl = '';
/* 그린 지도를 사진처럼 보여 줘서 칸이 넓어져도 늘어나지 않고 알맞게 잘리도록 */
function showDrawnMap() {
  if (!drawnMapUrl) { drawMap(); drawnMapUrl = $('#map').toDataURL('image/png'); }
  const img = $('#mapImg'); img.onerror = null; img.src = drawnMapUrl; img.hidden = false; img.classList.add('drawn'); $('#map').hidden = true;
}
let photos = { map: '', emblem: '' };
function applyPhotos() {
  const img = $('#mapImg');
  img.classList.remove('drawn');
  if (photos.map) { img.onerror = null; img.src = photos.map; img.hidden = false; $('#map').hidden = true; }
  else { img.onerror = showDrawnMap; img.src = '/map.jpg'; img.hidden = false; $('#map').hidden = true; if (img.complete && !img.naturalWidth) showDrawnMap(); }
  $('#emblemImg').hidden = !photos.emblem; if (photos.emblem) $('#emblemImg').src = photos.emblem; $('#emblemSvg').hidden = !!photos.emblem;
  [['map', '#pvMap', '#pvMapNone'], ['emblem', '#pvEmblem', '#pvEmblemNone']].forEach(([k, im, none]) => {
    $(im).hidden = !photos[k]; if (photos[k]) $(im).src = photos[k]; $(none).hidden = !!photos[k];
  });
}
applyPhotos();
/* 사진을 줄여서 JPEG 글자 데이터로 만들기 (Firestore 문서 한 개에 담기도록) */
function fitJpeg(im, maxSide, maxLen) {
  let side = maxSide, out = '';
  for (let k = 0; k < 6; k++) {
    let w = im.naturalWidth || im.width, h = im.naturalHeight || im.height; const r = Math.min(1, side / Math.max(w, h)); w = Math.max(1, Math.round(w * r)); h = Math.max(1, Math.round(h * r));
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
    let q = 0.85; out = c.toDataURL('image/jpeg', q);
    while (out.length > maxLen && q > 0.45) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
    if (out.length <= maxLen) return out;
    side = Math.round(Math.max(w, h) * 0.75);
  }
  return out;
}
const loadImg = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('사진을 읽지 못했어요')); im.src = src; });
function shrinkPhoto(file, maxSide, maxLen = 380000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      resolve(fitJpeg(im, maxSide, maxLen));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어요')); };
    im.src = url;
  });
}
document.querySelectorAll('[data-photo]').forEach((inp) => inp.addEventListener('change', async () => {
  const f = inp.files?.[0]; inp.value = ''; if (!f) return;
  if (!f.type.startsWith('image/')) return toast('사진 파일만 올릴 수 있어요');
  try {
    toast('사진을 줄이는 중이에요…');
    const data = await shrinkPhoto(f, inp.dataset.photo === 'map' ? 1200 : 480);
    await setDoc(doc(db, 'settings', 'photos'), { ...photos, [inp.dataset.photo]: data });
    toast('사진을 바꿨어요. 수업 화면에 바로 반영돼요');
  } catch (err) { console.error(err); toast('사진을 저장하지 못했어요. 더 작은 사진으로 다시 해 주세요'); }
}));
document.querySelectorAll('[data-photo-reset]').forEach((b) => (b.onclick = () => setDoc(doc(db, 'settings', 'photos'), { ...photos, [b.dataset.photoReset]: '' })
  .then(() => toast('기본 그림으로 되돌렸어요')).catch(() => toast('저장하지 못했어요'))));
function drawMap() {
  const c = $('#map'), g = c.getContext('2d'), W = c.width, H = c.height;
  const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, '#e8dcb0'); grd.addColorStop(1, '#cdbd8a');
  g.fillStyle = grd; g.fillRect(0, 0, W, H); g.strokeStyle = 'rgba(90,70,30,.25)'; g.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const land = [[[60, 120], [250, 90], [330, 170], [300, 260], [220, 300], [120, 270], [70, 200]], [[360, 110], [540, 140], [570, 260], [500, 330], [400, 300], [350, 210]],
    [[230, 360], [360, 350], [420, 470], [380, 620], [300, 700], [250, 580], [210, 450]], [[450, 560], [560, 580], [570, 680], [480, 700]]];
  ['#9fbf8a', '#c9a96e', '#d7b77d', '#b6c98f'].forEach((f, i) => { g.beginPath(); land[i].forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = f; g.fill(); g.strokeStyle = 'rgba(70,50,20,.55)'; g.lineWidth = 2; g.stroke(); });
  g.fillStyle = 'rgba(60,40,15,.8)'; g.font = "bold 26px 'Gowun Batang',serif";
  [['유럽', 150, 190], ['아시아', 420, 220], ['아프리카', 270, 500], ['인도양', 470, 470]].forEach(([t, x, y]) => g.fillText(t, x, y));
  g.save(); g.translate(520, 720); g.strokeStyle = 'rgba(60,40,15,.8)'; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 40, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(0, -52); g.lineTo(8, 0); g.lineTo(0, 52); g.lineTo(-8, 0); g.closePath(); g.fillStyle = 'rgba(120,40,30,.85)'; g.fill();
  g.fillStyle = 'rgba(60,40,15,.9)'; g.font = 'bold 20px serif'; g.fillText('N', -7, -58); g.restore();
}

/* ================= 학생 제출 ================= */
// QR 주소의 반(?c=)으로 제출. 반이 없는 주소면 지금 수업하는 반으로
let urlCls = null;
const formCls = () => (urlCls ?? className);
function renderFormCls() {
  const c = formCls();
  document.querySelectorAll('[data-formcls]').forEach((el) => { el.hidden = !c; el.textContent = `🏫 ${c} 제출 화면이에요`; });
}
$('#diaryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sid = $('#wSid').value.trim(), name = $('#wName').value.trim(), nick = $('#wNick').value.trim(), body = $('#wBody').value.trim();
  const bad = checkStudent(sid, name) || (!nick ? '별명을 적어 주세요.' : '') || (!body ? '일기를 적어 주세요.' : '');
  if (bad) { $('#wErr').textContent = bad; return; }
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; $('#wErr').textContent = '';
  try {
    // 수업 화면용 일기와, 교사만 보는 이름을 따로 저장
    const ref = doc(db, 'entries', newId('entries', formCls())); const batch = writeBatch(db);
    batch.set(ref, { sid, nick, body, hidden: false, createdAt: serverTimestamp() });
    batch.set(doc(db, 'entryNames', ref.id), { sid, name });
    await batch.commit();
    e.target.reset(); e.target.hidden = true; $('#done').hidden = false;
  } catch (err) { console.error(err); $('#wErr').textContent = '제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'; }
  finally { btn.disabled = false; }
});
$('#again').onclick = () => { $('#done').hidden = true; $('#diaryForm').hidden = false; };

$('#introForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sid = $('#iSid').value.trim(), name = $('#iName').value.trim(), w1 = normW($('#iW1').value), w2 = normW($('#iW2').value);
  const bad = checkStudent(sid, name) || (!w1 || !w2 ? '떠오르는 단어 2개를 모두 적어 주세요.' : '');
  if (bad) { $('#iErr').textContent = bad; return; }
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; $('#iErr').textContent = '';
  try {
    await setDoc(doc(db, 'intro', newId('intro', formCls())), { sid, name, w1, w2, hidden: false, createdAt: serverTimestamp() });
    e.target.reset(); e.target.hidden = true; $('#iDone').hidden = false;
  } catch (err) { console.error(err); $('#iErr').textContent = '제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'; }
  finally { btn.disabled = false; }
});
$('#iAgain').onclick = () => { $('#iDone').hidden = true; $('#introForm').hidden = false; };

/* ================= 교사 관리 모드 ================= */
function renderTeacherClose() {
  const all = entries(), v = all.filter((e) => !e.hidden);
  $('#sAll').textContent = all.length; $('#sShow').textContent = v.length;
  $('#sHide').textContent = all.length - v.length; $('#sStu').textContent = new Set(all.map((e) => e.sid)).size;
  const opts = '<option value="">선택 안 함</option>' + [...v].sort((a, b) => ts(b) - ts(a)).map((e) => `<option value="${e.id}">${esc(label(e))} · ${esc(String(e.body).slice(0, 16))}</option>`).join('');
  [['#pTeacher', picks.teacher], ['#pB1', picks.best[0]], ['#pB2', picks.best[1]], ['#pB3', picks.best[2]]].forEach(([s, val]) => {
    $(s).innerHTML = opts; $(s).value = v.some((e) => e.id === val) ? val : '';
  });
  const cur = currentAi(v);
  $('#aiMode').textContent = cur.gemini ? '· Gemini가 고름' : '· 키워드 자동 선정 중';
  $('#aiNow').textContent = cur.e ? `${label(cur.e)} "${cur.e.body}"${cur.reason ? ` — ${cur.reason}` : ''}` : '아직 제출된 일기가 없어요';
  $('#aiReset').hidden = !cur.gemini;
  const q = $('#q').value.trim(), st = $('#fState').value;
  const rows = [...all].sort((a, b) => ts(b) - ts(a)).filter((e) => (!q || `${e.sid} ${e.name} ${e.nick} ${e.body}`.includes(q)) && (!st || (st === 'on') !== e.hidden));
  $('#cnt').textContent = `${rows.length}건`;
  $('#rows').innerHTML = rows.length ? rows.map((e) => `<tr class="${e.hidden ? 'hid' : ''}" data-id="${e.id}">
    <td class="num">${esc(e.sid)}</td><td>${esc(e.name)}</td><td>${esc(e.nick)}</td><td class="body">${esc(e.body)}</td><td class="num">${hm(e.at)}</td>
    <td><span class="state ${e.hidden ? 'off' : 'on'}">${e.hidden ? '숨김' : '표시 중'}</span></td>
    <td class="act"><div class="row"><button type="button" class="sm" data-a="toggle">${e.hidden ? '보이기' : '숨기기'}</button><button type="button" class="sm" data-a="edit">수정</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">해당하는 일기가 없어요.</td></tr>';
}
function renderTeacherIntro() {
  const recs = introRecords(), shown = iVisible();
  $('#isAll').textContent = recs.length; $('#isShow').textContent = shown.length;
  $('#isHide').textContent = recs.filter((e) => e.hidden).length; $('#isWords').textContent = wordCounts(shown).length;
  const q = $('#iq').value.trim();
  const rows = [...recs].sort((a, b) => a.sid.localeCompare(b.sid) || ts(b) - ts(a)).filter((e) => !q || `${e.sid} ${e.name} ${e.w1} ${e.w2}`.includes(q));
  $('#iCnt').textContent = `${rows.length}건`;
  $('#iRows').innerHTML = rows.length ? rows.map((e) => `<tr class="${e.hidden ? 'hid' : ''}" data-id="${e.id}"><td class="num">${esc(e.sid)}</td><td>${esc(e.name)}</td><td>${esc(e.w1)}</td><td>${esc(e.w2)}</td><td class="num">${hm(e.at)}</td>
    <td><span class="state ${e.hidden ? 'off' : 'on'}">${e.hidden ? '숨김' : '표시 중'}</span></td>
    <td class="act"><div class="row"><button type="button" class="sm" data-a="toggle">${e.hidden ? '보이기' : '숨기기'}</button><button type="button" class="sm" data-a="edit">수정</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">해당하는 제출이 없어요.</td></tr>';
}
$('#q').oninput = renderTeacherClose; $('#fState').onchange = renderTeacherClose; $('#iq').oninput = renderTeacherIntro;

const clsKey = (c = className) => c || '_';
let picksDoc = {}, aiDoc = {};
function syncPicks() {
  const x = picksDoc.byCls?.[clsKey()] || (className ? {} : picksDoc);
  picks = { teacher: x.teacher ?? null, best: Array.isArray(x.best) ? x.best : [null, null, null] };
  const y = aiDoc.byCls?.[clsKey()] || (className ? {} : aiDoc);
  aiSel = { id: y.id ?? null, reason: y.reason || '' };
}
const setPicksFor = (c, p) => setDoc(doc(db, 'settings', 'picks'), { byCls: { [clsKey(c)]: p } }, { merge: true });
const setAiFor = (c, a) => setDoc(doc(db, 'settings', 'ai'), { byCls: { [clsKey(c)]: a } }, { merge: true });
const savePicks = (p) => setPicksFor(className, p).then(() => toast('수업 화면 추천을 바꿨어요')).catch(() => toast('저장하지 못했어요'));
$('#pTeacher').onchange = (e) => savePicks({ ...picks, teacher: e.target.value || null });
['#pB1', '#pB2', '#pB3'].forEach((s, i) => ($(s).onchange = (e) => { const best = [...picks.best]; best[i] = e.target.value || null; savePicks({ ...picks, best }); }));

/* Gemini AI 추천: Vercel 서버 함수(/api/ai-pick) 경유. 일기 내용과 문서 ID만 보냄 */
$('#aiRun').onclick = async () => {
  const v = visible(); if (!v.length) return toast('추천할 일기가 없어요');
  const btn = $('#aiRun'); btn.disabled = true; btn.textContent = 'AI가 읽는 중…';
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch('/api/ai-pick', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subject: cfg.subject, criteria: cfg.aiCriteria, entries: v.map((e) => ({ id: e.id, body: e.body })) }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `오류 ${r.status}`);
    await setAiFor(className, { id: out.id, reason: out.reason || '' });
    toast('AI 추천 일기를 골랐어요');
  } catch (err) { console.error(err); toast(`AI 추천을 받지 못했어요: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = 'AI로 다시 고르기'; }
};
$('#aiReset').onclick = () => setAiFor(className, { id: null, reason: '' }).then(() => toast('키워드 자동 선정으로 되돌렸어요')).catch(() => toast('저장하지 못했어요'));

const confirmRow = (tr) => (tr.querySelector('.act').innerHTML = '<div class="row"><span class="muted">삭제할까요?</span><button type="button" class="sm danger" data-a="delok">삭제</button><button type="button" class="sm" data-a="cancel">취소</button></div>');
let editing = null, iEditing = null;
$('#rows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const tr = b.closest('tr'), id = tr.dataset.id, en = byId(id), a = b.dataset.a;
  try {
    if (a === 'toggle') { await updateDoc(doc(db, 'entries', id), { hidden: !en.hidden }); toast(en.hidden ? '수업 화면에 다시 보여요' : '수업 화면에서 숨겼어요'); }
    if (a === 'edit') { editing = id; $('#eSid').value = en.sid; $('#eName').value = en.name; $('#eNick').value = en.nick; $('#eBody').value = en.body; $('#editModal').hidden = false; }
    if (a === 'del') confirmRow(tr);
    if (a === 'delok') { const bt = writeBatch(db); bt.delete(doc(db, 'entries', id)); bt.delete(doc(db, 'entryNames', id)); await bt.commit(); toast('삭제했어요'); }
    if (a === 'cancel') renderTeacherClose();
  } catch (err) { console.error(err); toast('처리하지 못했어요. 다시 시도해 주세요'); }
};
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sid = $('#eSid').value.trim(), name = $('#eName').value.trim(), nick = $('#eNick').value.trim(), body = $('#eBody').value.trim();
  const bad = checkStudent(sid, name); if (bad) return toast(bad);
  try {
    const bt = writeBatch(db);
    bt.update(doc(db, 'entries', editing), { sid, nick, body });
    bt.set(doc(db, 'entryNames', editing), { sid, name });
    await bt.commit(); $('#editModal').hidden = true; toast('수정했어요');
  } catch { toast('저장하지 못했어요'); }
});
$('#eCancel').onclick = () => ($('#editModal').hidden = true);

$('#iRows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const tr = b.closest('tr'), id = tr.dataset.id, en = allIntro.find((x) => x.id === id), a = b.dataset.a;
  try {
    if (a === 'toggle') { await updateDoc(doc(db, 'intro', id), { hidden: !en.hidden }); toast(en.hidden ? '수업 화면에 다시 보여요' : '수업 화면에서 숨겼어요'); }
    if (a === 'edit') { iEditing = id; $('#ieSid').value = en.sid; $('#ieName').value = en.name; $('#ieW1').value = en.w1; $('#ieW2').value = en.w2; $('#iEditModal').hidden = false; }
    if (a === 'del') confirmRow(tr);
    if (a === 'delok') { await deleteDoc(doc(db, 'intro', id)); toast('삭제했어요'); }
    if (a === 'cancel') renderTeacherIntro();
  } catch (err) { console.error(err); toast('처리하지 못했어요. 다시 시도해 주세요'); }
};
$('#iEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sid = $('#ieSid').value.trim(), name = $('#ieName').value.trim();
  const bad = checkStudent(sid, name); if (bad) return toast(bad);
  try { await updateDoc(doc(db, 'intro', iEditing), { sid, name, w1: normW($('#ieW1').value), w2: normW($('#ieW2').value) }); $('#iEditModal').hidden = true; toast('수정했어요'); }
  catch { toast('저장하지 못했어요'); }
});
$('#ieCancel').onclick = () => ($('#iEditModal').hidden = true);

// 한 반의 기록만 지움 (다른 반 기록은 그대로)
async function deleteAll(col, alsoCol, c = className) {
  const docs = (await getDocs(collection(db, col))).docs.filter((d) => clsOf(d.id) === c);
  for (let i = 0; i < docs.length; i += 200) {
    const bt = writeBatch(db);
    docs.slice(i, i + 200).forEach((d) => { bt.delete(d.ref); if (alsoCol) bt.delete(doc(db, alsoCol, d.id)); });
    await bt.commit();
  }
}
function confirmBox(box, text, onOk, okLabel = '지우기') {
  box.innerHTML = `<div class="confirm" style="margin-bottom:12px"><span>${text}</span><button type="button" class="sm danger">${okLabel}</button><button type="button" class="sm">취소</button></div>`;
  const [ok, no] = box.querySelectorAll('button');
  no.onclick = () => (box.innerHTML = '');
  ok.onclick = async () => { ok.disabled = true; try { await onOk(); box.innerHTML = ''; } catch (err) { console.error(err); toast('지우지 못했어요'); ok.disabled = false; } };
}
$('#clearAll').onclick = () => confirmBox($('#clearBox'), `${className ? esc(className) + ' ' : ''}일기 ${entries().length}건을 지울까요? 다른 반 기록은 그대로 남아요. 지우기 전에 반별 수업 기록으로 자동 저장해 두니, 나중에 다시 불러올 수 있어요.`, async () => {
  await saveArchive('비우기 전 자동 저장');
  await deleteAll('entries', 'entryNames');
  await setPicksFor(className, { teacher: null, best: [null, null, null] });
  await setAiFor(className, { id: null, reason: '' });
  toast('새 수업을 시작했어요');
});
$('#iClearAll').onclick = () => confirmBox($('#iClearBox'), `${className ? esc(className) + ' ' : ''}연상 단어 ${introRecords().length}건을 지울까요? 다른 반 기록은 그대로 남아요. 지우기 전에 반별 수업 기록으로 자동 저장해 두니, 나중에 다시 불러올 수 있어요.`, async () => {
  await saveArchive('비우기 전 자동 저장');
  await deleteAll('intro'); toast('배움 시작 기록을 비웠어요');
});
document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
  navigator.clipboard?.writeText(linkFor(b.dataset.copy)).then(() => toast('링크를 복사했어요'), () => toast('복사가 안 돼요. 주소를 직접 선택해 주세요'));
}));

/* ================= 수업 들어가는 반 · 재적수 (settings/classes) ================= */
let classList = [];   // [{ name, size }]
const classSize = () => classList.find((c) => c.name === className)?.size || 0;
function setStu(n) { const size = classSize(); $('#cStu').textContent = size ? `${n} / ${size}` : n; }
function renderClassPicker() {
  const sel = $('#clsSelect'), known = classList.some((c) => c.name === className);
  sel.innerHTML = '<option value="">반을 고르세요</option>'
    + classList.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}${c.size ? ` (${c.size}명)` : ''}</option>`).join('')
    + '<option value="__custom">직접 입력…</option>';
  if (document.activeElement !== sel && document.activeElement !== $('#clsName')) {
    sel.value = className ? (known ? className : '__custom') : '';
    $('#clsName').value = className; $('#clsName').hidden = sel.value !== '__custom';
  }
}
$('#clsSelect').onchange = (e) => {
  const v = e.target.value; $('#clsName').hidden = v !== '__custom';
  if (v === '__custom') { $('#clsName').value = ''; $('#clsName').focus(); } else $('#clsName').value = v;
};
function clsRow(c = { name: '', size: '' }) {
  return `<div class="cls-row"><input class="cn" maxlength="20" placeholder="예: 2학년 1반" value="${esc(c.name)}" aria-label="반 이름">
    <label class="inline-num">재적 <input class="cs" type="number" min="1" max="60" inputmode="numeric" value="${c.size || ''}" aria-label="재적수">명</label>
    <button type="button" class="sm qr" title="이 반 학생 제출 QR">QR</button><button type="button" class="sm danger rm">삭제</button></div>`;
}
let clsEditing = false;
function renderClassEditor() {
  if (clsEditing) return;
  $('#clsList').innerHTML = (classList.length ? classList : [{ name: '', size: '' }]).map(clsRow).join('');
}
$('#clsList').addEventListener('input', () => (clsEditing = true));
$('#clsList').onclick = (e) => {
  if (e.target.closest('.qr')) { const c = e.target.closest('.cls-row').querySelector('.cn').value.trim(); if (!c) return toast('반 이름을 먼저 적어 주세요'); return showQr(submitHash(c), qrTitleFor(c)); }
  if (e.target.closest('.rm')) { e.target.closest('.cls-row').remove(); clsEditing = true; } };
$('#clsAdd').onclick = () => { $('#clsList').insertAdjacentHTML('beforeend', clsRow()); clsEditing = true; $('#clsList .cls-row:last-child .cn').focus(); };
$('#clsListSave').onclick = async () => {
  const list = [...document.querySelectorAll('#clsList .cls-row')].map((r) => ({ name: r.querySelector('.cn').value.trim(), size: Math.max(0, Math.trunc(Number(r.querySelector('.cs').value) || 0)) }))
    .filter((c) => c.name);
  const names = list.map((c) => c.name); if (new Set(names).size !== names.length) return toast('같은 반 이름이 두 번 있어요. 하나를 지워 주세요');
  try { await setDoc(doc(db, 'settings', 'classes'), { list }); clsEditing = false; toast(`반 ${list.length}개를 저장했어요`); }
  catch { toast('저장하지 못했어요'); }
};

/* ================= 반별 수업 기록 (archives) ================= */
let className = '', archives = [];
const fmtWhen = (t) => { const d = t?.toDate?.(); if (!d) return '-'; return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} (${DAYS[d.getDay()]}) ${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ms = (e) => e.at?.getTime?.() ?? Date.now();
// 지금 기록 전체를 한 문서로 보관 (사진·화면 설정은 그대로 두고 수업 기록만)
async function saveArchive(memo = '') {
  const allEntries = entries(), allIntro = introRecords();   // 지금 반 기록만
  if (!allEntries.length && !allIntro.length) return null;
  const ref = await addDoc(collection(db, 'archives'), {
    className: className || '반 이름 없음', memo, savedAt: serverTimestamp(),
    entries: allEntries.map((e) => ({ id: e.id, sid: e.sid, nick: e.nick, body: e.body, hidden: e.hidden, at: ms(e), name: names.get(e.id)?.name || '' })),
    intro: allIntro.map((e) => ({ id: e.id, sid: e.sid, name: e.name, w1: e.w1, w2: e.w2, hidden: e.hidden, at: ms(e) })),
    picks, ai: aiSel,
    counts: { intro: new Set(allIntro.map((e) => e.sid)).size, close: allEntries.length, size: classSize() },
  });
  return ref.id;
}
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) { const bt = writeBatch(db); ops.slice(i, i + 400).forEach((f) => f(bt)); await bt.commit(); }
}
async function restoreArchive(a) {
  // 저장한 반으로 바꾼 뒤, 그 반의 지금 기록만 먼저 자동 저장하고 바꿈 (다른 반 기록은 그대로)
  const c = a.className === '반 이름 없음' ? '' : a.className;
  if (c !== className) { className = c; await setDoc(doc(db, 'settings', 'state'), { className: c }, { merge: true }); }
  await saveArchive('불러오기 전 자동 저장');
  await deleteAll('entries', 'entryNames', c); await deleteAll('intro', null, c);
  const id = (x) => clsPrefix(c) + rawId(x), map = (x) => (x ? id(x) : x);
  const ops = [];
  (a.entries || []).forEach((e) => {
    ops.push((bt) => bt.set(doc(db, 'entries', id(e.id)), { sid: e.sid, nick: e.nick, body: e.body, hidden: !!e.hidden, createdAt: Timestamp.fromMillis(e.at) }));
    if (e.name) ops.push((bt) => bt.set(doc(db, 'entryNames', id(e.id)), { sid: e.sid, name: e.name }));
  });
  (a.intro || []).forEach((e) => ops.push((bt) => bt.set(doc(db, 'intro', id(e.id)), { sid: e.sid, name: e.name, w1: e.w1, w2: e.w2, hidden: !!e.hidden, createdAt: Timestamp.fromMillis(e.at) })));
  await commitInChunks(ops);
  const p = a.picks || {};
  await setPicksFor(c, { teacher: map(p.teacher ?? null), best: (Array.isArray(p.best) ? p.best : [null, null, null]).map(map) });
  await setAiFor(c, { id: map(a.ai?.id ?? null), reason: a.ai?.reason || '' });
}
function renderArchives() {
  $('#archRows').innerHTML = archives.length ? archives.map((a) => `<tr data-id="${a.id}">
    <td><b>${esc(a.className)}</b></td><td class="num">${fmtWhen(a.savedAt)}</td>
    <td class="num">${a.counts?.intro ?? 0}${a.counts?.size ? ` / ${a.counts.size}` : ''}명</td><td class="num">${a.counts?.close ?? 0}편</td><td class="memo">${esc(a.memo || '')}</td>
    <td class="act"><div class="row"><button type="button" class="sm primary" data-a="load">불러오기</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">아직 저장된 수업 기록이 없어요. 수업이 끝나면 💾 지금 기록 저장을 눌러 주세요.</td></tr>';
}
const pickedClass = () => ($('#clsSelect').value === '__custom' ? $('#clsName').value.trim() : $('#clsSelect').value);
$('#clsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await setDoc(doc(db, 'settings', 'state'), { className: pickedClass() }, { merge: true }); $('#clsSelect').blur(); toast(pickedClass() ? `지금 수업하는 반: ${pickedClass()}` : '반 선택을 비웠어요'); }
  catch { toast('저장하지 못했어요'); }
});
$('#archSave').onclick = async () => {
  const btn = $('#archSave'); btn.disabled = true;
  try {
    if (pickedClass() !== className) { className = pickedClass(); await setDoc(doc(db, 'settings', 'state'), { className }, { merge: true }); }
    const id = await saveArchive('직접 저장');
    toast(id ? `${className || '반 이름 없음'} 기록을 저장했어요` : '저장할 학생 기록이 아직 없어요');
  } catch (err) { console.error(err); toast('기록을 저장하지 못했어요'); }
  finally { btn.disabled = false; }
};
$('#archRows').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const a = archives.find((x) => x.id === b.closest('tr').dataset.id); if (!a) return;
  const when = fmtWhen(a.savedAt);
  if (b.dataset.a === 'load') confirmBox($('#archBox'), `${esc(a.className)} (${when}) 기록을 불러올까요? 지금 수업하는 반이 ${esc(a.className)}(으)로 바뀌고, 그 반의 지금 기록은 먼저 자동 저장돼요. 다른 반 기록은 그대로예요.`, async () => { await restoreArchive(a); toast(`${a.className} 기록을 불러왔어요`); }, '불러오기');
  if (b.dataset.a === 'del') confirmBox($('#archBox'), `${esc(a.className)} (${when}) 저장 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없어요.`, async () => { await deleteDoc(doc(db, 'archives', a.id)); toast('저장 기록을 삭제했어요'); }, '삭제');
};

/* 비밀번호로 들어가기: 비밀번호 확인은 Firestore 보안 규칙이 함 (코드에는 비밀번호 없음) */
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin').value.trim(); if (!pin) return;
  const btn = e.target.querySelector('button'); btn.disabled = true; $('#pinMsg').textContent = '';
  try {
    const user = auth.currentUser || (await signInAnonymously(auth)).user;
    await setDoc(doc(db, 'sessions', user.uid), { pin, at: serverTimestamp() });
    $('#pin').value = ''; await enterTeacher();
  } catch (err) {
    console.error(err);
    $('#pinMsg').textContent = err.code === 'permission-denied' ? '비밀번호가 맞지 않아요.' : '들어가지 못했어요. 인터넷 연결을 확인해 주세요.';
  } finally { btn.disabled = false; }
});
$('#logout').onclick = async () => {
  try { if (auth.currentUser) await deleteDoc(doc(db, 'sessions', auth.currentUser.uid)); } catch { /* 무시 */ }
  await signOut(auth); leaveTeacher(); toast('교사 관리 모드에서 나왔어요');
};

let teacherUnsubs = [];
async function enterTeacher() {
  if (isTeacher) return;
  isTeacher = true;
  $('#lock').hidden = true; $('#tBody').hidden = false;
  document.querySelectorAll('[data-link]').forEach((c) => (c.textContent = linkFor(c.dataset.link)));
  const onErr = (err) => { console.error(err); toast('교사 권한을 확인하지 못했어요. 다시 들어와 주세요'); };
  teacherUnsubs = [
    onSnapshot(collection(db, 'entries'), (s) => { allEntries = s.docs.map(toEntry); renderAll(); }, onErr),
    onSnapshot(collection(db, 'entryNames'), (s) => { names = new Map(s.docs.map((d) => [d.id, d.data()])); renderAll(); }, onErr),
    onSnapshot(collection(db, 'intro'), (s) => { allIntro = s.docs.map(toEntry); renderAll(); }, onErr),
    onSnapshot(collection(db, 'presents'), (s) => { rulesMissing = false; allPresents = s.docs.map(toEntry); renderAll(); }, (err) => { console.error(err); rulesMissing = true; renderAll(); }),
    onSnapshot(query(collection(db, 'archives'), orderBy('savedAt', 'desc')), (s) => { archives = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })); renderArchives(); }, onErr),
  ];
  fillCfgForm(cfg); renderAll();
}
function leaveTeacher() {
  isTeacher = false; teacherUnsubs.forEach((u) => u()); teacherUnsubs = [];
  allEntries = []; names = new Map(); allIntro = []; allPresents = [];
  $('#lock').hidden = false; $('#tBody').hidden = true; renderAll();
}

/* ================= 자료 인쇄 (A4) ================= */
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
function printMeta(n) { const d = new Date(); return `<div class="meta">${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) · ${n}</div>`; }
function buildPrint(kind) {
  const S = esc(cfg.subject);
  if (kind === 'iall' || kind === 'iboard') {
    const v = [...iVisible()].sort((a, b) => a.sid.localeCompare(b.sid)), wc = wordCounts(v);
    if (kind === 'iall') return `<h3>${S} 연상 단어</h3>${printMeta(`${v.length}명 제출`)}
      <table><thead><tr><th style="width:70px">학번</th><th style="width:90px">이름</th><th>단어 1</th><th>단어 2</th></tr></thead><tbody>
      ${v.map((e) => `<tr><td>${esc(e.sid)}</td><td>${esc(e.name)}</td><td>${esc(e.w1)}</td><td>${esc(e.w2)}</td></tr>`).join('')}</tbody></table>`;
    return `<h3>${esc(cfg.title)}</h3>${printMeta('오늘 배움 시작 · 연상 단어 정리')}
      <h4>💡 최다 키워드 Top 3</h4><div class="q">${wc.slice(0, 3).map(([w, c]) => `${esc(w)} (${c}회)`).join(' | ')}</div>
      <h4>📊 단어별 제출 횟수</h4><table><thead><tr><th style="width:50px">순위</th><th>단어</th><th style="width:70px">횟수</th></tr></thead><tbody>
      ${wc.slice(0, 15).map(([w, c], i) => `<tr><td>${i + 1}</td><td>${esc(w)}</td><td>${c}</td></tr>`).join('')}</tbody></table>
      <h4>☁️ 우리 반이 떠올린 단어</h4><div class="tags">${wc.map(([w]) => `<span>${esc(w)}</span>`).join('')}</div>`;
  }
  const v = [...visible()].sort((a, b) => a.sid.localeCompare(b.sid) || ts(a) - ts(b));
  const find = (id) => v.find((e) => e.id === id);
  if (kind === 'all') return `<h3>학생 ${S} 배움 일기</h3>${printMeta(`${v.length}편 · ${new Set(v.map((e) => e.sid)).size}명`)}
    <table><thead><tr><th style="width:64px">학번</th><th style="width:80px">이름</th><th style="width:140px">${S} 별명</th><th>배움 일기</th></tr></thead><tbody>
    ${v.map((e) => `<tr><td>${esc(e.sid)}</td><td>${esc(e.name)}</td><td>${esc(e.nick)}</td><td>${esc(e.body)}</td></tr>`).join('')}</tbody></table>`;
  if (kind === 'picks') {
    const t = find(picks.teacher), a = currentAi(v), best = picks.best.map(find).filter(Boolean);
    return `<h3>오늘의 추천 모음</h3>${printMeta(esc(cfg.title))}
    <h4>🏆 선생님 추천 일기</h4>${t ? `<div class="q">"${esc(t.body)}"</div><div class="src">${esc(label(t))}</div>` : "<div class='src'>선택 안 함</div>"}
    <h4>🤖 AI 추천 일기</h4>${a.e ? `<div class="q">"${esc(a.e.body)}"</div><div class="src">${esc(label(a.e))}${a.reason ? ` · 선정 이유: ${esc(a.reason)}` : ''}</div>` : ''}
    <h4>✨ 오늘의 ${S} 별명 명작</h4>${best.length ? `<table><tbody>${best.map((e, i) => `<tr><td style="width:70px">추천 ${i + 1}</td><td><b>"${esc(e.nick)}"</b> (${esc(e.sid)})</td><td>${esc(e.body)}</td></tr>`).join('')}</tbody></table>` : "<div class='src'>선택 안 함</div>"}`;
  }
  if (kind === 'board') return `<h3>${esc(cfg.title)}</h3>${printMeta('오늘의 수업 정리')}
    <h4>🔥 자주 등장한 핵심 키워드 Top 5</h4><div class="tags">${keywords(v).map((k) => `<span>#${esc(k)}</span>`).join('')}</div>
    <h4>📖 우리 반 ${S} 별명</h4><table><tbody>${chunk(v, 3).map((r) => `<tr>${r.map((e) => `<td><b>${esc(e.nick)}</b> <span class="src">${esc(e.sid)}</span></td>`).join('')}${'<td></td>'.repeat(3 - r.length)}</tr>`).join('')}</tbody></table>
    ${cfg.quote ? `<div class="foot">"${esc(cfg.quote)}"${cfg.quoteBy ? ` - ${esc(cfg.quoteBy)}` : ''}</div>` : ''}`;
  return `<h3>학생별 ${S} 배움 일기 카드</h3>${printMeta('점선을 따라 잘라 나눠 주세요')}
    <div class="cut">${v.map((e) => `<div><span class="src">${esc(e.sid)} ${esc(e.name)}</span><b>${esc(e.nick)}</b><p style="margin:6px 0 0">${esc(e.body)}</p></div>`).join('')}</div>`;
}
function setPage(css) { let ps = $('#pageSize'); if (!ps) { ps = document.createElement('style'); ps.id = 'pageSize'; document.head.appendChild(ps); } ps.textContent = css; }
function printNow(kind) { document.body.dataset.printing = kind; window.print(); }
window.addEventListener('afterprint', () => delete document.body.dataset.printing);
document.querySelectorAll('[data-print]').forEach((b) => (b.onclick = () => {
  $('#sheet').innerHTML = buildPrint(b.dataset.print);
  setPage('@page{size:A4;margin:14mm}'); printNow('sheet');
}));

/* ================= 수업 화면 게시용 인쇄 (A4/B4 한 장에 학생 글 전부) ================= */
const PAPER = { A4: [210, 297], B4: [257, 364] };   // B4는 학교에서 쓰는 257×364mm
const MM = 96 / 25.4, PAD_MM = 10;
const pv = { lesson: 'close', paper: 'A4', orient: 'portrait' };
function posterHTML(kind, land) {
  const d = new Date(), date = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAYS[d.getDay()]})`;
  const head = (sub) => `<div class="ph"><div><h1>${esc(fillT('{icon} {title}'))}</h1><div class="sub">${esc(sub)}</div></div><div class="date">${date}</div></div>`;
  const foot = (q, b, c) => (q ? `<div class="foot"><blockquote>"${esc(q)}" ${b ? `<cite>- ${esc(b)} -</cite>` : ''}</blockquote>${c ? `<p>${esc(c)}</p>` : ''}</div>` : '');
  const S = esc(cfg.subject);
  if (kind === 'intro') {
    const v = [...intro()].sort((a, b) => a.sid.localeCompare(b.sid)), wc = wordCounts(v), max = wc[0]?.[1] || 1, top = wc.slice(0, 5), tmax = top[0]?.[1] || 1;
    const PC = ['var(--p-a)', 'var(--p-g)', 'var(--p-r)', 'var(--p-v)', 'var(--p-b)'];
    const order = []; wc.slice(0, 40).forEach((x, i) => (i % 2 ? order.push(x) : order.unshift(x)));
    return head(cfg.introSubtitle) + `
      <div class="two"><div class="box"><h2>👥 연상 단어 제출 학생 수</h2><div class="pnum">${new Set(v.map((e) => e.sid)).size}명</div></div>
        <div class="box"><h2>💡 수업 최다 키워드 Top 3</h2><div class="top3">${wc.slice(0, 3).map(([w, c]) => `${esc(w)} (${c}회)`).join(' | ') || '-'}</div></div></div>
      <div class="two"><div class="box"><h2>☁️ 학생 연상 단어 구름</h2><div class="cloud">${order.map(([w, c], i) => `<span style="font-size:${13 + Math.round((c / max) * 30)}px;color:${PC[(w.length + i) % PC.length]}">${esc(w)}</span>`).join('')}</div></div>
        <div class="box"><h2>📊 연상 단어 제출 빈도 Top 5</h2><div class="pbars">${top.map(([w, c], i) => `<div><em>${c}</em><i class="${i ? '' : 'first'}" style="height:${(c / tmax) * 100}%"></i><span>${esc(w)}</span></div>`).join('')}</div></div></div>
      <div class="box"><h2>📖 학생별 ${S} 연상 단어</h2><div class="grid" style="grid-template-columns:repeat(${land ? 5 : 4},1fr)">${v.map((e) => `<div class="card"><div class="who">${esc(e.sid)} ${esc(e.name)}</div><p>${esc(e.w1)} · ${esc(e.w2)}</p></div>`).join('')}</div></div>
      ${foot(cfg.introQuote, cfg.introQuoteBy, cfg.introClosing)}`;
  }
  // 게시용에는 숨김 여부와 관계없이 학생 글 전부를 학번순으로 (이름은 넣지 않음)
  const all = [...entries()].sort((a, b) => a.sid.localeCompare(b.sid) || ts(a) - ts(b)), v = visible();
  const t = v.find((e) => e.id === picks.teacher), a = currentAi(v), best = picks.best.map((id) => v.find((e) => e.id === id)).filter(Boolean);
  return head(cfg.subtitle) + `
    <div class="box kws"><b>🔥 자주 등장한 핵심 키워드 Top 5</b>${keywords(all).map((k) => `<span>#${esc(k)}</span>`).join('')}</div>
    <div class="box"><h2>📖 학생별 ${S} 배움 일기</h2><div class="grid" style="grid-template-columns:repeat(${land ? 4 : 3},1fr)">${all.map((e) => `<div class="card"><div class="who">${esc(e.nick)} <span class="id">${esc(e.sid)}</span></div><p>${esc(e.body)}</p></div>`).join('')}</div></div>
    <div class="two"><div class="box"><h2>🏆 선생님 추천 일기</h2>${t ? `<div class="qo">"${esc(t.body)}"</div><div class="by">- ${esc(label(t))}</div>` : '<div class="by">-</div>'}</div>
      <div class="box"><h2>🤖 AI 추천 일기</h2>${a.e ? `<div class="qg">"${esc(a.e.body)}"</div><div class="by">- ${esc(label(a.e))}${a.reason ? ` · ${esc(a.reason)}` : ''}</div>` : '<div class="by">-</div>'}</div></div>
    ${best.length ? `<div class="box"><h2>✨ 오늘의 ${S} 별명 명작</h2><div class="trio">${best.map((e, i) => `<div><small>추천 ${i + 1} (${esc(e.sid)})</small><b>"${esc(e.nick)}"</b></div>`).join('')}</div></div>` : ''}
    ${foot(cfg.quote, cfg.quoteBy, cfg.closing)}`;
}
function fitPoster() {
  const [w0, h0] = PAPER[pv.paper], land = pv.orient === 'landscape', W = land ? h0 : w0, H = land ? w0 : h0;
  const paper = $('#paper'), poster = $('#poster');
  paper.style.width = W + 'mm'; paper.style.height = H + 'mm';
  poster.style.left = poster.style.top = PAD_MM + 'mm';
  poster.innerHTML = posterHTML(pv.lesson, land);
  const iw = (W - 2 * PAD_MM) * MM, ih = (H - 2 * PAD_MM) * MM; let sc = 1;
  for (let k = 0; k < 6; k++) {
    poster.style.width = (iw / sc) + 'px'; poster.style.transform = `scale(${sc})`;
    const ns = Math.min(1.8, ih / poster.scrollHeight); /* 넘치면 줄이고, 내용이 적으면 키워서 종이를 채움 */
    if (Math.abs(ns - sc) < 0.004) break; sc = ns;
  }
  const stage = $('#paperStage'), vs = Math.min(1, (stage.clientWidth - 32) / (W * MM));
  const scaleBox = $('#paperScale'); scaleBox.style.transform = `scale(${vs})`; scaleBox.style.height = (H * MM * vs) + 'px'; scaleBox.style.width = (W * MM * vs) + 'px';
  const pct = Math.round(sc * 100), list = pv.lesson === 'intro' ? intro() : entries(), people = new Set(list.map((e) => e.sid)).size;
  $('#posterInfo').textContent = `학생 ${people}명이 올린 글 ${list.length}편을 빠짐없이 모두 넣었어요 · ${pv.paper} ${land ? '가로' : '세로'} (${W}×${H}mm) 한 장 · 글자 크기 ${pct}%`
    + (pct < 60 ? ' · 글이 많아 글씨가 작아요. B4나 가로를 추천해요' : pct > 100 ? ' · 내용이 적어 크게 키웠어요' : '');
  document.querySelectorAll('[data-pv]').forEach((b) => b.setAttribute('aria-pressed', pv[b.dataset.pv] === b.dataset.val));
  return { W, H };
}
document.querySelectorAll('[data-poster]').forEach((b) => (b.onclick = () => { pv.lesson = lesson; $('#posterModal').hidden = false; requestAnimationFrame(fitPoster); }));
document.querySelectorAll('[data-pv]').forEach((b) => (b.onclick = () => { pv[b.dataset.pv] = b.dataset.val; fitPoster(); }));
$('#posterClose').onclick = () => ($('#posterModal').hidden = true);
$('#posterPrint').onclick = () => {
  const { W, H } = fitPoster();
  const area = $('#posterPrintArea'); area.innerHTML = '';
  const cp = $('#paper').cloneNode(true); cp.removeAttribute('id'); cp.style.height = (H - 0.6) + 'mm'; cp.style.boxShadow = 'none'; area.appendChild(cp);
  setPage(`@page{size:${W}mm ${H}mm;margin:0}`); printNow('poster');
};
window.addEventListener('resize', () => { if (!$('#posterModal').hidden) fitPoster(); });

/* ================= 현재 시각 · 밝게/어둡게 ================= */
function tick() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  $('#clock').innerHTML = `<small>${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})</small>${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tick(); setInterval(tick, 1000);
function setMode(m) { document.documentElement.dataset.mode = m; $('#modeBtn').textContent = m === 'light' ? '🌙 어둡게' : '☀️ 밝게'; try { localStorage.setItem('mode', m); } catch { /* 무시 */ } }
let savedMode = null; try { savedMode = localStorage.getItem('mode'); } catch { /* 무시 */ }
setMode(savedMode === 'light' ? 'light' : 'dark');
$('#modeBtn').onclick = () => setMode(document.documentElement.dataset.mode === 'light' ? 'dark' : 'light');

/* ================= 🎤 발표 자료 =================
   presents/{반~ID}      : 제목·발표자·내용·링크·작은 사진(thumb) — 수업 화면 목록용 (가벼움)
   presentPhotos/{같은 ID}: 큰 사진들과 설명 — 발표 화면을 열 때만 불러옴
   학생은 자동 익명 로그인(owner)으로 자기 휴대폰에서 다시 고칠 수 있음 */
const P_MAX_PHOTOS = 4, P_MAX_LINKS = 3;
let rulesMissing = false;   // Firebase 규칙에 발표 자료 부분이 아직 없을 때
const RULES_MSG = '⚠️ Firebase 규칙에 발표 자료 부분이 아직 게시되지 않았어요. Firebase 콘솔 → Firestore Database → 규칙 탭에 새 firestore.rules 내용을 전부 붙여넣고 [게시]를 눌러 주세요. 게시 후 1분쯤 지나면 학생들이 올릴 수 있어요.';
const presentsAll = () => (isTeacher ? allPresents : pubPresents).filter(inCls);
const pOrder = (a, b) => (a.order || 0) - (b.order || 0) || ts(a) - ts(b);
const presentsShown = () => presentsAll().filter((e) => !e.hidden).sort(pOrder);
const kindLabel = (k) => (k === 'group' ? '모둠' : '개인');
const safeUrl = (u) => { const t = String(u || '').trim(); if (!t) return ''; const v = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t; return /^https?:\/\//i.test(v) ? v : ''; };
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

/* --- 수업 화면: 발표 자료 카드 --- */
function renderPresent() {
  const v = presentsShown();
  $('#cPres').textContent = v.length;
  $('#pCount').textContent = v.length ? `${v.length}개` : '';
  $('#pPlayAll').hidden = !v.length;
  $('#pGrid').innerHTML = v.length ? v.map((e, i) => `<button type="button" class="pcard" data-i="${i}">
      <div class="pthumb">${e.thumb ? `<img src="${e.thumb}" alt="">` : '<span>🎤</span>'}<em>${i + 1}</em></div>
      <div class="pinfo"><b>${esc(e.title)}</b><span><i class="pk ${e.kind === 'group' ? 'g' : ''}">${kindLabel(e.kind)}</i> ${esc(e.name)}</span>
      <small>${e.nPhotos ? `📷 ${e.nPhotos}` : ''}${e.links?.length ? ` 🔗 ${e.links.length}` : ''} · ▶ 발표 시작</small></div></button>`).join('')
    : `<div class="empty">${rulesMissing ? RULES_MSG : '아직 올라온 발표 자료가 없어요. 오른쪽 위 QR 코드로 학생·모둠이 발표 자료를 올리게 해 보세요.'}</div>`;
}
$('#pGrid').onclick = (e) => { const b = e.target.closest('.pcard'); if (b) openDeck(presentsShown(), Number(b.dataset.i)); };
$('#pPlayAll').onclick = () => openDeck(presentsShown(), 0);

/* --- 발표 화면 (슬라이드) --- */
const photoCache = new Map();
async function photosOf(p) {
  if (p.photos) return p.photos;                       // 미리보기(아직 안 올린 것)
  if (!p.nPhotos) return [];
  if (photoCache.has(p.id + (p.updatedAt?.toMillis?.() || ''))) return photoCache.get(p.id + (p.updatedAt?.toMillis?.() || ''));
  try {
    const d = await getDoc(doc(db, 'presentPhotos', p.id)); const x = d.data() || {};
    const list = (x.photos || []).map((src, i) => ({ src, cap: (x.caps || [])[i] || '' }));
    photoCache.set(p.id + (p.updatedAt?.toMillis?.() || ''), list); return list;
  } catch (err) { console.error(err); return []; }
}
function blocksOf(body) {
  return String(body || '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
}
function blockHTML(b) {
  let html = '', inList = false;
  b.split('\n').forEach((ln) => {
    const t = ln.trim(); if (!t) return;
    const li = t.match(/^[-•*·]\s*(.+)/), h = t.match(/^#+\s*(.+)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${esc(li[1])}</li>`; return; }
    if (inList) { html += '</ul>'; inList = false; }
    html += h ? `<h3>${esc(h[1])}</h3>` : `<p>${esc(t)}</p>`;
  });
  return html + (inList ? '</ul>' : '');
}
const fig = (ph, cls = '') => (ph ? `<figure class="${cls}"><img src="${ph.src}" alt="">${ph.cap ? `<figcaption>${esc(ph.cap)}</figcaption>` : ''}</figure>` : '');
// 내용 덩어리를 글 길이가 비슷하게 최대 n장으로 묶기
function groupBlocks(blocks, n) {
  if (blocks.length <= n) return blocks.map((b) => [b]);
  const total = blocks.reduce((a, b) => a + b.length, 0), groups = [];
  let cur = [], acc = 0;
  blocks.forEach((b, i) => {
    cur.push(b); acc += b.length;
    const left = blocks.length - i - 1, slotsLeft = n - groups.length - 1;
    if (slotsLeft > 0 && (acc >= (total / n) * (groups.length + 1) || left === slotsLeft)) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  return groups;
}
async function buildSlides(p) {
  const photos = await photosOf(p), blocks = blocksOf(p.body), links = (p.links || []).map((l) => ({ ...l, href: safeUrl(l.url) })).filter((l) => l.href);
  const head = `<div class="sl-head">${esc(p.title)}</div>`;
  const slides = [];
  const rest = [...photos];
  const cover = rest.shift();
  slides.push(`<div class="sl sl-title ${cover ? 'has-photo' : ''}"><div class="sl-tx">
      <span class="sl-kind">${kindLabel(p.kind)} 발표${p.cls ? ` · ${esc(p.cls)}` : ''}</span>
      <h2>${esc(p.title)}</h2><div class="sl-by">${esc(p.name)}${p.sid ? ` <small>(${esc(p.sid)})</small>` : ''}</div></div>${fig(cover)}</div>`);
  // 발표 화면은 5장 안팎: 표지 1 + 내용 최대 3 + (남은 사진·링크) 1
  for (const g of groupBlocks(blocks, 3)) {
    const ph = rest.shift();
    slides.push(`<div class="sl sl-text ${ph ? 'has-photo' : ''}">${head}<div class="sl-in"><div class="sl-body">${g.map(blockHTML).join('')}</div>${fig(ph)}</div></div>`);
  }
  if (rest.length || links.length) {
    const qrs = await Promise.all(links.map((l) => QRCode.toDataURL(l.href, { width: 360, margin: 1 }).catch(() => '')));
    const linkHTML = links.map((l, i) => `<a class="sl-link" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">
        ${qrs[i] ? `<img src="${qrs[i]}" alt="링크 QR 코드">` : ''}<b>${esc(l.label || '참고 링크')}</b><span>${esc(shortUrl(l.href))}</span></a>`).join('');
    slides.push(`<div class="sl sl-end ${rest.length ? 'has-ph' : ''} ${links.length ? 'has-ln' : ''}">${head}<div class="sl-in">
      ${rest.length ? `<div class="sl-gal n${rest.length}">${rest.map((x) => fig(x)).join('')}</div>` : ''}
      ${links.length ? `<div class="sl-lns">${linkHTML}</div>` : ''}</div></div>`);
  }
  return slides;
}
const deck = { list: [], pi: 0, si: 0, slides: [] };
async function openDeck(list, pi, si = 0) {
  if (!list.length) return;
  deck.list = list; deck.pi = pi; $('#deck').hidden = false; document.body.classList.add('deck-open');
  $('#deckStage').innerHTML = '<div class="sl sl-wait">발표 화면을 준비하는 중…</div>';
  deck.slides = await buildSlides(list[pi]);
  deck.si = si < 0 ? deck.slides.length - 1 : Math.min(si, deck.slides.length - 1);
  showSlide();
}
function fitText(box) {
  if (!box) return;
  let fs = parseFloat(getComputedStyle(box).fontSize);
  for (let k = 0; k < 30 && box.scrollHeight > box.clientHeight + 1 && fs > 13; k++) { fs *= 0.92; box.style.fontSize = fs + 'px'; }
}
function showSlide() {
  const p = deck.list[deck.pi], n = deck.slides.length, last = deck.si === n - 1, next = deck.list[deck.pi + 1];
  $('#deckStage').innerHTML = deck.slides[deck.si] + (last && next ? `<button type="button" class="sl-next" id="dkNextP">다음 발표: ${esc(next.title)} ▶</button>` : '');
  $('#dkTitle').textContent = deck.list.length > 1 ? `${deck.pi + 1}/${deck.list.length} · ${p.title}` : p.title;
  $('#dkNum').textContent = `${deck.si + 1} / ${n}`;
  $('#dkPrev').disabled = deck.si === 0 && deck.pi === 0;
  $('#dkNext').disabled = last && !next;
  requestAnimationFrame(() => document.querySelectorAll('#deckStage .sl-body, #deckStage .sl-title h2').forEach(fitText));
  $('#dkNextP')?.addEventListener('click', (e) => { e.stopPropagation(); deckGo(1); });
}
function deckGo(d) {
  if ($('#deck').hidden) return;
  const ni = deck.si + d;
  if (ni >= 0 && ni < deck.slides.length) { deck.si = ni; return showSlide(); }
  if (d > 0 && deck.pi < deck.list.length - 1) return openDeck(deck.list, deck.pi + 1, 0);
  if (d < 0 && deck.pi > 0) return openDeck(deck.list, deck.pi - 1, -1);
}
function closeDeck() {
  $('#deck').hidden = true; document.body.classList.remove('deck-open');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$('#dkPrev').onclick = () => deckGo(-1);
$('#dkNext').onclick = () => deckGo(1);
$('#dkClose').onclick = closeDeck;
$('#dkFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#deck').requestFullscreen?.()).catch?.(() => {});
$('#deckStage').onclick = (e) => {
  if (e.target.closest('a,button')) return;
  const r = $('#deckStage').getBoundingClientRect(); deckGo(e.clientX - r.left > r.width / 3 ? 1 : -1);
};
document.addEventListener('keydown', (e) => {
  if ($('#deck').hidden) return;
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); deckGo(1); }
  else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); deckGo(-1); }
  else if (e.key === 'Escape' && !document.fullscreenElement) closeDeck();
});
window.addEventListener('resize', () => { if (!$('#deck').hidden) showSlide(); });

/* --- 학생 편집 화면 (올리기 · 고치기) --- */
const pf = { id: null, photos: [], links: [], owner: '' };
let myPresents = []; try { myPresents = JSON.parse(localStorage.getItem('myPresents') || '[]'); } catch { /* 무시 */ }
const saveMine = () => { try { localStorage.setItem('myPresents', JSON.stringify(myPresents.slice(-20))); } catch { /* 무시 */ } };
const pKind = () => document.querySelector('input[name=pKind]:checked')?.value || 'solo';
function syncKind() {
  const g = pKind() === 'group';
  $('#pSidLbl').textContent = g ? '대표 학생 학번' : '학번';
  $('#pNameLbl').textContent = g ? '모둠 이름과 모둠원' : '이름';
  $('#pName').placeholder = g ? '예: 3모둠 (김서준, 이하윤, 박도윤)' : '예: 홍길동';
}
document.querySelectorAll('input[name=pKind]').forEach((r) => (r.onchange = syncKind));
function renderPhotoList() {
  $('#pPhotoList').innerHTML = pf.photos.map((ph, i) => `<div class="p-photo" data-i="${i}"><img src="${ph.src}" alt="">
    <input class="cap" maxlength="60" placeholder="사진 설명 (선택)" value="${esc(ph.cap)}" aria-label="사진 ${i + 1} 설명">
    <div class="row"><button type="button" class="sm" data-a="up" ${i ? '' : 'disabled'} aria-label="앞으로">◀</button><button type="button" class="sm" data-a="down" ${i < pf.photos.length - 1 ? '' : 'disabled'} aria-label="뒤로">▶</button><button type="button" class="sm danger" data-a="rm">삭제</button></div>
    ${i === 0 ? '<span class="p-cover">표지</span>' : ''}</div>`).join('');
  $('#pPhotoBtn').hidden = pf.photos.length >= P_MAX_PHOTOS;
}
$('#pPhotoList').addEventListener('input', (e) => { const box = e.target.closest('.p-photo'); if (box && e.target.classList.contains('cap')) pf.photos[box.dataset.i].cap = e.target.value; });
$('#pPhotoList').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return; const i = Number(b.closest('.p-photo').dataset.i), a = b.dataset.a;
  if (a === 'rm') pf.photos.splice(i, 1);
  if (a === 'up' && i > 0) [pf.photos[i - 1], pf.photos[i]] = [pf.photos[i], pf.photos[i - 1]];
  if (a === 'down' && i < pf.photos.length - 1) [pf.photos[i + 1], pf.photos[i]] = [pf.photos[i], pf.photos[i + 1]];
  renderPhotoList();
};
$('#pPhotoIn').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/')); e.target.value = '';
  const room = P_MAX_PHOTOS - pf.photos.length;
  if (files.length > room) toast(`사진은 ${P_MAX_PHOTOS}장까지라서 ${room}장만 넣었어요`);
  for (const f of files.slice(0, room)) {
    try { pf.photos.push({ src: await shrinkPhoto(f, 1280, 190000), cap: '' }); renderPhotoList(); }
    catch { toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요'); }
  }
});
function renderLinkList() {
  $('#pLinkList').innerHTML = pf.links.map((l, i) => `<div class="p-link" data-i="${i}">
    <input class="lb" maxlength="40" placeholder="이름 (예: 참고 영상)" value="${esc(l.label)}" aria-label="링크 ${i + 1} 이름">
    <input class="ur" maxlength="500" inputmode="url" placeholder="https://..." value="${esc(l.url)}" aria-label="링크 ${i + 1} 주소">
    <button type="button" class="sm danger">삭제</button></div>`).join('');
  $('#pLinkAdd').hidden = pf.links.length >= P_MAX_LINKS;
}
$('#pLinkList').addEventListener('input', (e) => { const row = e.target.closest('.p-link'); if (!row) return; const l = pf.links[row.dataset.i]; if (e.target.classList.contains('lb')) l.label = e.target.value; else l.url = e.target.value; });
$('#pLinkList').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; pf.links.splice(Number(b.closest('.p-link').dataset.i), 1); renderLinkList(); };
$('#pLinkAdd').onclick = () => { pf.links.push({ label: '', url: '' }); renderLinkList(); $('#pLinkList .p-link:last-child .ur').focus(); };

function resetPresentForm() {
  pf.id = null; pf.photos = []; pf.links = []; pf.owner = '';
  $('#presentForm').reset(); syncKind(); renderPhotoList(); renderLinkList();
  $('#pEditNote').hidden = true; $('#pSubmit').textContent = '올리기'; $('#pErr').textContent = '';
}
async function openPresentForm(editId) {
  $('#pDone').hidden = true; $('#presentForm').hidden = false; renderMine();
  if (!editId) { if (pf.id) resetPresentForm(); return; }
  if (pf.id === editId) return;
  try {
    const d = await getDoc(doc(db, 'presents', editId));
    if (!d.exists()) { toast('발표 자료를 찾지 못했어요'); return resetPresentForm(); }
    const x = d.data(), photos = await photosOf({ id: editId, nPhotos: x.nPhotos || 0, updatedAt: x.updatedAt });
    resetPresentForm();
    pf.id = editId; pf.owner = x.owner || ''; pf.photos = photos.map((p) => ({ ...p })); pf.links = (x.links || []).map((l) => ({ label: l.label || '', url: l.url || '' }));
    document.querySelector(`input[name=pKind][value=${x.kind === 'group' ? 'group' : 'solo'}]`).checked = true; syncKind();
    $('#pSid').value = x.sid || ''; $('#pName').value = x.name || ''; $('#pTitle').value = x.title || ''; $('#pBody').value = x.body || '';
    renderPhotoList(); renderLinkList();
    $('#pEditNote').hidden = false; $('#pSubmit').textContent = '고친 내용 저장';
    urlCls = clsOf(editId); renderFormCls();
  } catch (err) { console.error(err); toast('발표 자료를 불러오지 못했어요'); }
}
$('#pNewInstead').onclick = () => { location.hash = submitHash(formCls(), 'present'); resetPresentForm(); };
function formPresent() {
  return {
    sid: $('#pSid').value.trim(), name: $('#pName').value.trim(), kind: pKind(), title: $('#pTitle').value.trim(), body: $('#pBody').value.trim(),
    links: pf.links.map((l) => ({ label: l.label.trim().slice(0, 40), url: l.url.trim().slice(0, 500) })).filter((l) => l.url),
  };
}
function checkPresent(x) {
  if (!x.sid) return '학번을 적어 주세요.';
  if (!/^[0-9]{4,6}$/.test(x.sid)) return '학번은 숫자 4~6자리로 적어 주세요. 예: 20101';
  if (!x.name) return x.kind === 'group' ? '모둠 이름과 모둠원을 적어 주세요.' : '이름을 적어 주세요.';
  if (!x.title) return '발표 제목을 적어 주세요.';
  if (!x.body && !pf.photos.length && !x.links.length) return '발표 내용, 사진, 링크 중 하나는 넣어 주세요.';
  const bad = x.links.find((l) => !safeUrl(l.url)); if (bad) return `링크 주소를 확인해 주세요: ${bad.url}`;
  return '';
}
$('#pPreview').onclick = () => {
  const x = formPresent(); if (!x.title) { $('#pErr').textContent = '발표 제목을 적으면 미리 볼 수 있어요.'; return; }
  $('#pErr').textContent = '';
  openDeck([{ ...x, id: 'preview', cls: formCls(), photos: pf.photos }], 0);
};
async function makeThumb() {
  if (!pf.photos.length) return '';
  try { return fitJpeg(await loadImg(pf.photos[0].src), 480, 40000); } catch { return ''; }
}
$('#presentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const x = formPresent(), bad = checkPresent(x);
  if (bad) { $('#pErr').textContent = bad; return; }
  const btn = $('#pSubmit'); btn.disabled = true; $('#pErr').textContent = ''; const label0 = btn.textContent; btn.textContent = '올리는 중…';
  try {
    const user = auth.currentUser || (await signInAnonymously(auth)).user;
    const data = { ...x, thumb: await makeThumb(), nPhotos: pf.photos.length, updatedAt: serverTimestamp() };
    const photos = { photos: pf.photos.map((p) => p.src), caps: pf.photos.map((p) => p.cap.trim().slice(0, 60)) };
    const bt = writeBatch(db);
    if (pf.id) {
      bt.update(doc(db, 'presents', pf.id), data);
      bt.set(doc(db, 'presentPhotos', pf.id), { ...photos, owner: pf.owner || user.uid });
    } else {
      pf.id = newId('presents', formCls());
      bt.set(doc(db, 'presents', pf.id), { ...data, owner: user.uid, hidden: false, order: 0, createdAt: serverTimestamp() });
      bt.set(doc(db, 'presentPhotos', pf.id), { ...photos, owner: user.uid });
      pf.owner = user.uid;
    }
    await bt.commit();
    if (!myPresents.includes(pf.id)) { myPresents.push(pf.id); saveMine(); }
    $('#presentForm').hidden = true; $('#pDone').hidden = false; renderMine();
    $('#pDone').dataset.id = pf.id;
  } catch (err) {
    console.error(err); if (!pf.owner) pf.id = null;
    $('#pErr').textContent = err.code === 'permission-denied' ? '저장 권한이 없어요. 선생님께 알려 주세요. (선생님: Firebase 규칙에 발표 자료 부분을 게시해야 해요)' : '올리지 못했어요. 사진이 너무 많거나 인터넷이 불안정할 수 있어요. 다시 눌러 주세요.';
  } finally { btn.disabled = false; btn.textContent = label0; }
});
async function viewOne(id) {
  try { const d = await getDoc(doc(db, 'presents', id)); if (d.exists()) openDeck([toEntry(d)], 0); } catch { toast('발표 화면을 열지 못했어요'); }
}
$('#pDoneView').onclick = () => viewOne($('#pDone').dataset.id);
$('#pDoneEdit').onclick = () => { $('#pDone').hidden = true; $('#presentForm').hidden = false; };
$('#pDoneNew').onclick = () => { resetPresentForm(); $('#pDone').hidden = true; $('#presentForm').hidden = false; location.hash = submitHash(formCls(), 'present'); };
async function renderMine() {
  if (isTeacher || !myPresents.length) { $('#pMine').innerHTML = ''; return; }
  const rows = (await Promise.all(myPresents.map(async (id) => { try { const d = await getDoc(doc(db, 'presents', id)); return d.exists() ? { id, ...d.data() } : null; } catch { return null; } }))).filter(Boolean);
  myPresents = rows.map((r) => r.id); saveMine();
  $('#pMine').innerHTML = rows.length ? `<div class="p-mine"><b>📂 이 휴대폰에서 올린 발표</b>${rows.map((r) => `<div class="row" data-id="${esc(r.id)}"><span class="t">${esc(r.title)}</span>
    <button type="button" class="sm" data-a="view">보기</button><button type="button" class="sm" data-a="edit">고치기</button><button type="button" class="sm danger" data-a="del">삭제</button></div>`).join('')}<div id="pMineBox"></div></div>` : '';
}
$('#pMine').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || !b.dataset.a) return; const id = b.closest('[data-id]').dataset.id;
  if (b.dataset.a === 'view') viewOne(id);
  if (b.dataset.a === 'edit') location.hash = `present?edit=${encodeURIComponent(id)}`;
  if (b.dataset.a === 'del') confirmBox($('#pMineBox'), '이 발표 자료를 지울까요? 지우면 되돌릴 수 없어요.', async () => {
    const bt = writeBatch(db); bt.delete(doc(db, 'presentPhotos', id)); bt.delete(doc(db, 'presents', id)); await bt.commit();
    myPresents = myPresents.filter((x) => x !== id); saveMine(); if (pf.id === id) resetPresentForm(); renderMine(); toast('지웠어요');
  }, '지우기');
};
syncKind(); renderPhotoList(); renderLinkList();

/* --- 교사 관리: 발표 자료 --- */
function renderTeacherPresent() {
  const list = presentsAll().sort(pOrder);
  $('#ptCnt').textContent = `${list.length}개`;
  $('#ptWarn').hidden = !rulesMissing; $('#ptWarn').textContent = RULES_MSG;
  $('#ptRows').innerHTML = list.length ? list.map((e, i) => `<tr class="${e.hidden ? 'hid' : ''}" data-id="${esc(e.id)}">
    <td class="num"><div class="row"><b>${i + 1}</b><button type="button" class="sm" data-a="up" ${i ? '' : 'disabled'} aria-label="앞으로">▲</button><button type="button" class="sm" data-a="down" ${i < list.length - 1 ? '' : 'disabled'} aria-label="뒤로">▼</button></div></td>
    <td>${e.thumb ? `<img class="pt-thumb" src="${e.thumb}" alt="">` : '-'}</td>
    <td><b>${esc(e.title)}</b><div class="muted">📷 ${e.nPhotos || 0} · 🔗 ${e.links?.length || 0} · 글 ${String(e.body || '').length}자</div></td>
    <td>${kindLabel(e.kind)} · ${esc(e.name)} <span class="muted">(${esc(e.sid)})</span></td><td class="num">${hm(e.at)}</td>
    <td><span class="state ${e.hidden ? 'off' : 'on'}">${e.hidden ? '숨김' : '표시 중'}</span></td>
    <td class="act"><div class="row"><button type="button" class="sm primary" data-a="view">보기</button><button type="button" class="sm" data-a="edit">고치기</button><button type="button" class="sm" data-a="toggle">${e.hidden ? '보이기' : '숨기기'}</button><button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">아직 올라온 발표 자료가 없어요.</td></tr>';
}
$('#ptRows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const tr = b.closest('tr'), id = tr.dataset.id, list = presentsAll().sort(pOrder), i = list.findIndex((x) => x.id === id), en = list[i], a = b.dataset.a;
  try {
    if (a === 'view') openDeck([en], 0);
    if (a === 'edit') location.hash = `present?edit=${encodeURIComponent(id)}`;
    if (a === 'toggle') { await updateDoc(doc(db, 'presents', id), { hidden: !en.hidden }); toast(en.hidden ? '수업 화면에 다시 보여요' : '수업 화면에서 숨겼어요'); }
    if (a === 'up' || a === 'down') {
      const j = a === 'up' ? i - 1 : i + 1; [list[i], list[j]] = [list[j], list[i]];
      const bt = writeBatch(db); list.forEach((x, k) => bt.update(doc(db, 'presents', x.id), { order: k + 1 })); await bt.commit();
    }
    if (a === 'del') confirmRow(tr);
    if (a === 'delok') { const bt = writeBatch(db); bt.delete(doc(db, 'presentPhotos', id)); bt.delete(doc(db, 'presents', id)); await bt.commit(); toast('삭제했어요'); }
    if (a === 'cancel') renderTeacherPresent();
  } catch (err) { console.error(err); toast('처리하지 못했어요. 다시 시도해 주세요'); }
};
$('#pClearAll').onclick = () => confirmBox($('#pClearBox'), `${className ? esc(className) + ' ' : ''}발표 자료 ${presentsAll().length}개를 모두 지울까요? 발표 자료는 반별 수업 기록에 저장되지 않아서 되돌릴 수 없어요.`, async () => {
  const ids = presentsAll().map((x) => x.id);
  for (let i = 0; i < ids.length; i += 200) { const bt = writeBatch(db); ids.slice(i, i + 200).forEach((id) => { bt.delete(doc(db, 'presents', id)); bt.delete(doc(db, 'presentPhotos', id)); }); await bt.commit(); }
  toast('발표 자료를 모두 지웠어요');
});

/* ================= 화면 전환 · 시작 ================= */
function route() {
  const V = ['class', 'intro', 'write', 'present', 'teacher'];
  const [h, qs] = location.hash.slice(1).split('?');
  const v = V.includes(h) ? h : 'class';
  const prm = new URLSearchParams(qs || '');
  urlCls = (v === 'intro' || v === 'write' || v === 'present') ? prm.get('c') : null;
  if (v === 'present') openPresentForm(prm.get('edit'));
  renderFormCls();
  V.forEach((x) => ($('#v-' + x).hidden = x !== v));
  document.querySelectorAll('.topbar .nav a').forEach((l) => (l.dataset.v === v ? l.setAttribute('aria-current', 'page') : l.removeAttribute('aria-current')));
  // QR로 바로 들어온 학생에게는 메뉴를 숨기고, 위쪽 메뉴를 눌러 미리보기로 들어온 경우에는 보여 줌
  let fromNav = false; try { fromNav = sessionStorage.getItem('navOpen') === '1'; } catch { /* 무시 */ }
  $('.topbar .nav').hidden = (v === 'intro' || v === 'write' || v === 'present') && !fromNav && !isTeacher;
  renderQrFloat();
  window.scrollTo(0, 0);
}
applyCfg(); fillCfgForm(cfg); showLesson('close');

if (!configured) {
  ['class', 'intro', 'write', 'present', 'teacher'].forEach((x) => ($('#v-' + x).hidden = true));
  $('#setup').hidden = false;
} else {
  document.querySelectorAll('.topbar .nav a').forEach((l) => l.addEventListener('click', () => { try { sessionStorage.setItem('navOpen', '1'); } catch { /* 무시 */ } }));
  window.addEventListener('hashchange', route);
  route();
  // 누구나 보는 데이터: 실시간으로 바로 반영
  onSnapshot(query(collection(db, 'entries'), where('hidden', '==', false)), (s) => { pubEntries = s.docs.map(toEntry); renderAll(); }, console.error);
  onSnapshot(query(collection(db, 'intro'), where('hidden', '==', false)), (s) => { pubIntro = s.docs.map(toEntry); renderAll(); }, console.error);
  onSnapshot(query(collection(db, 'presents'), where('hidden', '==', false)), (s) => { rulesMissing = false; pubPresents = s.docs.map(toEntry); renderAll(); }, (err) => { console.error(err); rulesMissing = true; renderAll(); });
  onSnapshot(doc(db, 'settings', 'config'), (d) => { cfg = { ...PRESETS.history, ...(d.data() || {}) }; applyCfg(); if (!cfgDirty) fillCfgForm(cfg); renderAll(); });
  onSnapshot(doc(db, 'settings', 'picks'), (d) => { picksDoc = d.data() || {}; syncPicks(); renderAll(); });
  onSnapshot(doc(db, 'settings', 'classes'), (d) => { classList = Array.isArray(d.data()?.list) ? d.data().list : []; renderClassPicker(); renderClassEditor(); renderAll(); });
  onSnapshot(doc(db, 'settings', 'photos'), (d) => { const x = d.data() || {}; photos = { map: x.map || '', emblem: x.emblem || '' }; applyPhotos(); });
  onSnapshot(doc(db, 'settings', 'ai'), (d) => { aiDoc = d.data() || {}; syncPicks(); renderAll(); });
  // 교사가 고른 화면(배움 시작/마무리)을 교실 화면이 따라감
  onSnapshot(doc(db, 'settings', 'state'), (d) => {
    const x = d.data() || {}; className = x.className || '';
    $('#clsChip').hidden = !className; $('#clsChip').textContent = className;
    renderClassPicker(); syncPicks(); renderFormCls(); qfDrawn = '';
    showLesson(x.lesson || 'close');
  });
  // 이 기기가 이미 비밀번호로 들어온 적이 있으면 교사 관리 모드 유지
  onAuthStateChanged(auth, async (user) => {
    if (!user) return leaveTeacher();
    try { const s = await getDoc(doc(db, 'sessions', user.uid)); if (s.exists()) await enterTeacher(); else leaveTeacher(); }
    catch { leaveTeacher(); }
  });
}
