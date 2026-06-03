# SQL Bot PRD — 사내 데이터 셀프서비스 봇

> 가칭 `sqlbot`. 비개발자가 Slack에서 자연어로 사내 데이터를 조회해 CSV로 받는 도구.
> **v2 (2026-06-03)** — 설계 리뷰 반영: MySQL 런타임 가드/EXPLAIN 명칭·필드 수정, Slack 파일 전달 재설계, SQL 검증 게이트 구체화, 스레드 행위자 권한 추가, 외부 LLM 데이터 처리 명시, 진단 로그와 감사 로그 분리. **MVP는 신뢰 소수 파일럿 전제.**

---

## 1. 배경 / 문제

- 비개발자(운영·기획·CS)가 데이터가 필요할 때마다 데이터팀/개발팀에 ad-hoc 요청을 넣어 병목이 생김.
- 기존 시도는 외부 LLM에 스키마를 통째로 박은 SQL 생성 챗봇이었음. 문제: (a) 외부 LLM에 사내 데이터 모델 상주 = 거버넌스 리스크, (b) 실행·권한·마스킹·감사 레이어 부재.
- 목표: **자연어 → SQL → 실행 → CSV** 흐름을 권한·가드레일·마스킹·감사 위에서 안전하게 셀프서비스화.
- 운영 DB는 **MySQL(Community Edition)**.

---

## 2. 목표 / 비목표

**목표**
- 비개발자가 SQL을 몰라도 데이터를 직접 조회.
- "그럴듯하게 틀린 데이터"를 받는 사고 방지 — 실행 전 비즈니스 용어로 의도 확인.
- 개인정보 보호: DB 경계 마스킹 + 접근 권한 분리 + 감사 기록.
- 운영 DB 보호: 무거운 쿼리를 런타임에서 차단.

**비목표**
- 개발자가 임의 SQL을 자유롭게 쓰는 도구가 아님(그건 직접 DB 접근).
- BI 대시보드/시각화가 아님(CSV 추출까지).
- 실시간 스트리밍/대용량 ETL이 아님.
- **사용자별 세분 데이터 권한은 MVP 비목표**(신뢰 소수 파일럿 전제. ADR-009).

---

## 3. 대상 사용자

| 페르소나 | 특성 | 주 시나리오 |
|---|---|---|
| 운영 매니저 | SQL 미숙, 정기 지표 확인 | 일/주간 조회 |
| 기획자·PM | 기본 SQL 가능, 복잡 JOIN 어려움 | 가설 검증용 추출 |
| CS 담당자 | 단건 조회 빈도 높음 | 고객 문의 대응 |
| 데이터팀 | 검토/승인 권한 | 세션 검증·승인(Phase 2) |

> **MVP는 신뢰 소수 파일럿**(균일 권한). 채널 확대·민감도 상이 그룹 합류 시 ACL이 차단요건으로 승격(ADR-009).

---

## 4. 핵심 흐름

**4단계 로직**
1. 카탈로그(테이블·컬럼·관계)를 LLM이 읽고 SQL 작성.
2. SQL → `EXPLAIN FORMAT=JSON`으로 비용 추정(1차 필터)으로 부하 측정.
3. 적정하면 실행 + CSV 추출.
4. 결과를 지정 채널/스레드에 전달. **LLM은 반환된 데이터에 접근 불가.**

**Slack 인터랙션**
- `/sqlbot` → 모달 → submit → 봇이 채널에 부모 메시지 게시 → 그 메시지 스레드가 세션.
- 스레드 안에서 intent spec 슬롯 채우기(질문/확인) → 확정 → 검증 → 실행 → 결과 회신.

---

## 5. 기능 요구사항

### 5.1 Slack 인터페이스 & 동시성
- 진입점: `/sqlbot` 슬래시 → `views.open` 모달(트리거 토큰으로 ~3초 내 응답).
- 모달 submit → 봇이 채널에 부모 메시지 게시 → 그 `ts` = `thread_ts` = **세션 키**.
- 이후 모든 슬롯 채우기/확인은 **스레드 답글(Events API)**. 봇은 자기 스레드 답글을 `@멘션` 없이 청취.
- 동시성 격리: `thread_ts` 단위. 한 유저 다중 스레드 = 다중 세션.
- 상태 스토어(Redis 등)를 `thread_ts`로 키잉: 히스토리 / 채우는 중 spec / 단계 / 요청자 `user_id` / `confirmed_by`.
- **3초 ack 의무**: Events API/슬래시 모두 3초 내 응답 → LLM/SQL/CSV는 비동기 워커로 분리, 결과는 파일 업로드 또는 링크로 스레드 회신.
- **멱등성**: `event_id`로 dedupe(Slack 타임아웃 재전송 대비).
- **세션 행위자 권한** (신규, ADR-009): spec 수정·실행 confirm은 **요청자만** 가능. 승인자는 별도 Slack usergroup/SSO role. 그 외 사용자 답글은 실행 경로에 영향 없음("요청자만 이 세션을 조작할 수 있습니다" 안내 또는 무시). 모든 confirm에 `confirmed_by`/`confirmed_at` 기록.
  - 이것은 UX가 아니라 **데이터 접근통제** 문제. 같은 채널의 타인이 spec을 바꾸거나 confirm을 눌러 실행시키는 시나리오를 차단.

