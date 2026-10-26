// Vercel 서버 함수: 칠판 판서를 Gemini로 정리합니다. (교사 관리 모드로 들어온 기기만)
//  mode 'tree' : 가지치기(마인드맵) 구조도
//  mode 'web'  : 그물망(개념 연결) 구조도
//  mode 'note' : 학생이 노트에 옮겨 적기 좋은 판서로 다듬기
// 필요한 Vercel 환경 변수: GEMINI_API_KEY  (선택: GEMINI_MODEL)

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

async function isTeacher(idToken) {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'history-myungjoo';
  if (!idToken || !projectId) return false;
  let uid = '';
  try { uid = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).user_id || ''; } catch { return false; }
  if (!uid) return false;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/sessions/${encodeURIComponent(uid)}`,
    { headers: { Authorization: `Bearer ${idToken}` } });
  return r.ok;
}

const S = (v, n) => String(v || '').slice(0, n).trim();

function promptFor(mode, b) {
  const head = [
    '너는 고등학교 교사의 판서를 돕는 조수야. 아래는 오늘 수업 칠판 판서야.',
    b.unit && `대단원: ${b.unit}`, b.sub && `소단원: ${b.sub}`, b.topic && `학습 주제: ${b.topic}`, b.std && `성취기준: ${b.std}`,
    '판서 표기: "# 소제목", "- 글머리표", "! 중요", "**강조**", "->" 화살표',
    '---', b.body, '---',
    '판서에 없는 사실을 지어내지 말고, 판서의 낱말을 최대한 살려.',
  ].filter(Boolean);
  if (mode === 'note') {
    return [...head,
      '이 판서를 학생이 공책에 그대로 옮겨 적기 좋은 "노트 필기용 판서"로 다듬어 줘.',
      '- 번호가 붙은 소제목(# 1. …)으로 큰 흐름을 나누고, 그 아래 - 글머리표로 핵심어 위주로 짧게(한 줄 25자 안팎) 써.',
      '- 원인·결과·순서는 → 로 잇고, 연도·인물·사건 같은 꼭 외울 것은 **굵게**, 시험에 나올 핵심 한두 줄은 ! 로 시작해.',
      '- 군더더기 문장은 줄이고, 소제목 사이에는 빈 줄을 하나 둬. 전체 25줄 이내.',
      b.cols === 2 ? '- 칠판이 왼쪽·오른쪽 두 칸이라, 내용을 앞뒤 흐름에 맞게 두 덩어리로 나눠 body(왼쪽)와 body2(오른쪽)에 담아.' : '- 한 칸 칠판이라 body에만 담고 body2는 빈 문자열로.',
      '반드시 JSON 하나로만 답해: {"body": "왼쪽(또는 전체) 판서", "body2": "오른쪽 판서 또는 빈 문자열"}'].join('\n');
  }
  const kind = mode === 'web'
    ? '그물망(개념 연결도): 가운데 주제에서 큰 개념 3~6개로 나누고, 각 큰 개념 아래 작은 개념 1~4개. 그리고 서로 다른 가지의 개념 사이 원인·결과·영향 같은 관계를 links에 3~6개 넣어(관계 이름은 4~8자).'
    : '가지치기(마인드맵): 가운데 주제에서 큰 가지 3~6개, 각 큰 가지 아래 작은 가지 1~4개. links는 빈 배열.';
  return [...head,
    `이 판서를 ${kind}`,
    '각 칸(label)은 12자 안팎의 짧은 핵심어로. 전체 칸은 30개 이내.',
    'root는 가운데에 들어갈 주제(학습 주제를 짧게).',
    '반드시 JSON 하나로만 답해: {"root": "주제", "nodes": [{"id": "n1", "label": "큰 개념", "parent": "root"}, {"id": "n2", "label": "작은 개념", "parent": "n1"}], "links": [{"from": "n2", "to": "n5", "label": "관계"}]}'].join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 가능해요' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY가 설정되지 않았어요' });
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!(await isTeacher(token))) return res.status(401).json({ error: '교사 관리 모드에 다시 들어와 주세요' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const mode = ['tree', 'web', 'note'].includes(body.mode) ? body.mode : 'tree';
  const b = { unit: S(body.unit, 80), sub: S(body.sub, 80), topic: S(body.topic, 120), std: S(body.std, 300), body: S(body.body, 6000), cols: body.cols === 2 ? 2 : 1 };
  if (!b.body && !b.topic) return res.status(400).json({ error: '칠판에 강의 내용이 없어요' });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: promptFor(mode, b) }] }], generationConfig: { responseMimeType: 'application/json' } }),
    });
    if (!r.ok) { console.error('Gemini error', r.status, await r.text()); return res.status(502).json({ error: `Gemini 호출 실패 (${r.status})` }); }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const out = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    if (mode === 'note') return res.status(200).json({ body: S(out.body, 3000), body2: b.cols === 2 ? S(out.body2, 3000) : '' });
    const nodes = (Array.isArray(out.nodes) ? out.nodes : []).slice(0, 36)
      .map((n) => ({ id: S(n.id, 20), label: S(n.label, 40), parent: S(n.parent, 20) || 'root' })).filter((n) => n.id && n.label);
    const ids = new Set(nodes.map((n) => n.id));
    nodes.forEach((n) => { if (n.parent !== 'root' && !ids.has(n.parent)) n.parent = 'root'; });
    const links = mode === 'web' ? (Array.isArray(out.links) ? out.links : []).slice(0, 8)
      .map((l) => ({ from: S(l.from, 20), to: S(l.to, 20), label: S(l.label, 20) })).filter((l) => ids.has(l.from) && ids.has(l.to)) : [];
    if (!nodes.length) return res.status(502).json({ error: 'AI가 구조를 만들지 못했어요. 다시 눌러 주세요' });
    return res.status(200).json({ root: S(out.root, 40) || b.topic.slice(0, 40) || '오늘의 수업', nodes, links });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'AI 응답을 읽지 못했어요. 다시 눌러 주세요' });
  }
}
