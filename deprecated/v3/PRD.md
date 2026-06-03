# SQL Bot PRD — 사내 데이터 셀프서비스 봇

> 가칭 `sqlbot`. 비개발자가 Slack에서 자연어로 사내 데이터를 조회해 CSV로 받는 도구.
> **v3 (2026-06-03)** — MVP go/no-go 값 확정: MySQL **8.0.x(현 8.0.44) 고정**, 결과 전달 **기본값=사내 링크**, 감사 **retention 1년**, watchdog `KILL` 구현 상세, **CS 단건조회 비-LLM 템플릿 경로 MVP 편입**, 데이터 경계를 **단일 read-only 계정의 컬럼 grant + 마스킹 뷰**로 확정(앱 ACL은 Phase 2), **MVP Launch Gates** 부록 추가.
> v2 — MySQL 가드/EXPLAIN 교정, Slack 파일 전달 재설계, SQL 검증 게이트, 스레드 행위자 권한, 외부 LLM 데이터 처리, 진단/감사 로그 분리.

---

## 1. 배경 / 문제

- 비개발자(운영·기획·CS)가 데이터가 필요할 때마다 데이터팀/개발팀에 ad-hoc 요청을 넣어 병목이 생김.
- 기존 시도는 외부 LLM에 스키마를 통째로 박은 SQL 생성 챗봇. 문제: (a) 외부 LLM에 사내 데이터 모델 상주 = 거버넌스 리스크, (b) 실행·권한·마스킹·감사 레이어 부재.
- 목표: **자연어 → SQL → 실행 → CSV** 흐름을 권한·가드레일·마스킹·감사 위에서 안전하게 셀프서비스화.
- 운영 DB는 **MySQL 8.0.x (현 8.0.44, Community Edition)**.

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
- **다중 역할별 앱 레이어 ACL은 MVP 비목표.** MVP의 데이터 경계는 **단일 read-only 계정의 DB grant**로 강제하고(§7, ADR-009), 역할별 차등은 Phase 2.

---

## 3. 대상 사용자

| 페르소나 | 특성 | 주 시나리오 | MVP 경로 |
|---|---|---|---|
| 운영 매니저 | SQL 미숙, 정기 지표 | 일/주간 집계 | LLM 집계 경로 |
| 기획자·PM | 기본 SQL, 복잡 JOIN 어려움 | 가설 검증 추출 | LLM 집계 경로 |
| CS 담당자 | 단건 조회 빈도 높음 | 고객/주문 단건 | **비-LLM 템플릿 경로**(§5.11) |
| 데이터팀 | 검토/승인 | 세션 승인(Phase 2) | — |

> **MVP는 신뢰 소수 파일럿**(explicit allowlist). 데이터 경계는 단일 계정 grant로 강제. 채널 확대·민감도 상이 그룹 합류 시 역할별 ACL을 차단요건으로 승격(ADR-009).

---

## 4. 핵심 흐름

**4단계 로직 (집계 경로)**
1. 카탈로그(테이블·컬럼·관계)를 LLM이 읽고 SQL 작성.
2. SQL → `EXPLAIN FORMAT=JSON`으로 비용 추정(1차 필터).
3. 적정하면 검증 → 실행 → CSV 추출.
4. 결과를 사내 저장소에 두고 채널/스레드에 다운로드 링크 게시. **LLM은 반환 데이터에 접근 불가.**

**단건조회 경로**(§5.11): LLM SQL 생성 없이 prepared template로 실행(식별자가 외부 LLM 미경유).

**Slack 인터랙션**: `/sqlbot` → 모달 → 봇이 부모 메시지 게시 → 그 스레드가 세션 → 슬롯 채우기/확인 → 검증 → 실행 → 결과 회신.

---

## 5. 기능 요구사항

