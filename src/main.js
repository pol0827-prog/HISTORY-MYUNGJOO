import './style.css';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, query, where,
  getDocs, getDocsFromServer, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import QRCode from 'qrcode';
import { db, auth, provider, configured, TEACHER_EMAILS } from './firebase.js';
import { PRESETS, CFG_KEYS } from './presets.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = (e) => `[${e.no}번] ${e.nick}`;
const hm = (d) => (d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '-');
const linkFor = (v) => `${location.origin}${location.pathname}#${v}`;

function toast(m) {
  const t = $('#toast'); t.textContent = m; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- 상태 ---------- */
let publicEntries = [];   // 수업 화면용 (숨김 제외)
let allEntries = [];      // 교사용 (전체)
let picks = { teacher: null, best: [null, null, null] };
let aiSel = { id: null, reason: '' };   // Gemini가 고른 일기 (settings/ai)
let isTeacher = false;

// Gemini 추천이 있고 아직 보이는 일기면 그것을, 아니면 키워드 방식으로 자동 선정
function currentAi(list) {
  const g = list.find((e) => e.id === aiSel.id);
  if (g) return { e: g, reason: aiSel.reason, gemini: true };
  return { e: aiPick(list), reason: '', gemini: false };
}

const toEntry = (d) => {
  const x = d.data({ serverTimestamps: 'estimate' });
  return { id: d.id, no: x.no, nick: x.nick, body: x.body, hidden: !!x.hidden, at: x.createdAt?.toDate?.() ?? null };
};
const newest = (a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0);

/* ---------- 키워드 / AI 추천 (API 키 없이 동작) ---------- */
const STOP = new Set(['오늘', '수업', '하지만', '그리고', '되었다', '같다', '된다', '있다', '없다', '재밌었다', '있어야', '대한', '우리', '정말', '너무']);
const JOSA = /(들은|들을|들이|들의|에서|에게|으로|이다|하다|은|는|이|가|을|를|의|에|도|로|와|과|만)$/;
function keywords(list) {
  const cnt = {};
  list.forEach((e) => (String(e.body).match(/[가-힣]{2,}/g) || []).forEach((w) => {
    const k = w.replace(JOSA, '');
    if (k.length < 2 || STOP.has(w) || STOP.has(k)) return;
    cnt[k] = (cnt[k] || 0) + 1;
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

/* ---------- 수업 화면 ---------- */
function renderClass() {
  const v = [...publicEntries].sort(newest);
  const find = (id) => v.find((e) => e.id === id);
  $('#cStu').textContent = new Set(v.map((e) => e.no)).size;
  $('#kw').innerHTML = '<strong>🔥 자주 등장한 핵심 키워드 Top 5:</strong>' + keywords(v).map((k) => `<span>#${esc(k)}</span>`).join('');
  $('#list').innerHTML = v.length
    ? v.map((e) => `<div class="card"><div class="who">👤 ${esc(e.nick)} <span class="no">${e.no}번</span></div><q>${esc(e.body)}</q></div>`).join('')
    : '<div class="empty">아직 제출된 일기가 없어요. QR 코드로 첫 일기를 받아 보세요.</div>';
  const t = find(picks.teacher);
  $('#tQuote').textContent = t ? `"${t.body}"` : '선생님이 추천 일기를 고르면 여기에 보여요';
  $('#tBy').textContent = t ? '- ' + label(t) : '';
  const { e: a, reason } = currentAi(v);
  $('#aiQuote').textContent = a ? `"${a.body}"` : '';
  $('#aiBy').textContent = a ? '- ' + label(a) : '';
  $('#aiWhy').textContent = a && reason ? `💡 ${reason}` : '';
  $('#trio').innerHTML = picks.best.map((id, i) => {
    const e = find(id); if (!e) return '';
    return `<div class="card"><div class="rank">✨ 추천 ${i + 1} (${e.no}번)</div><div class="nick">"${esc(e.nick)}"</div></div>`;
  }).join('') || '<div class="empty">선생님이 별명 명작을 고르면 여기에 보여요</div>';
}

let classUnsub = null;
function startClass() {
  if (classUnsub) return;
  const q = query(collection(db, 'entries'), where('hidden', '==', false));
  const u1 = onSnapshot(q, (s) => { publicEntries = s.docs.map(toEntry); renderClass(); if (isTeacher) renderTeacher(); },
    (err) => console.error(err));
  const u2 = onSnapshot(doc(db, 'settings', 'picks'), (d) => {
    const x = d.data() || {};
    picks = { teacher: x.teacher ?? null, best: Array.isArray(x.best) ? x.best : [null, null, null] };
    renderClass(); if (isTeacher) renderTeacher();
  });
  const u3 = onSnapshot(doc(db, 'settings', 'ai'), (d) => {
    const x = d.data() || {};
    aiSel = { id: x.id ?? null, reason: x.reason || '' };
    renderClass(); if (isTeacher) renderTeacher();
  });
  classUnsub = () => { u1(); u2(); u3(); };
}

$('#btnRefresh').onclick = async () => {
  try {
    const s = await getDocsFromServer(query(collection(db, 'entries'), where('hidden', '==', false)));
    publicEntries = s.docs.map(toEntry); renderClass(); toast('최신 데이터를 불러왔어요');
  } catch { toast('불러오지 못했어요. 인터넷 연결을 확인해 주세요'); }
};
$('#btnQR').onclick = async () => {
  const url = linkFor('write');
  await QRCode.toCanvas($('#qr'), url, { width: 240, margin: 1 });
  $('#qrUrl').textContent = url;
  $('#qrModal').hidden = false;
};
$('#qrClose').onclick = () => ($('#qrModal').hidden = true);
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

/* 지도: public/map.jpg 가 없으면 직접 그린 지도로 대체 */
$('#mapImg').addEventListener('error', () => { $('#mapImg').remove(); $('#map').hidden = false; drawMap(); });
function drawMap() {
  const c = $('#map'), g = c.getContext('2d'), W = c.width, H = c.height;
  const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, '#e8dcb0'); grd.addColorStop(1, '#cdbd8a');
  g.fillStyle = grd; g.fillRect(0, 0, W, H); g.strokeStyle = 'rgba(90,70,30,.25)'; g.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const land = [[[60,120],[250,90],[330,170],[300,260],[220,300],[120,270],[70,200]],[[360,110],[540,140],[570,260],[500,330],[400,300],[350,210]],
    [[230,360],[360,350],[420,470],[380,620],[300,700],[250,580],[210,450]],[[450,560],[560,580],[570,680],[480,700]]];
  ['#9fbf8a','#c9a96e','#d7b77d','#b6c98f'].forEach((f, i) => { g.beginPath(); land[i].forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = f; g.fill(); g.strokeStyle = 'rgba(70,50,20,.55)'; g.lineWidth = 2; g.stroke(); });
  g.fillStyle = 'rgba(60,40,15,.8)'; g.font = "bold 26px 'Gowun Batang',serif";
  [['유럽',150,190],['아시아',420,220],['아프리카',270,500],['인도양',470,470]].forEach(([t, x, y]) => g.fillText(t, x, y));
}

/* ---------- 학생 제출 ---------- */
$('#diaryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#wSubmit'); btn.disabled = true; $('#wErr').textContent = '';
  try {
    await addDoc(collection(db, 'entries'), {
      no: Math.trunc(Number($('#wNo').value)),
      nick: $('#wNick').value.trim(),
      body: $('#wBody').value.trim(),
      hidden: false,
      createdAt: serverTimestamp(),
    });
    e.target.reset(); e.target.hidden = true; $('#done').hidden = false;
  } catch (err) {
    console.error(err);
    $('#wErr').textContent = '제출하지 못했어요. 번호(1~40), 별명(40자 이내), 일기(300자 이내)를 확인하고 다시 눌러 주세요.';
  } finally { btn.disabled = false; }
});
$('#again').onclick = () => { $('#done').hidden = true; $('#diaryForm').hidden = false; };

/* ---------- 교사 모드 ---------- */
let teacherUnsub = null;
function renderTeacher() {
  const visible = allEntries.filter((e) => !e.hidden);
  $('#sAll').textContent = allEntries.length; $('#sShow').textContent = visible.length;
  $('#sHide').textContent = allEntries.length - visible.length;
  $('#sStu').textContent = new Set(allEntries.map((e) => e.no)).size;

  const opts = '<option value="">선택 안 함</option>' + [...visible].sort(newest)
    .map((e) => `<option value="${e.id}">${esc(label(e))} · ${esc(String(e.body).slice(0, 16))}</option>`).join('');
  [['#pTeacher', picks.teacher], ['#pB1', picks.best[0]], ['#pB2', picks.best[1]], ['#pB3', picks.best[2]]].forEach(([s, val]) => {
    $(s).innerHTML = opts; $(s).value = visible.some((e) => e.id === val) ? val : '';
  });

  const cur = currentAi(visible);
  $('#aiMode').textContent = cur.gemini ? '· Gemini가 고름' : '· 키워드 자동 선정 중';
  $('#aiNow').textContent = cur.e ? `${label(cur.e)} "${cur.e.body}"${cur.reason ? ` — ${cur.reason}` : ''}` : '아직 제출된 일기가 없어요';
  $('#aiReset').hidden = !cur.gemini;

  const q = $('#q').value.trim(), st = $('#fState').value;
  const rows = [...allEntries].sort(newest)
    .filter((e) => (!q || `${e.no} ${e.nick} ${e.body}`.includes(q)) && (!st || (st === 'on') !== e.hidden));
  $('#cnt').textContent = `${rows.length}건`;
  $('#rows').innerHTML = rows.length ? rows.map((e) => `<tr class="${e.hidden ? 'hid' : ''}" data-id="${e.id}">
    <td class="num">${e.no}번</td><td>${esc(e.nick)}</td><td class="body">${esc(e.body)}</td><td class="num">${hm(e.at)}</td>
    <td><span class="state ${e.hidden ? 'off' : 'on'}">${e.hidden ? '숨김' : '표시 중'}</span></td>
    <td class="act"><div class="row">
      <button type="button" class="sm" data-a="toggle">${e.hidden ? '보이기' : '숨기기'}</button>
      <button type="button" class="sm" data-a="edit">수정</button>
      <button type="button" class="sm danger" data-a="del">삭제</button></div></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">해당하는 일기가 없어요.</td></tr>';
}

function enterTeacher(user) {
  isTeacher = true;
  $('#who').textContent = `${user.email} 로 로그인됨`;
  $('#lock').hidden = true; $('#tBody').hidden = false;
  document.querySelectorAll('[data-link]').forEach((c) => (c.textContent = linkFor(c.dataset.link)));
  if (!teacherUnsub) {
    teacherUnsub = onSnapshot(collection(db, 'entries'), (s) => { allEntries = s.docs.map(toEntry); renderTeacher(); },
      (err) => { console.error(err); toast('교사 권한을 확인하지 못했어요. firestore.rules 의 이메일을 확인해 주세요'); });
  }
  renderTeacher();
}
function leaveTeacher() {
  isTeacher = false; teacherUnsub?.(); teacherUnsub = null; allEntries = [];
  $('#lock').hidden = false; $('#tBody').hidden = true;
}

$('#login').onclick = async () => {
  $('#loginMsg').textContent = '';
  try { await signInWithPopup(auth, provider); }
  catch (err) { if (err.code !== 'auth/popup-closed-by-user') $('#loginMsg').textContent = '로그인하지 못했어요. 팝업 차단을 풀고 다시 시도해 주세요.'; }
};
$('#logout').onclick = () => signOut(auth);

const savePicks = (p) => setDoc(doc(db, 'settings', 'picks'), p).then(() => toast('수업 화면 추천을 바꿨어요'))
  .catch(() => toast('저장하지 못했어요'));
$('#pTeacher').onchange = (e) => savePicks({ ...picks, teacher: e.target.value || null });
['#pB1', '#pB2', '#pB3'].forEach((s, i) => ($(s).onchange = (e) => {
  const best = [...picks.best]; best[i] = e.target.value || null; savePicks({ ...picks, best });
}));
$('#q').oninput = renderTeacher; $('#fState').onchange = renderTeacher;

/* Gemini AI 추천: Vercel 서버 함수(/api/ai-pick)를 거쳐 호출. 일기 내용과 ID만 보냄 */
$('#aiRun').onclick = async () => {
  const visible = allEntries.filter((e) => !e.hidden);
  if (!visible.length) return toast('추천할 일기가 없어요');
  const btn = $('#aiRun'); btn.disabled = true; btn.textContent = 'AI가 읽는 중…';
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch('/api/ai-pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subject: cfg.subject, criteria: cfg.aiCriteria, entries: visible.map((e) => ({ id: e.id, body: e.body })) }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `오류 ${r.status}`);
    await setDoc(doc(db, 'settings', 'ai'), { id: out.id, reason: out.reason || '', at: serverTimestamp() });
    toast('AI 추천 일기를 골랐어요');
  } catch (err) {
    console.error(err);
    toast(`AI 추천을 받지 못했어요: ${err.message}`);
  } finally { btn.disabled = false; btn.textContent = 'AI로 다시 고르기'; }
};
$('#aiReset').onclick = () => setDoc(doc(db, 'settings', 'ai'), { id: null, reason: '' })
  .then(() => toast('키워드 자동 선정으로 되돌렸어요')).catch(() => toast('저장하지 못했어요'));

let editing = null;
$('#rows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const tr = b.closest('tr'), id = tr.dataset.id, en = allEntries.find((x) => x.id === id), a = b.dataset.a;
  try {
    if (a === 'toggle') { await updateDoc(doc(db, 'entries', id), { hidden: !en.hidden }); toast(en.hidden ? '수업 화면에 다시 보여요' : '수업 화면에서 숨겼어요'); }
    if (a === 'edit') { editing = id; $('#eNo').value = en.no; $('#eNick').value = en.nick; $('#eBody').value = en.body; $('#editModal').hidden = false; }
    if (a === 'del') tr.querySelector('.act').innerHTML = '<div class="row"><span class="muted">삭제할까요?</span><button type="button" class="sm danger" data-a="delok">삭제</button><button type="button" class="sm" data-a="cancel">취소</button></div>';
    if (a === 'delok') { await deleteDoc(doc(db, 'entries', id)); toast('삭제했어요'); }
    if (a === 'cancel') renderTeacher();
  } catch (err) { console.error(err); toast('처리하지 못했어요. 다시 시도해 주세요'); }
};
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await updateDoc(doc(db, 'entries', editing), { no: Math.trunc(Number($('#eNo').value)), nick: $('#eNick').value.trim(), body: $('#eBody').value.trim() });
    $('#editModal').hidden = true; toast('수정했어요');
  } catch { toast('저장하지 못했어요'); }
});
$('#eCancel').onclick = () => ($('#editModal').hidden = true);

$('#clearAll').onclick = () => {
  $('#clearBox').innerHTML = `<div class="confirm"><span>일기 ${allEntries.length}건을 모두 지우고 새 수업을 시작할까요? 되돌릴 수 없어요.</span><button type="button" class="sm danger" id="clearOk">모두 지우기</button><button type="button" class="sm" id="clearNo">취소</button></div>`;
  $('#clearNo').onclick = () => ($('#clearBox').innerHTML = '');
  $('#clearOk').onclick = async () => {
    $('#clearOk').disabled = true;
    try {
      const s = await getDocs(collection(db, 'entries'));
      for (let i = 0; i < s.docs.length; i += 400) {
        const batch = writeBatch(db);
        s.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await setDoc(doc(db, 'settings', 'picks'), { teacher: null, best: [null, null, null] });
      await setDoc(doc(db, 'settings', 'ai'), { id: null, reason: '' });
      $('#clearBox').innerHTML = ''; toast('새 수업을 시작했어요');
    } catch (err) { console.error(err); toast('지우지 못했어요'); $('#clearOk').disabled = false; }
  };
};
document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
  navigator.clipboard?.writeText(linkFor(b.dataset.copy)).then(() => toast('링크를 복사했어요'), () => toast('복사가 안 돼요. 주소를 직접 선택해 주세요'));
}));

/* ---------- 화면 설정 (settings/config) ---------- */
let cfg = { ...PRESETS.history };
const fillT = (t) => t.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? '').trim();
function applyCfg() {
  document.querySelectorAll('[data-t]').forEach((el) => {
    el.textContent = fillT(el.dataset.t);
    el.hidden = /^["\-\s]*$/.test(el.textContent);
  });
  document.querySelectorAll('[data-ph]').forEach((el) => (el.placeholder = fillT(el.dataset.ph)));
  document.title = cfg.title || '배움 일기';
}
const fillCfgForm = (c) => CFG_KEYS.forEach((k) => ($('#c-' + k).value = c[k] || ''));
let cfgFormDirty = false;
function startConfig() {
  onSnapshot(doc(db, 'settings', 'config'), (d) => {
    cfg = { ...PRESETS.history, ...(d.data() || {}) };
    applyCfg();
    if (!cfgFormDirty) fillCfgForm(cfg);
  });
}
$('#cfgForm').addEventListener('input', () => (cfgFormDirty = true));
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
  fillCfgForm(PRESETS[b.dataset.preset]); cfgFormDirty = true;
  toast('예시를 불러왔어요. 설정 저장을 눌러야 반영돼요');
}));
$('#cfgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {}; CFG_KEYS.forEach((k) => (next[k] = $('#c-' + k).value.trim()));
  try { await setDoc(doc(db, 'settings', 'config'), next); cfgFormDirty = false; toast('설정을 저장했어요. 모든 화면에 반영됐어요'); }
  catch { toast('저장하지 못했어요'); }
});
applyCfg(); fillCfgForm(cfg);

/* ---------- 자료 인쇄 ---------- */
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
function printMeta(n) { const d = new Date(); return `<div class="meta">${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) · ${n}</div>`; }
function buildPrint(kind) {
  const v = allEntries.filter((e) => !e.hidden).sort((a, b) => a.no - b.no || newest(b, a));
  const byId = (id) => v.find((e) => e.id === id);
  const S = esc(cfg.subject);
  if (kind === 'all') return `<h3>학생 ${S} 배움 일기</h3>${printMeta(`${v.length}편 · ${new Set(v.map((e) => e.no)).size}명`)}
    <table><thead><tr><th style="width:48px">번호</th><th style="width:150px">${S} 별명</th><th>배움 일기</th></tr></thead><tbody>
    ${v.map((e) => `<tr><td>${e.no}</td><td>${esc(e.nick)}</td><td>${esc(e.body)}</td></tr>`).join('')}</tbody></table>`;
  if (kind === 'picks') {
    const t = byId(picks.teacher), a = currentAi(v), best = picks.best.map(byId).filter(Boolean);
    return `<h3>오늘의 추천 모음</h3>${printMeta(esc(cfg.title))}
    <h4>🏆 선생님 추천 일기</h4>${t ? `<div class="q">"${esc(t.body)}"</div><div class="src">${esc(label(t))}</div>` : '<div class="src">선택 안 함</div>'}
    <h4>🤖 AI 추천 일기</h4>${a.e ? `<div class="q">"${esc(a.e.body)}"</div><div class="src">${esc(label(a.e))}${a.reason ? ` · 선정 이유: ${esc(a.reason)}` : ''}</div>` : ''}
    <h4>✨ 오늘의 ${S} 별명 명작</h4>${best.length ? `<table><tbody>${best.map((e, i) => `<tr><td style="width:70px">추천 ${i + 1}</td><td><b>"${esc(e.nick)}"</b> (${e.no}번)</td><td>${esc(e.body)}</td></tr>`).join('')}</tbody></table>` : '<div class="src">선택 안 함</div>'}`;
  }
  if (kind === 'board') return `<h3>${esc(cfg.title)}</h3>${printMeta('오늘의 수업 정리')}
    <h4>🔥 자주 등장한 핵심 키워드 Top 5</h4><div class="tags">${keywords(v).map((k) => `<span>#${esc(k)}</span>`).join('')}</div>
    <h4>📖 우리 반 ${S} 별명</h4><table><tbody>${chunk(v, 3).map((r) => `<tr>${r.map((e) => `<td><b>${esc(e.nick)}</b> <span class="src">${e.no}번</span></td>`).join('')}${'<td></td>'.repeat(3 - r.length)}</tr>`).join('')}</tbody></table>
    ${cfg.quote ? `<div class="foot">"${esc(cfg.quote)}"${cfg.quoteBy ? ` - ${esc(cfg.quoteBy)}` : ''}</div>` : ''}`;
  return `<h3>학생별 ${S} 배움 일기 카드</h3>${printMeta('점선을 따라 잘라 나눠 주세요')}
    <div class="cut">${v.map((e) => `<div><span class="src">${e.no}번</span><b>${esc(e.nick)}</b><p style="margin:6px 0 0">${esc(e.body)}</p></div>`).join('')}</div>`;
}
document.querySelectorAll('[data-print]').forEach((b) => (b.onclick = () => {
  $('#sheet').innerHTML = buildPrint(b.dataset.print);
  window.print();
}));

/* ---------- 현재 시각 / 밝게·어둡게 ---------- */
function tick() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  $('#clock').innerHTML = `<small>${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})</small>${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tick(); setInterval(tick, 1000);
function setMode(m) {
  document.documentElement.dataset.mode = m;
  $('#modeBtn').textContent = m === 'light' ? '🌙 어둡게' : '☀️ 밝게';
  try { localStorage.setItem('mode', m); } catch { /* 저장 불가 시 무시 */ }
}
let savedMode = null; try { savedMode = localStorage.getItem('mode'); } catch { /* 무시 */ }
setMode(savedMode === 'light' ? 'light' : 'dark');
$('#modeBtn').onclick = () => setMode(document.documentElement.dataset.mode === 'light' ? 'dark' : 'light');

/* ---------- 화면 전환 ---------- */
function route() {
  const v = ['class', 'write', 'teacher'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'class';
  ['class', 'write', 'teacher'].forEach((x) => ($('#v-' + x).hidden = x !== v));
  if (v === 'class') startClass();
  window.scrollTo(0, 0);
}

if (!configured) {
  $('#setup').hidden = false;
} else {
  window.addEventListener('hashchange', route);
  startConfig();
  route();
  onAuthStateChanged(auth, async (user) => {
    if (user && TEACHER_EMAILS.includes(String(user.email).toLowerCase())) { startClass(); enterTeacher(user); }
    else {
      if (user) { $('#loginMsg').textContent = `${user.email} 은 교사로 등록되지 않은 계정이에요.`; await signOut(auth); }
      leaveTeacher();
    }
  });
}