### 5.2 카탈로그 (메타데이터)
- 정의: **"뭐가 가능한가."** 개발자가 한 번 정의, 모든 요청에 공통, 버전 관리 config. → 규칙집.
- 테이블/뷰별 항목: 비즈니스 설명, 컬럼 의미, 조인 경로, 지표 정의(예: 매출 = 결제일 기준), **시간 컬럼 + 기본 윈도우 + 최대 윈도우**.
- ACL 필드(allowed_roles, audit_level, require_reason 등) 자리 정의 — **MVP는 필드만, 강제 안 함**(ADR-009).
- **카탈로그엔 마스킹된 뷰만 노출, 원본 테이블 제외**. 원본 노출 시 LLM이 원본으로 SQL 작성 → 권한 에러 → 사용자 혼란. 권한(DB 경계)=안전장치, 카탈로그(LLM 입력)=안내. 둘 다 필요.
- LLM·가드레일·SQL 검증·spec 폼이 공통 소비.

### 5.3 Intent Spec & 명확화 하네스
- intent spec = **"이번에 뭘 원하나"**(지표/그룹핑/기간/필터). 요청마다 생성.
- 흐름: `카탈로그 → spec 폼 렌더 → 사용자가 채움 → 채워진 spec → SQL`.
- 입력: 폼(공통 슬롯) + 자유 입력(복잡 필터) 하이브리드.
- **게이트는 코드에(LLM 프롬프트 아님)**: ① LLM은 슬롯 채우기만 → ② 코드가 필수 슬롯 검사, 비었거나 모호하면 무조건 질문 턴(SQL 경로 도달 불가) → ③ spec 완성 + 사용자 확인 후 SQL 생성 잠금 해제.
- 질문 vs 통보: 답할 수 있는 모호성(매출=주문일/결제일) → 질문(비즈니스 용어). 답할 수 없는 결정(조인 경로) → 시스템이 정하고 통보.
- 확인 메시지는 **채워진 spec에서 렌더**(LLM 자유서술 아님 — 가정 누락 차단). 비개발자의 유일한 검증면.
- 게이트 조건 = "spec 완성됐나"(not "한 번 물었나").

### 5.4 기간 산정
- 기간은 **카탈로그의 테이블 속성**(LLM 매번 추론 X → 일관성). LLM은 추론이 아니라 조회.
- 미지정 → 기본 윈도우 + 통보 / 사용자 override. 최대 윈도우 초과 → 캡 + 통보.
- 캡 넘는 풀히스토리가 진짜 필요하면 → 별도 처리(§11). **세션 승격과 무관**(한도=리소스, 승격=신뢰).

### 5.5 SQL 생성
- LLM은 카탈로그(마스킹 뷰 스키마 + 관계) 기반으로 **SELECT만** 작성. 재사용 대비 바인딩 파라미터 권장.
- LLM은 제어 경로 밖. 게이트 통과·실행 판단은 코드.
- **"LLM이 SELECT만 짠다"는 약속이지 보장이 아님** → 실행 직전 AST 검증(§5.7, ADR-011)이 별개 안전장치로 강제.

### 5.6 부하 게이트 (EXPLAIN + 런타임 가드) — MySQL
- **EXPLAIN은 최적화 1차 필터지 보안이 아님.**
  - plain EXPLAIN cost는 옵티마이저 **추정값** — 통계가 오래됐거나 상관 조건이면 크게 틀어짐.
  - `EXPLAIN ANALYZE`는 실제로 쿼리를 실행 → 사전 게이트로 쓰면 자기모순.
  - 용도: "싼 건 빨리 통과"시키는 1차 필터.
