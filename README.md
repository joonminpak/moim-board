# 모임 총무 보드

회차별 모임 정산 장부. 참석 여부, 일차별 지출, 최소 송금 정리, 영수증, 변경 이력을 멤버 모두에게 공개한다.

## 구성
| 파일 | 역할 |
|---|---|
| `index.html` | 화면 (모바일 우선, 폴드 화면 대응) |
| `app.js` | 화면 로직 + 정산 계산(Ledger) |
| `store.js` | Supabase 저장소 어댑터 (이름+PIN 로그인, 실시간 반영, 영수증 저장소) |
| `config.js` | Supabase 주소와 공개(anon) 키 |
| `schema.sql` | Supabase 테이블·보안 규칙(RLS)·함수. SQL Editor에서 한 번 실행 |


빌드 단계 없음. Vercel에서 Framework = Other 로 그대로 배포.

## 처음 설정
1. Supabase → SQL Editor 에서 `schema.sql` 실행
2. Supabase → Authentication → Sign In / Providers → **Allow anonymous sign-ins** 켜기
3. `config.js` 에 Project URL, anon public key 입력
4. 사이트 접속 → 가입 → 멤버 탭 → '처음 총무 정하기' 로 총무 PIN 생성

## 권한
- 멤버: 가입(이름+PIN), 참석 여부, 모임·공지 작성, 송금 체크
- 총무(총무 PIN): 지출·영수증, 멤버 관리, 입금 확인, PIN 초기화

배포: Vercel (main 브랜치에 커밋하면 자동 배포)