### 5.1 Slack 인터페이스 & 동시성
- 진입: `/sqlbot` 슬래시 → `views.open` 모달(~3초 내 응답).
- 모달 submit → 봇이 채널에 부모 메시지 게시 → 그 `ts` = `thread_ts` = **세션 키**.
- 이후 슬롯 채우기/확인은 스레드 답글(Events API). 봇은 자기 스레드 답글을 `@멘션` 없이 청취.
- 동시성: `thread_ts` 단위 격리. 한 유저 다중 스레드 = 다중 세션.
- 상태 스토어(Redis 등) `thread_ts` 키잉: 히스토리 / spec / 단계 / 요청자 `user_id` / `confirmed_by`.
- **3초 ack 의무** → LLM/SQL/CSV는 비동기 워커, 결과는 파일/링크로 회신. `event_id` dedupe.
- **세션 행위자 권한**: spec 수정·confirm·실행은 **요청자만**. 승인자는 별도 Slack usergroup/SSO role. 타인 답글은 실행 경로에 영향 없음(안내 또는 무시). 모든 confirm에 `confirmed_by`/`confirmed_at` 기록. — UX가 아니라 접근통제.

### 5.2 카탈로그 (메타데이터)
- 정의: **"뭐가 가능한가."** 개발자가 한 번 정의, 버전 관리 config. → 규칙집.
- 항목: 비즈니스 설명, 컬럼 의미, 조인 경로, 지표 정의(예: 매출 = 결제일 기준), **시간 컬럼 + 기본/최대 윈도우**.
- **카탈로그엔 그 read-only 계정에 열린 것만 노출**: 선별된 원본 컬럼 + 마스킹 뷰. 원본 전체/안 연 테이블은 제외(노출 시 LLM이 그걸로 SQL → 권한 에러 → 혼란).
- ACL 필드(allowed_roles 등) 자리는 정의하되 **MVP 강제 안 함**(데이터 경계는 DB grant가 담당, ADR-009).
- LLM·가드레일·SQL 검증·spec 폼·단건 템플릿이 공통 소비.

### 5.3 Intent Spec & 명확화 하네스
- intent spec = **"이번에 뭘 원하나"**(지표/그룹핑/기간/필터). 요청마다 생성.
- 흐름: `카탈로그 → spec 폼 렌더 → 사용자가 채움 → 채워진 spec → SQL`.
- 입력: 폼(공통 슬롯) + 자유 입력(복잡 필터) 하이브리드.
- **게이트는 코드에**: ① LLM은 슬롯 채우기만 → ② 코드가 필수 슬롯 검사(비거나 모호 → 무조건 질문 턴, SQL 경로 도달 불가) → ③ 완성 + 확인 후 SQL 잠금 해제.
- 질문 vs 통보: 답할 수 있는 모호성(매출=주문일/결제일) → 질문(비즈니스 용어). 답할 수 없는 결정(조인 경로) → 시스템이 정하고 통보.
- 확인 메시지는 **채워진 spec에서 렌더**(가정 누락 차단). 비개발자의 유일한 검증면. 게이트 조건 = "spec 완성됐나".

### 5.4 기간 산정
- 기간은 **카탈로그의 테이블 속성**(LLM 매번 추론 X). 미지정→기본+통보, override, 최대 초과→캡. 캡 넘는 풀히스토리는 별도 처리(§11). **세션 승격과 무관**(한도=리소스).

### 5.5 SQL 생성 (집계 경로)
- LLM은 카탈로그(열린 컬럼 + 마스킹 뷰 스키마 + 관계) 기반 **SELECT만**. 바인딩 파라미터 권장.
- LLM은 제어 경로 밖. **"SELECT만 짠다"는 약속이지 보장이 아님** → 실행 직전 AST 검증(§5.7)이 별개 안전장치.