- **MySQL 명세** (v1의 PostgreSQL 용어 오기 수정):
  - 문법은 `EXPLAIN FORMAT=JSON`(`=` 포함).
  - **지원 버전 고정**: MySQL 8.0.x 또는 8.4 LTS 중 택1. EXPLAIN JSON 스키마는 버전마다 다르므로 버전 명시 + **파서 fixture 테스트** 필수.
  - cost 필드: `query_block.cost_info.query_cost`.
  - rows 필드: `rows_examined_per_scan` / `rows_produced_per_join`(버전별 파서 구현).
  - 뷰 EXPLAIN엔 `SHOW VIEW` 권한이 필요할 수 있음 → planner 권한 명시(ADR-011).
- **진짜 안전장치 = 실행 단계 런타임 가드**(추정이 틀려 통과해도 죽임):
  - `SET SESSION max_execution_time = <ms>`(read-only SELECT에 적용) + 검증 통과 후 `/*+ MAX_EXECUTION_TIME(<ms>) */` 힌트 주입.
  - `LIMIT <row_cap + 1>` 강제, 초과 시 사용자에게 cap 안내.
  - CSV writer에서 byte cap 초과 시 중단.
  - 워커 watchdog: 일정 시간 초과 시 `KILL QUERY`.
  - 타임아웃/캡 초과 시 사용자 친화 에러(예: "쿼리가 30초 제한을 초과해 중단되었습니다. 기간/그룹핑을 줄이거나 데이터팀에 승인 요청하세요").
- 게이트 판단은 **결정론적 코드**(EXPLAIN JSON 파싱 → cost/rows 임계 비교). LLM 아님.

### 5.7 실행 & 가드레일 + SQL 검증 (ADR-011)
- 읽기 전용 DB 롤: SELECT만, DDL/DML 권한 없음.
- **실행 직전 SQL AST validator**:
  - 단일 statement만, `SELECT`/`WITH ... SELECT`만 허용.
  - `INSERT/UPDATE/DELETE/REPLACE/CREATE/DROP/ALTER/TRUNCATE/CALL/DO/LOAD DATA` 차단.
  - `INTO OUTFILE` / `LOAD_FILE` / `SLEEP` / `BENCHMARK` 차단.
  - `information_schema` / `mysql` / `performance_schema` / `sys` 접근 차단.
  - **카탈로그 등록 뷰만** `FROM`/`JOIN` 허용.
  - `SELECT *` 금지(또는 컬럼 수 제한), `LIMIT` 강제 삽입.
  - join 조건 없는 JOIN / cross join 차단. `ORDER BY` 없는 대용량 결과 경고.
  - **재작성 순서**: LLM 주석/힌트 전부 제거 → 검증 → **통과 후** 가드 힌트(`MAX_EXECUTION_TIME`)·`LIMIT` 주입.
- 읽기 전용 트랜잭션 + 위 타임아웃. 롤은 마스킹 뷰에만 grant(§5.9).

### 5.8 결과(CSV) 전달 (ADR-010)
- `chat.postMessage`는 메시지 API지 파일 업로드 플로우가 아님. 기존 `files.upload`는 폐기됨(정확한 sunset 날짜는 현행 Slack 문서 확인).
- **소형 결과**: Slack external upload — `files.getUploadURLExternal` → upload URL에 CSV bytes POST → `files.completeUploadExternal`로 채널/스레드 공유.
- **대형/민감 결과**: 사내 object storage + **짧은 TTL presigned URL**, 다운로드 시 **SSO 재검증**. Slack엔 파일 대신 결과 메타 + 다운로드 링크 게시.
- "Slack 파일 잔류" vs "사내 저장소+링크"는 보안 수준이 다름 → MVP에서 **하나를 명시 선택**. CSV는 PII 잔류 위험이 있으므로 **후자 권장**.
- CSV retention 정책 + 자동 삭제 job 필수.
- LLM은 반환 데이터에 접근 불가(실데이터 경로 분리).

### 5.9 PII 마스킹 (MySQL)
- 원칙: **DB 경계 마스킹** = 마스킹된 뷰 + 읽기 롤을 **뷰에만** grant, 원본 테이블 미부여. 생성 SQL이 뭐든(별칭/`CONCAT`/파생) 못 뚫음.
- **MySQL Community엔 동적 마스킹 없음**(Enterprise 기능) → **뷰 정의에 마스킹 식 직접 작성**(예: `name → CONCAT(LEFT(name,1),'**')`).
- 우회 차단: `GRANT SELECT ON db.*` **금지**, 테이블 단위 grant(`GRANT SELECT ON db.v_users`), `SHOW GRANTS`로 원본 미포함 확인(CI 체크 권장). view definer 권한 최소화.
- 카탈로그에 원본 테이블 제외(§5.2)로 보강.
- 준식별자 조합 재식별은 컬럼별 마스킹으로 안 막힘 → 필요 시 뷰에서 구간화(나이→연령대).
- 부수 효과: 외부 LLM에 주는 스키마가 마스킹 뷰 스키마 → 실데이터 이전 리스크를 **크게 완화**. 단 컬럼명/도메인명 자체가 민감할 수 있어 검토 필요(**"해소"가 아니라 "완화"**).

