import './style.css';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc, onSnapshot, query, where,
  getDocs, getDocsFromServer, serverTimestamp, writeBatch,
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
let picks = { teacher: null, best: [null, null, null] };
let aiSel = { id: null, reason: '' };
let cfg = { ...PRESETS.history };
let lesson = 'close';

const toEntry = (d) => { const x = d.data({ serverTimestamps: 'estimate' }); return { id: d.id, ...x, hidden: !!x.hidden, at: x.createdAt?.toDate?.() ?? null }; };
// 교사는 전체(이름 포함), 그 외에는 숨기지 않은 글만
const entries = () => (isTeacher ? allEntries.map((e) => ({ ...e, name: names.get(e.id)?.name || '' })) : pubEntries);
const visible = () => entries().filter((e) => !e.hidden);
const byId = (id) => entries().find((e) => e.id === id);
// 배움 시작은 원본처럼 학생당 1건: 같은 학번은 가장 최근 제출만
function latestPerSid(list) { const m = new Map(); list.forEach((e) => { const o = m.get(e.sid); if (!o || ts(e) >= ts(o)) m.set(e.sid, e); }); return [...m.values()]; }
const introRecords = () => (isTeacher ? allIntro : pubIntro);
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
  lesson = m === 'intro' ? 'intro' : 'close';
  document.documentElement.dataset.lesson = lesson;
  document.querySelectorAll('button[data-lesson]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lesson === lesson));
  renderAll();
}
document.querySelectorAll('button[data-lesson]').forEach((b) => (b.onclick = async () => {
  showLesson(b.dataset.lesson);
  const msg = b.dataset.lesson === 'intro' ? '오늘 배움 시작 화면으로 바꿨어요' : '오늘 배움 마무리 화면으로 바꿨어요';
  if (isTeacher) { try { await setDoc(doc(db, 'settings', 'state'), { lesson }); } catch { /* 이 화면만 바뀜 */ } }
  toast(msg);
}));