### 5.6 부하 게이트 (EXPLAIN + 런타임 가드) — MySQL 8.0.x
- **EXPLAIN은 최적화 1차 필터지 보안이 아님**: plain cost는 추정값(통계/상관조건에 틀어짐), `EXPLAIN ANALYZE`는 실제 실행이라 사전 게이트로 자기모순.
- **MySQL 명세**: 문법 `EXPLAIN FORMAT=JSON`. **지원 버전 = MySQL 8.0.x 고정(현 8.0.44)**, parser fixture는 8.0 기준. cost=`query_block.cost_info.query_cost`, rows=`rows_examined_per_scan`/`rows_produced_per_join`. 뷰 EXPLAIN엔 `SHOW VIEW` 권한 필요 가능. **8.4 마이그레이션 시 EXPLAIN JSON 포맷 변동 가능(`explain_json_format_version`) → parser 재검증 + 포맷 버전 고정**(CI fixture 테스트가 업그레이드 시 깨짐으로 탐지).
- **런타임 가드(진짜 안전장치)**:
  - `SET SESSION max_execution_time = <ms>` + 검증 통과 후 `/*+ MAX_EXECUTION_TIME(<ms>) */` 주입.
  - `LIMIT <row_cap + 1>` 강제(초과 시 cap 안내), CSV byte cap, watchdog `KILL QUERY`(§5.7).
  - 타임아웃/캡 초과 시 사용자 친화 에러.
- 게이트 판단은 **결정론적 코드**, LLM 아님.

### 5.7 실행 & 가드레일 + SQL 검증 + Watchdog (ADR-011)
- 실행 계정은 **단일 read-only 롤**(SELECT만, DDL/DML 없음). 마스킹 뷰 + 선별 컬럼만 grant(§7).
- **실행 직전 SQL AST validator**:
  - 단일 statement, `SELECT`/`WITH ... SELECT`만.
  - `INSERT/UPDATE/DELETE/REPLACE/CREATE/DROP/ALTER/TRUNCATE/CALL/DO/LOAD DATA` 차단.
  - `INTO OUTFILE`/`LOAD_FILE`/`SLEEP`/`BENCHMARK` 차단. `information_schema`/`mysql`/`performance_schema`/`sys` 차단.
  - **카탈로그 등록 뷰/컬럼만** `FROM`/`JOIN`. `SELECT *` 금지(또는 컬럼 수 제한). `LIMIT` 강제. join 조건 없는 JOIN/cross join 차단.
  - **재작성 순서**: LLM 주석/힌트 제거 → 검증 → **통과 후** 가드 힌트·`LIMIT` 주입.
- **Watchdog 구현**:
  - 실행 시작 시 `CONNECTION_ID()`를 `request_id`와 함께 저장.
  - worker timeout 시 **별도 control connection**이 해당 connection_id에 `KILL QUERY`.
  - **driver-level cancel을 1차**, `KILL QUERY`는 fallback.
  - `KILL` 권한은 최소화. kill 시 감사 로그에 `killed_by=watchdog`, `timeout_ms`, `connection_id`, `request_id` 기록.
  - (안 하면 "타임아웃은 걸렸는데 쿼리는 DB에서 계속 도는" 상황 발생)
- 읽기 전용 트랜잭션 + 위 타임아웃.

### 5.8 결과(CSV) 전달 (ADR-010) — 기본값 확정
- `chat.postMessage`는 메시지 API지 파일 업로드가 아님. 기존 `files.upload`는 폐기(정확한 sunset 날짜는 현행 Slack 문서 확인).
- **MVP 기본값**: 모든 CSV 결과는 **사내 object storage + SSO 재검증 + 짧은 TTL 다운로드 링크**. Slack엔 결과 메타 + 링크만 게시.
- **예외(Slack external upload 허용)**: `sensitivity=internal` + row/byte cap 이하 + **PII 없음 확인된** 결과만. 흐름: `files.getUploadURLExternal` → CSV bytes POST → `files.completeUploadExternal`.
- CSV retention 정책 + 자동 삭제 job. LLM은 반환 데이터 접근 불가.