### 5.10 진단 로그 / 감사 로그 (분리)
- **두 기능은 다른 물건이며 분리한다.**
- **진단 로그**(ADR-008): 요청당 local JSON `./log/{thread_ts}_{ts}.json`. 개발 편의용, **진단 전용, 집계 비목표**. 내용: 원문 질문 / 채워진 spec / 확인 Q&A / 생성 SQL / 실행 메타(기간·행 수·시각·요청자). LLM "이유"가 아니라 spec에서 출처 렌더.
  - local `./log`는 재배포/변조에 취약 → PII 접근 감사로는 부적격.
- **감사 로그**(신규, ADR-014): PII 접근 기록은 **별도로** 영속·불변 저장. append-only DB table 또는 object storage, server-side 암호화, retention + 삭제 job. 필드: `request_id`, `thread_ts`, `requester`, `approver(confirmed_by/at)`, `catalog version`, `spec hash`, `SQL hash`, `row count`, `byte count`, `result object id`, 시각. 원문 질문은 PII 가능성 → 별도 암호화 필드 또는 redaction.
- Slack 메시지는 삭제 가능 → 어느 쪽 감사 기록으로도 부적격.

---

## 6. 아키텍처

```
[Slack 사용자]
   │  /sqlbot (슬래시 → 모달)
   ▼
[Slack 앱 백엔드]  ── 3s ack · event_id dedupe · 서명 검증 · 행위자 권한(요청자만 confirm)
   │  스레드 답글(Events API)
   ├─▶ [상태 스토어 (Redis)]  thread_ts 키: 히스토리 / spec / 단계 / requester / confirmed_by
   │
   ├─▶ [비동기 워커]
   │      ├─▶ [LLM 추론 (외부)]  ← 카탈로그(마스킹 뷰 스키마 + 관계)
   │      │      · intent spec 슬롯 채우기 → SQL(SELECT)
   │      ├─▶ [Intent Spec 엔진]  코드 게이트(슬롯 검사/확인)
   │      ├─▶ [SQL AST 검증]  allowlist · 단일문 · 뷰 한정 · LIMIT 강제 · 주석/힌트 제거→가드 주입
   │      ├─▶ [부하 게이트]  EXPLAIN FORMAT=JSON 파싱 → query_cost/rows 임계 (코드)
   │      ├─▶ [SQL 실행]  읽기 롤(뷰 전용) · max_execution_time · row/byte cap · watchdog
   │      │      ▼
   │      │   [MySQL 8.0/8.4]  마스킹 뷰만 grant (원본 미부여)
   │      ├─▶ [CSV 추출]
   │      └─▶ [결과 전달]  Slack external upload(files.*) 또는 사내 object storage + TTL presigned URL
   │
   ├─▶ [진단 로그]   ./log/{thread_ts}_{ts}.json  (요청당, dev 편의)
   └─▶ [감사 로그]   append-only/암호화/retention  (requester·approver·hash·row/byte·result id)
```

핵심 원칙: 실데이터·결과 row는 사내 경계 안에서만 이동. **단, 스키마·질문·SQL은 외부 LLM으로 나감**(§8).

---

## 7. 인증 & 접근 제어

- **권한 주체**: Slack `user_id` → 회사 SSO/계정 매핑. 오프보딩 = Slack/SSO 비활성화.
- **이벤트 진위**: Slack 서명 시크릿 검증. (회사 고정 IP 화이트리스트는 웹앱 전제라 미적용 — 서명 검증 + 워크스페이스 멤버십으로 대체.)
- **운영 범위**: 봇은 지정 채널에서만 동작.
- **세션 행위자 권한**: 요청자만 spec 수정/confirm/실행. 승인자는 별도 role(§5.1).
- **데이터 권한**: 읽기 롤은 마스킹 뷰에만. **MVP는 전 사용자 균일**(신뢰 소수 파일럿). 사용자별 catalog ACL은 ADR-009(필드만, Phase 2 강제). 파일럿 범위 이탈 시 ACL 도입 트리거. DB 권한=최후 경계, 앱 ACL=제품 정책.

