// 과목별 화면 문구 예시. 교사 모드 > 화면 설정에서 불러올 수 있어요.
export const PRESETS={
  history:{subject:"세계사",icon:"⚔️",title:"시대를 헤쳐가는 지혜를 배우는 즐거운 역사수업",subtitle:"배움 일기 공유하기",introQuote:"모든 역사는 현대사이다.",introQuoteBy:"베네데토 크로체",introClosing:"과거의 사건을 지금 우리의 눈으로 바라봅시다. 오늘 떠올린 단어 속에 이미 우리 시대의 질문이 담겨 있습니다.",introSubtitle:"연상 단어 공유하기",introHelp:"오늘 배울 주제를 듣고 가장 먼저 떠오르는 단어 2개를 적어 보세요",
    side:"#세계사#세계지도#세계역사여행",nickHelp:"오늘 배운 세계사 인물이나 사건에서 떠오르는 나만의 별명",nickEx:"예: 바스티유 열쇠",
    bodyHelp:"배우고 느낀 점, 지금의 나에게 주는 교훈",quote:"역사는 과거와 현재의 끊임없는 대화이다.",quoteBy:"E.H. 카",
    closing:"시대를 헤쳐가는 성숙한 민주시민으로서 역사를 비판적으로 바라보고 오늘을 성실히 살아가는 노력을 이어갑시다.",
    aiCriteria:"수업 내용을 자기 생각과 연결하고, 역사를 비판적으로 바라보며, 오늘의 삶에 주는 교훈을 담은 일기"},
  science:{subject:"과학",icon:"🔬",title:"질문하고 탐구하는 즐거운 과학수업",subtitle:"배움 일기 공유하기",introQuote:"우리가 경험할 수 있는 가장 아름다운 것은 신비로움이다.",introQuoteBy:"알베르트 아인슈타인",introClosing:"오늘 떠올린 단어에서 궁금한 점을 찾아봅시다. 신기하다고 느끼는 순간 탐구가 시작됩니다.",introSubtitle:"연상 단어 공유하기",introHelp:"오늘 실험·주제를 듣고 가장 먼저 떠오르는 단어 2개를 적어 보세요",
    side:"#실험#관찰#탐구",nickHelp:"오늘 배운 개념이나 현상에서 떠오르는 나만의 별명",nickEx:"예: 질량보존 지킴이",
    bodyHelp:"관찰하고 알게 된 점, 더 궁금해진 점",quote:"중요한 것은 질문을 멈추지 않는 것이다.",quoteBy:"아인슈타인",
    closing:"근거를 바탕으로 생각하고 궁금한 것을 끝까지 탐구하는 과학자의 태도를 길러 갑시다.",
    aiCriteria:"배운 개념을 정확히 이해하고, 근거를 들어 설명하며, 새로운 질문으로 탐구를 이어간 일기"},
  korean:{subject:"국어",icon:"📚",title:"함께 읽고 생각을 나누는 즐거운 국어수업",subtitle:"배움 일기 공유하기",introQuote:"독서는 완성된 사람을, 토론은 준비된 사람을, 쓰기는 정확한 사람을 만든다.",introQuoteBy:"프랜시스 베이컨",introClosing:"친구들이 떠올린 단어에서 작품을 읽는 새로운 눈을 찾아봅시다.",introSubtitle:"연상 단어 공유하기",introHelp:"오늘 읽을 작품 제목을 듣고 떠오르는 단어 2개를 적어 보세요",
    side:"#독서#글쓰기#토론",nickHelp:"오늘 읽은 작품이나 인물에서 떠오르는 나만의 별명",nickEx:"예: 소나기 속 소년",
    bodyHelp:"작품을 읽고 느낀 점, 나의 삶과 연결한 생각",quote:"책은 한 권 한 권이 하나의 세계다.",quoteBy:"윌리엄 워즈워스",
    closing:"좋은 글을 읽고 내 생각을 바르게 표현하는 힘을 함께 키워 갑시다.",
    aiCriteria:"작품을 깊이 있게 읽고, 자신의 경험과 연결하며, 생각을 자기 말로 표현한 일기"},
  blank:{subject:"",icon:"",title:"",subtitle:"",introQuote:"",introQuoteBy:"",introClosing:"",introSubtitle:"",introHelp:"",side:"",nickHelp:"",nickEx:"",bodyHelp:"",quote:"",quoteBy:"",closing:"",aiCriteria:""}
};
export const CFG_KEYS = Object.keys(PRESETS.history);