### 5.9 PII 마스킹 (MySQL Community)
- **DB 경계 마스킹** = 마스킹된 뷰 + 읽기 롤을 뷰에만 grant. 생성 SQL이 뭐든(별칭/`CONCAT`/파생) 못 뚫음.
- MySQL Community엔 동적 마스킹 없음(Enterprise 기능) → **뷰 정의에 마스킹 식 직접 작성**.
- **컬럼 grant vs 마스킹 뷰 역할 분담**(§7): 안 볼 것 = grant 안 함, 가려서 볼 것 = 마스킹 뷰. (컬럼 grant는 보임/안 보임만, 부분 가림은 뷰로.)
- 우회 차단: `GRANT SELECT ON db.*` 금지, 테이블 단위 grant, `SHOW GRANTS` CI 체크. view definer 권한 최소화.
- 준식별자 조합 재식별은 컬럼별 마스킹으로 안 막힘 → 필요 시 구간화.
- 외부 LLM에 주는 스키마가 마스킹 뷰 스키마 → 실데이터 이전 리스크 **완화**(컬럼명/도메인명 민감도 검토는 필요. "해소" 아님).

### 5.10 진단 로그 / 감사 로그 (분리) — retention 확정
- **진단 로그**(ADR-008): 요청당 local JSON `./log/{thread_ts}_{ts}.json`. dev/staging 편의, **진단 전용, 집계 비목표**. 내용: 원문 질문 / spec / 확인 Q&A / SQL / 실행 메타. LLM "이유" 아니라 spec에서 출처 렌더. — 재배포/변조에 취약해 감사로는 부적격.
- **감사 로그**(ADR-014): PII 접근 기록은 **별도 영속·불변**. backend = **append-only DB table**(update/delete 앱 금지, insert만), server-side 암호화 + 원문 질문 별도 암호화/redaction, **retention 1년**, 삭제 job. 필드: `request_id`, `thread_ts`, `requester`, `approver(confirmed_by/at)`, `catalog version`, `spec hash`, `SQL hash`, `row count`, `byte count`, `result object id`, `killed_by`/`timeout_ms`(해당 시), 시각.
- **개인별 접근 귀속은 앱 레이어에서**: DB 계정이 단일 공유라 DB 로그로는 개인 식별 불가 → 감사 로그의 `requester`(Slack user_id → SSO)가 귀속을 제공. 이게 DPO 접근기록 요건의 실제 근거.
- Slack 메시지는 삭제 가능 → 어느 감사에도 부적격.

### 5.11 단건조회 경로 (비-LLM 템플릿) — MVP (ADR-015)
- CS 등 **특정 고객/주문 단건조회**는 자유 SQL 생성 경로와 **분리**.
- 흐름: 자연어 → intent slot(조회 유형 + 식별자) → **사전 검증된 prepared template**(`SELECT <masked cols> FROM v_x WHERE id = ?`) 실행.
- **LLM은 SQL을 생성하지 않음**(슬롯 추출 또는 폼까지만). **자유 SQL 금지.**
- 템플릿은 개발자가 등록(카탈로그처럼), 마스킹 뷰에 대해 실행. 런타임 가드·감사 동일 적용.
- 효과: deterministic·안전, **식별자가 외부 LLM 미경유**(입력 PII 우려를 이 클래스에서 구조적으로 해소), injection 표면 없음.

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
   │      ├─ (집계 경로) ─▶ [LLM 추론(외부)] ← 카탈로그(열린 컬럼 + 마스킹 뷰 스키마)
   │      │                     · spec 슬롯 채우기 → SQL(SELECT)
   │      │                  ▶ [SQL AST 검증] allowlist · 단일문 · 뷰/컬럼 한정 · 주석/힌트 제거→가드 주입
   │      │                  ▶ [부하 게이트] EXPLAIN FORMAT=JSON → query_cost/rows 임계(코드)
   │      ├─ (단건 경로) ──▶ [intent slot → prepared template]  · LLM SQL 생성 없음 · 식별자 외부 미경유
   │      │
   │      ├─▶ [SQL 실행]  단일 read-only 롤(선별 컬럼 + 마스킹 뷰) · max_execution_time · row/byte cap
   │      │      └─ [Watchdog]  CONNECTION_ID 저장 → driver cancel(1차) / KILL QUERY(fallback)
   │      │      ▼
   │      │   [MySQL 8.0.x]  컬럼 grant + 마스킹 뷰만 (원본 전체 미부여)
   │      ├─▶ [CSV 추출]
   │      └─▶ [결과 전달]  사내 object storage + SSO 재검증 + TTL 링크 (기본) / Slack upload(예외)
   │
   ├─▶ [진단 로그]   ./log/{thread_ts}_{ts}.json  (요청당, dev)
   └─▶ [감사 로그]   append-only DB · 암호화 · retention 1년  (requester·approver·hash·row/byte·result id)