---

## 8. 보안 & 개인정보 (DPO 관점)

- **외부 LLM 데이터 처리**(ADR-013): 실데이터(결과 row)는 미반출. **단 스키마·사용자 질문·생성 SQL은 외부로 나감** — 질문/SQL에 사람 이름·사명 등 식별자가 포함될 수 있음.
  - 자유형 식별자(사람 이름·사명)는 입력에서 **기술 마스킹 불가**(이름 NER 비신뢰, 사명 패턴 없음) → 입력단 차단은 추진하지 않음.
  - 대신 **계약 + 고지로 수용**: 학습 미사용이 약관/DPA에 문서화된 **티어 사용**(무료/일반 티어는 학습 사용 가능성 — 티어 확인 필수), retention·region 확인, **개인정보 처리방침에 국외이전 명시**(수탁자명/이전국가/항목). 이 고지가 리스크 수용의 법적 근거 — 미고지 시 위반.
  - 참고: 사명은 대개 개인정보가 아님(법인) → 이미 "스키마 외부 전송" 결정에 포함된 영업비밀 카테고리.
- **PII 접근 감사**: 영속·불변 감사 로그(ADR-014).
- **보존기간**: CSV·진단/감사 로그 모두 보존기간 정책 + 자동삭제.
- **재식별 한계**: 마스킹해도 준식별자 조합으로 재식별 가능 — 인지 전제, 필요 시 구간화.
- **처리방침 반영**(대표=CPO, 담당=호크): 외부 LLM 수탁/국외이전 명시.

---

## 9. 단계별 (Phasing)

**MVP (신뢰 소수 파일럿)**
- `/sqlbot` → 모달 → 스레드 슬롯 채우기(행위자=요청자) → 확인 → **AST 검증** → EXPLAIN 1차 필터 + 런타임 가드(`max_execution_time`/row·byte cap/watchdog) → 실행 → 결과 전달(업로드 또는 링크 중 택1).
- 마스킹 뷰 + 읽기 전용 롤. 단일 DB. 진단 로그(local) + **감사 로그(영속)**. 외부 LLM(학습 미사용 + 처리방침 고지). **배포 전 eval 게이트(golden set, ADR-012)**.

**Phase 2**
- 사용자별 ACL **강제**, 세션 승격(draft→verified→official), 파라미터화 재실행, **단건조회 비-LLM 템플릿 경로**, 로그 집계, 다중 DB.

**Phase 3**
- 스케줄 실행/정기 배포(슬랙·이메일), 도메인 용어 사전 누적.

---

## 10. 핵심 설계 원칙 (의도적으로 분리해야 하는 것들)

- **EXPLAIN ≠ 보안.** EXPLAIN은 최적화 필터, 보안은 런타임 가드.
- **게이트 = 코드.** "반드시 확인해" 프롬프트는 확률적으로 샌다.
- **LLM "SELECT만 생성" 약속 ≠ AST 검증.** 둘은 별개 안전장치.
- **접속 인증 ≠ 데이터 권한.** 스레드 행위자 권한은 접근통제다.
- **카탈로그(뭐가 가능, 1회 정의) ≠ intent spec(이번 요청, 매번).**
- **실행 전 확인(정확성) ≠ 실행 후 기록(감사).**
- **진단 로그(local, OK) ≠ PII 접근 감사 로그(영속·불변).**
- **한도 초과(리소스) ≠ 세션 승격(신뢰).**
- **마스킹은 DB 경계(뷰 + grant)**, 출력 컬럼명 매칭이 아니다.
- **자유형 PII(이름·사명)는 입력에서 기술 마스킹 불가** → 차단 시도 대신 계약+고지로 수용.
- **LLM은 텍스트(SQL)까지만**, 실데이터(결과 row) 경로 밖. 단 스키마·질문·SQL은 외부로 나감.

---

## 11. 미해결 (Open Questions)

- 캡 넘는 풀히스토리 처리: 거절 + 데이터팀 직접 요청 vs 승인된 무거운 실행 경로.
- 로그/CSV/감사 **보존기간 구체 수치**(예: 90일).
- 준식별자 **구간화 적용 범위**.
- EXPLAIN JSON 파서: **최종 지원 MySQL 버전 확정**(8.0 vs 8.4 LTS).
- 단건조회 비-LLM 템플릿 경로 도입 시점(Phase 2 후보).
- 결과 전달 최종 선택(Slack 잔류 vs 사내 링크) 및 object storage 선정.
