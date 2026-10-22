# 시대를 헤쳐가는 지혜를 배우는 즐거운 역사수업

구글 설문지·시트·Apps Script로 만든 역사 배움 일기 대시보드를 **Firebase + GitHub + Vercel** 로 옮긴 버전입니다.
AI 추천 일기는 **Gemini**가 학생 일기를 읽고 1편을 고른 뒤, 고른 이유를 한 문장으로 수업 화면에 보여 줍니다.
교사 모드의 "AI로 다시 고르기" 버튼을 누를 때만 호출되고, Gemini 키가 없거나 호출이 실패하면 키워드 방식으로 자동 선정됩니다.

## 링크 3개

| 링크 | 누가 | 하는 일 |
|---|---|---|
| `https://(주소)/#class` | 교사·학생 함께 | 수업 화면(원본 대시보드). 학생 수, 키워드 Top 5, 일기 목록, 추천 일기, 별명 명작, QR 코드 |
| `https://(주소)/#write` | 학생 | 일기 제출 (번호, 역사 별명, 배움 일기). QR 코드가 이 주소로 연결 |
| `https://(주소)/#teacher` | 교사 | 구글 로그인 후 일기 숨기기·수정·삭제, 추천 고르기, 새 수업 시작 |

---

## 1. Firebase 준비 (10분)

1. https://console.firebase.google.com 에서 **프로젝트 추가** (Google 애널리틱스는 꺼도 됩니다)
2. 왼쪽 **빌드 > Firestore Database > 데이터베이스 만들기** → 위치 `asia-northeast3 (서울)` → **프로덕션 모드**
3. Firestore **규칙** 탭 → 이 폴더의 `firestore.rules` 내용을 붙여넣고 `teacher@goedu.kr` 을 **선생님 구글 이메일**로 바꾼 뒤 **게시**
4. **빌드 > Authentication > 시작하기 > 로그인 방법 > Google** 사용 설정
5. **프로젝트 설정(톱니바퀴) > 일반 > 내 앱 > 웹(</>)** 으로 앱 등록 → 나오는 `firebaseConfig` 값 6개를 메모

## 2. GitHub에 올리기

1. https://github.com/new 에서 새 저장소 만들기 (예: `history-class`, Private 가능)
2. 저장소 화면의 **uploading an existing file** 을 눌러 이 폴더의 파일을 모두 끌어다 놓고 **Commit**
   (`node_modules`, `.env` 는 올리지 않습니다)

## 3. Vercel 배포

1. https://vercel.com 에 GitHub 계정으로 로그인 → **Add New > Project** → 방금 저장소 **Import**
2. Framework는 **Vite** 로 자동 선택됩니다
3. **Environment Variables** 에 `.env.example` 의 항목을 하나씩 추가 (Firebase 값 6개 + `VITE_TEACHER_EMAILS` + `GEMINI_API_KEY`)
   - `GEMINI_API_KEY` 는 https://aistudio.google.com/apikey 에서 **Create API key** 로 받습니다
   - 이름 앞에 `VITE_` 를 붙이지 마세요. 키는 Vercel 서버 함수(`api/ai-pick.js`)에서만 쓰이고 학생 화면에는 보내지지 않습니다
   - 환경 변수를 나중에 추가했다면 **Deployments > Redeploy** 를 한 번 눌러야 적용됩니다
4. **Deploy** → 주소가 나오면 완료 (예: `https://history-class.vercel.app`)
5. Firebase 콘솔 **Authentication > 설정 > 승인된 도메인** 에 Vercel 주소(`history-class.vercel.app`)를 추가 → 교사 로그인이 됩니다

이후 GitHub에 파일을 고쳐 올리면 Vercel이 자동으로 다시 배포합니다.

## 다른 과목에서 쓰기

교사 모드 > **⚙️ 화면 설정**에서 과목명, 앱 제목, 부제, 그림 칸 제목, 학생 안내 문구, 명언, 마무리 문장, AI 추천 기준을 바꿀 수 있어요.
역사·과학·국어 예시를 불러와 고쳐 쓸 수도 있습니다. 과목마다 Firebase 프로젝트를 따로 만들고 같은 코드로 배포하면 서로 섞이지 않아요.

## 그 밖의 기능

- 오른쪽 위 **현재 시각**, **☀️ 밝게 / 🌙 어둡게** 전환 (기기마다 기억)
- 교사 모드 > **🖨️ 자료 인쇄**: 학생 일기 전체(표), 오늘의 추천 모음, 수업 정리 한 장, 학생별 카드. A4 흰 종이로 인쇄되고, 인쇄 창에서 **PDF로 저장**도 됩니다

## 선택: 원본 사진 그대로 쓰기

`public/map.jpg`(세계지도 사진), `public/emblem.jpg`(머리글 오른쪽 조각상 사진)를 넣으면 원본처럼 사진이 보입니다.
없으면 지도는 직접 그린 그림으로 대신 표시됩니다.

## 내 컴퓨터에서 실행해 보기 (선택)

```bash
cp .env.example .env     # 값 채우기
npm install
npm run dev
```

## 데이터 구조

- `entries/{자동ID}`: `no`(번호), `nick`(역사 별명), `body`(일기), `hidden`(숨김 여부), `createdAt`
- `settings/picks`: `teacher`(선생님 추천 일기 ID), `best`(별명 명작 추천 ID 3개)
- `settings/ai`: `id`(Gemini가 고른 일기 ID), `reason`(고른 이유)
- `settings/config`: 화면 설정 문구 (과목명, 제목, 명언, AI 추천 기준 등)

## AI 추천과 학생 정보

- Gemini에는 **일기 내용과 문서 ID만** 보내고, 번호와 별명은 보내지 않습니다
- 교사 로그인을 확인한 뒤에만 호출되므로 학생이나 외부인이 키를 쓸 수 없습니다
- 무료 키는 입력 내용이 Google 서비스 개선에 쓰일 수 있어요. 학교 정책상 걱정되면 AI Studio에서 결제를 연결한 유료 등급 키를 쓰면 학습에 사용되지 않습니다

## 기존 구글 시트 기록 옮기기 (필요할 때)

시트를 CSV로 내려받아 주시면 Firestore로 한 번에 넣는 스크립트를 만들어 드릴 수 있어요.