```

핵심 원칙: 실데이터·결과 row는 사내 경계 안에서만 이동. **스키마·질문·SQL은 외부 LLM으로 나감**(집계 경로 한정. 단건 식별자는 미경유). 

---

## 7. 인증 & 접근 제어

- **권한 주체**: Slack `user_id` → 회사 SSO/계정 매핑. 오프보딩 = Slack/SSO 비활성화.
- **이벤트 진위**: Slack 서명 시크릿. (회사 IP 화이트리스트는 웹앱 전제라 미적용.)
- **세션 행위자 권한**: 요청자만 spec 수정/confirm/실행(§5.1).
- **데이터 경계 = 단일 read-only 계정의 DB grant** (ADR-009):
  - 그 계정엔 **선별된 원본 컬럼 + 마스킹 뷰만** grant. 안 볼 테이블/컬럼은 grant 자체를 안 줌.
  - 카탈로그도 그 열린 것만 노출.
  - **MVP는 전 사용자가 이 단일 계정 공유** → 균일 권한(신뢰 소수 파일럿엔 적정).
  - 역할별 차등(CS는 X, 재무는 Y)이 필요해지면 계정/롤 분리 = Phase 2 앱 ACL. **앱 ACL이 사라진 게 아니라 DB grant로 위치가 내려간 것.**
  - DB 권한 = 데이터 경계, 앱 ACL = 다중 역할 정책(Phase 2).

---

## 8. 보안 & 개인정보 (DPO 관점)

- **외부 LLM 데이터 처리**(ADR-013): 실데이터(결과 row) 미반출. **단 스키마·질문·생성 SQL은 외부로 나감**(집계 경로). 질문/SQL에 사람 이름·사명 포함 가능.
  - 자유형 식별자(이름·사명)는 입력에서 **기술 마스킹 불가** → 입력단 차단 미추진. 대신 **계약+고지로 수용**: 학습 미사용 문서화 티어(무료/일반 티어 학습 가능성 — **티어 확인 필수**), retention·region 확인, **처리방침에 국외이전 명시**(수탁자/이전국가/항목 — 미고지 시 위반).
  - 단건 식별자는 비-LLM 템플릿(§5.11)이라 외부 미경유.
- **PII 접근 감사**: append-only 영속 로그, **retention 1년**(개인정보 접근기록 보존의무 기준 — 사규/고시 확인 후 조정 가능)(ADR-014).
- **개인별 귀속**: 단일 DB 계정이라 앱 레이어 감사 로그가 귀속 제공(§5.10).
- **보존기간**: CSV·진단/감사 로그 정책 + 자동삭제.
- **재식별 한계**: 준식별자 조합 재식별 인지, 필요 시 구간화.
- **처리방침 반영**(대표=CPO, 담당=호크): 외부 LLM 수탁/국외이전 명시.

---

## 9. 단계별 (Phasing)

**MVP (신뢰 소수 파일럿)** — §부록 Launch Gates 충족 시 배포
- `/sqlbot` → 모달 → 슬롯 채우기(행위자=요청자) → 확인 → AST 검증 → EXPLAIN 필터 + 런타임 가드(`max_execution_time`/cap/watchdog) → 실행 → 결과(사내 링크 기본).
- 단일 read-only 계정(선별 컬럼 + 마스킹 뷰). 단일 DB(MySQL 8.0.x).
- **집계 경로(LLM) + 단건조회 경로(비-LLM 템플릿)** 둘 다.
- 진단 로그(local) + 감사 로그(영속, 1년). 외부 LLM(학습 미사용 + 처리방침 고지). 배포 전 eval 게이트(golden set, ADR-012).

**Phase 2**
- 역할별 앱 ACL(계정/롤 분리), 세션 승격(draft→verified→official), 파라미터화 재실행, 로그 집계, 다중 DB. (MySQL 8.4 마이그레이션 시 EXPLAIN parser 재검증.)

**Phase 3**
- 스케줄 실행/정기 배포, 도메인 용어 사전 누적.

---

## 10. 핵심 설계 원칙 (의도적으로 분리해야 하는 것들)

- **EXPLAIN ≠ 보안.** EXPLAIN은 최적화 필터, 보안은 런타임 가드.
- **게이트 = 코드.** "반드시 확인해" 프롬프트는 확률적으로 샌다.
- **LLM "SELECT만 생성" 약속 ≠ AST 검증.** 별개 안전장치.
- **데이터 경계 = DB grant(단일 계정), 다중 역할 ACL = 앱 레이어(Phase 2).** 둘은 위치가 다름.
- **카탈로그(뭐가 가능, 1회 정의) ≠ intent spec(이번 요청, 매번).**
- **실행 전 확인(정확성) ≠ 실행 후 기록(감사).**
- **진단 로그(local, OK) ≠ PII 접근 감사 로그(영속·불변, 1년).**
- **집계 경로(LLM SQL) ≠ 단건 경로(prepared template, LLM 미경유).**
- **마스킹은 DB 경계(뷰 + grant)**, 출력 컬럼명 매칭이 아니다. 컬럼 grant(보임/안보임) ≠ 마스킹 뷰(부분 가림).
- **자유형 PII(이름·사명)는 입력에서 기술 마스킹 불가** → 차단 대신 계약+고지로 수용.
- **개인별 접근 귀속은 앱 레이어**(DB 계정 단일이므로).

---

## 11. 미해결 (Open Questions)

- 캡 넘는 풀히스토리 처리: 거절 + 데이터팀 직접 요청 vs 승인된 무거운 실행 경로.
- 준식별자 **구간화 적용 범위**.
- MySQL **업데이트 종류**(8.0 패치 vs 8.4 메이저) — 메이저면 EXPLAIN parser 재검증 필요.
- 단건조회 템플릿 **목록**(어떤 조회를 prepared template로 제공할지).

---

## 부록. MVP Launch Gates

MVP는 아래를 모두 만족해야 배포할 수 있다.

1. **Pilot Scope** — 사용자는 explicit allowlist로 제한. 단일 read-only 계정에 연 컬럼/뷰는 동일 민감도 범위로. 재무/결제 상세·고객 식별자 대량 export는 역할별 ACL 강제 전까지 그 계정에 열지 않음.
2. **Result Delivery** — 기본 = 사내 object storage + SSO 재검증 + TTL 링크. Slack external upload는 `sensitivity=internal` + cap 이하 + PII 없음에만. retention·삭제 job 배포 전 설정.
3. **MySQL Compatibility** — 버전 **8.0.x 고정(현 8.0.44)**, EXPLAIN FORMAT=JSON parser fixture를 8.0 기준 작성. (8.4 마이그레이션은 Phase 2 재검증.)
4. **Audit** — backend(append-only DB), **retention 1년**, 암호화(+원문질문 redaction/암호화), 삭제 job 확정. local `./log`는 진단용, 감사 저장소로 사용 안 함.
5. **SQL Safety** — AST allowlist · 단일문 · SELECT-only · function/schema denylist · 카탈로그 뷰/컬럼 한정 · LIMIT 강제. watchdog(driver cancel + KILL fallback) 동작.
6. **Masking & Grant** — bot 계정에 원본 전체 grant 없음(선별 컬럼 + 마스킹 뷰만). `SHOW GRANTS` CI 체크. view definer 최소 권한.
7. **Single-record path** — CS 단건조회는 비-LLM prepared template(자유 SQL 금지).
8. **Eval** — 50~100개 golden NL 질문에 대해 spec/SQL/재질문 회귀 테스트 통과.
9. **ACL Trigger** — 파일럿 채널 확대 / 민감도 상이 그룹 합류 / CS·finance 데이터셋 추가 시 역할별 ACL 강제를 배포 차단요건으로 승격.
