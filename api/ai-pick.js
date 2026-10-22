// Vercel 서버 함수: Gemini로 "AI 추천 일기"를 고릅니다.
// API 키는 여기(서버)에서만 쓰이고 학생 화면에는 절대 보내지 않습니다.
// 필요한 Vercel 환경 변수: GEMINI_API_KEY (Google AI Studio 키)
// 선택: GEMINI_MODEL (기본값 gemini-3.5-flash-lite)

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// 교사 확인: 비밀번호로 들어온 기기만 Firestore의 sessions/{내 uid} 문서를 읽을 수 있음
// (보안 규칙이 본인만 읽게 막아 두었으므로, 읽기에 성공하면 교사로 인정)
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 가능해요' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY가 설정되지 않았어요' });

  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!(await isTeacher(token))) return res.status(401).json({ error: '교사 관리 모드에 다시 들어와 주세요' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  // 번호·별명은 받지 않고 일기 내용만 받습니다 (학생 개인정보 최소화)
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .filter((e) => e && typeof e.id === 'string' && typeof e.body === 'string')
    .slice(0, 80)
    .map((e) => ({ id: e.id, body: e.body.slice(0, 300) }));
  if (entries.length === 0) return res.status(400).json({ error: '추천할 일기가 없어요' });

  const subject = String(body.subject || '').slice(0, 12).trim() || '수업';
  const criteria = String(body.criteria || '').slice(0, 300).trim()
    || '수업 내용을 자기 생각과 연결하고, 깊이 있게 성찰하며, 오늘의 삶에 주는 교훈을 담은 일기';
  const prompt = [
    `너는 학교 ${subject} 교사를 돕는 조수야. 아래는 오늘 ${subject} 수업을 마치며 학생들이 쓴 "배움 일기"야.`,
    `다음 기준에 가장 잘 맞는 일기 1편을 골라: ${criteria}`,
    '성의 없는 글, 장난, 의미 없는 기호, 다른 사람을 비하하는 글은 고르지 마.',
    '반드시 JSON 하나로만 답해: {"id": "고른 일기의 id", "reason": "고른 이유를 학생들이 읽기 좋게 한국어 한 문장(60자 이내)"}',
    '',
    JSON.stringify(entries),
  ].join('\n');

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!r.ok) {
      console.error('Gemini error', r.status, await r.text());
      return res.status(502).json({ error: `Gemini 호출 실패 (${r.status})` });
    }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const out = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    if (!entries.some((e) => e.id === out.id)) return res.status(502).json({ error: 'AI가 목록에 없는 일기를 골랐어요. 다시 눌러 주세요' });
    return res.status(200).json({ id: out.id, reason: String(out.reason || '').slice(0, 120), model: MODEL });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'AI 응답을 읽지 못했어요. 다시 눌러 주세요' });
  }
}