/* ================= 수업 화면 ================= */
const CLOUD_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
function renderClose() {
  const v = visible();
  if (lesson === 'close') $('#cStu').textContent = new Set(v.map((e) => e.sid)).size;
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
  if (lesson === 'intro') $('#cStu').textContent = people;
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
function renderAll() { renderClose(); renderIntro(); if (isTeacher) { renderTeacherClose(); renderTeacherIntro(); } }

$('#btnRefresh').onclick = async () => {
  try {
    const [a, b] = await Promise.all([
      getDocsFromServer(query(collection(db, 'entries'), where('hidden', '==', false))),
      getDocsFromServer(query(collection(db, 'intro'), where('hidden', '==', false))),
    ]);
    pubEntries = a.docs.map(toEntry); pubIntro = b.docs.map(toEntry); renderAll(); toast('최신 데이터를 불러왔어요');
  } catch { toast('불러오지 못했어요. 인터넷 연결을 확인해 주세요'); }
};
$('#btnQR').onclick = async () => {
  const url = linkFor(lesson === 'intro' ? 'intro' : 'write');
  await QRCode.toCanvas($('#qr'), url, { width: 240, margin: 1 });
  $('#qrUrl').textContent = url;
  $('#qrTitle').textContent = lesson === 'intro' ? '휴대폰으로 찍으면 연상 단어 제출 화면이 열려요' : '휴대폰으로 찍으면 일기 제출 화면이 열려요';
  $('#qrModal').hidden = false;
};
$('#qrClose').onclick = () => ($('#qrModal').hidden = true);
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

/* 지도: public/map.jpg 가 있으면 사진, 없으면 직접 그린 지도 */
$('#mapImg').addEventListener('error', () => { $('#mapImg').remove(); $('#map').hidden = false; drawMap(); });
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
$('#diaryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sid = $('#wSid').value.trim(), name = $('#wName').value.trim(), nick = $('#wNick').value.trim(), body = $('#wBody').value.trim();
  const bad = checkStudent(sid, name) || (!nick ? '별명을 적어 주세요.' : '') || (!body ? '일기를 적어 주세요.' : '');
  if (bad) { $('#wErr').textContent = bad; return; }
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; $('#wErr').textContent = '';
  try {
    // 수업 화면용 일기와, 교사만 보는 이름을 따로 저장
    const ref = doc(collection(db, 'entries')); const batch = writeBatch(db);
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
    await addDoc(collection(db, 'intro'), { sid, name, w1, w2, hidden: false, createdAt: serverTimestamp() });
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

const savePicks = (p) => setDoc(doc(db, 'settings', 'picks'), p).then(() => toast('수업 화면 추천을 바꿨어요')).catch(() => toast('저장하지 못했어요'));
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
    await setDoc(doc(db, 'settings', 'ai'), { id: out.id, reason: out.reason || '' });
    toast('AI 추천 일기를 골랐어요');
  } catch (err) { console.error(err); toast(`AI 추천을 받지 못했어요: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = 'AI로 다시 고르기'; }
};
$('#aiReset').onclick = () => setDoc(doc(db, 'settings', 'ai'), { id: null, reason: '' }).then(() => toast('키워드 자동 선정으로 되돌렸어요')).catch(() => toast('저장하지 못했어요'));

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

async function deleteAll(col, alsoCol) {
  const s = await getDocs(collection(db, col));
  for (let i = 0; i < s.docs.length; i += 200) {
    const bt = writeBatch(db);
    s.docs.slice(i, i + 200).forEach((d) => { bt.delete(d.ref); if (alsoCol) bt.delete(doc(db, alsoCol, d.id)); });
    await bt.commit();
  }
}
function confirmBox(box, text, onOk) {
  box.innerHTML = `<div class="confirm" style="margin-bottom:12px"><span>${text}</span><button type="button" class="sm danger">모두 지우기</button><button type="button" class="sm">취소</button></div>`;
  const [ok, no] = box.querySelectorAll('button');
  no.onclick = () => (box.innerHTML = '');
  ok.onclick = async () => { ok.disabled = true; try { await onOk(); box.innerHTML = ''; } catch (err) { console.error(err); toast('지우지 못했어요'); ok.disabled = false; } };
}
$('#clearAll').onclick = () => confirmBox($('#clearBox'), `일기 ${allEntries.length}건을 모두 지우고 새 수업을 시작할까요? 되돌릴 수 없어요.`, async () => {
  await deleteAll('entries', 'entryNames');
  await setDoc(doc(db, 'settings', 'picks'), { teacher: null, best: [null, null, null] });
  await setDoc(doc(db, 'settings', 'ai'), { id: null, reason: '' });
  toast('새 수업을 시작했어요');
});
$('#iClearAll').onclick = () => confirmBox($('#iClearBox'), `연상 단어 ${allIntro.length}건을 모두 지울까요? 되돌릴 수 없어요.`, async () => {
  await deleteAll('intro'); toast('배움 시작 기록을 비웠어요');
});
document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
  navigator.clipboard?.writeText(linkFor(b.dataset.copy)).then(() => toast('링크를 복사했어요'), () => toast('복사가 안 돼요. 주소를 직접 선택해 주세요'));
}));

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
  ];
  fillCfgForm(cfg); renderAll();
}
function leaveTeacher() {
  isTeacher = false; teacherUnsubs.forEach((u) => u()); teacherUnsubs = [];
  allEntries = []; names = new Map(); allIntro = [];
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

/* ================= 화면 전환 · 시작 ================= */
function route() {
  const V = ['class', 'intro', 'write', 'teacher'];
  const v = V.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'class';
  V.forEach((x) => ($('#v-' + x).hidden = x !== v));
  window.scrollTo(0, 0);
}
applyCfg(); fillCfgForm(cfg); showLesson('close');

if (!configured) {
  ['class', 'intro', 'write', 'teacher'].forEach((x) => ($('#v-' + x).hidden = true));
  $('#setup').hidden = false;
} else {
  window.addEventListener('hashchange', route);
  route();
  // 누구나 보는 데이터: 실시간으로 바로 반영
  onSnapshot(query(collection(db, 'entries'), where('hidden', '==', false)), (s) => { pubEntries = s.docs.map(toEntry); renderAll(); }, console.error);
  onSnapshot(query(collection(db, 'intro'), where('hidden', '==', false)), (s) => { pubIntro = s.docs.map(toEntry); renderAll(); }, console.error);
  onSnapshot(doc(db, 'settings', 'config'), (d) => { cfg = { ...PRESETS.history, ...(d.data() || {}) }; applyCfg(); if (!cfgDirty) fillCfgForm(cfg); renderAll(); });
  onSnapshot(doc(db, 'settings', 'picks'), (d) => { const x = d.data() || {}; picks = { teacher: x.teacher ?? null, best: Array.isArray(x.best) ? x.best : [null, null, null] }; renderAll(); });
  onSnapshot(doc(db, 'settings', 'ai'), (d) => { const x = d.data() || {}; aiSel = { id: x.id ?? null, reason: x.reason || '' }; renderAll(); });
  // 교사가 고른 화면(배움 시작/마무리)을 교실 화면이 따라감
  onSnapshot(doc(db, 'settings', 'state'), (d) => showLesson(d.data()?.lesson || 'close'));
  // 이 기기가 이미 비밀번호로 들어온 적이 있으면 교사 관리 모드 유지
  onAuthStateChanged(auth, async (user) => {
    if (!user) return leaveTeacher();
    try { const s = await getDoc(doc(db, 'sessions', user.uid)); if (s.exists()) await enterTeacher(); else leaveTeacher(); }
    catch { leaveTeacher(); }
  });
}
