# SQL Bot — 아키텍처 결정 기록 (ADR)

> `sqlbot` 설계 과정의 주요 결정. 각 ADR은 맥락·결정·결과·기각한 대안을 담는다.
> 형식: Nygard ADR. 별도 표기 없으면 **채택됨**(2026-06-03). PRD와 교차 참조.
> **v3 (2026-06-03)** — go/no-go 값 확정: ADR-009(DB grant 경계)·010(전달 기본값)·014(retention 1년) 확정, ADR-006/011 watchdog 상세, **ADR-015(단건조회 템플릿) 추가**.

## 색인
- **ADR-001** LLM을 SQL 생성에 한정하고 실행·데이터 경로 분리
- **ADR-002** 인터페이스로 Slack 채택, `thread_ts` 기반 세션 격리
- **ADR-003** Intent spec + 코드 게이트로 명확화 강제
- **ADR-004** 단일 카탈로그를 메타데이터 소스로, 기간을 테이블 속성으로
- **ADR-005** PII 마스킹을 DB 경계(마스킹 뷰 + 뷰 한정 읽기 롤)에서 강제
- **ADR-006** 실행 안전장치 — 읽기 전용 롤 + 런타임 가드 + watchdog, EXPLAIN은 최적화 필터 *(v3 watchdog)*
- **ADR-007** 실행 전 확인과 실행 후 감사를 별도 기능으로 분리
- **ADR-008** 진단 로그를 요청당 JSON(`./log`)으로, 집계는 비목표
- **ADR-009** 데이터 경계를 단일 read-only 계정의 DB grant로 *(v3 확정)*
- **ADR-010** 결과(CSV) 전달과 보존 — 사내 링크 기본 *(v3 확정)*
- **ADR-011** SQL 검증/재작성 게이트 + watchdog 구현 *(v3 watchdog)*
- **ADR-012** 평가(eval) 하네스
- **ADR-013** 외부 LLM provider 및 데이터 처리
- **ADR-014** PII 접근 감사 로그 — 진단 로그와 분리, retention 1년 *(v3 확정)*
- **ADR-015** 단건조회는 비-LLM 파라미터 템플릿 경로로 *(신규)*

---

## ADR-001: LLM을 SQL 생성에 한정하고 실행·데이터 경로를 분리

**상태**: 채택됨 · 2026-06-03

**맥락**: LLM이 실행/결과 데이터까지 다루면 실데이터가 LLM에 노출되고 제어가 비결정적이 된다.

**결정**: LLM은 **자연어 → SQL 텍스트 생성**까지. 실행은 서버사이드, 결과는 스토리지/링크로 직접 전달, LLM은 반환 데이터 접근 불가.

**결과**: (+) 실데이터(결과 row) 미반출, 게이트·실행 판단이 결정론적 코드. (−) LLM이 결과 후속 보정 못 함(의도된 제약).

**기각**: LLM이 실행·결과 해석까지 → 데이터 노출 + 비결정성으로 기각.

**보강(외부 LLM 한계)**: 본 ADR이 보장하는 건 **결과 row 미반출**뿐. 스키마·질문·생성 SQL은 외부로 나가며 식별자 포함 가능 → 차단하지 않고 계약+고지로 수용(ADR-013). 단건 식별자는 비-LLM 템플릿(ADR-015)이라 미경유.

---

## ADR-002: 인터페이스로 Slack 채택, `thread_ts` 기반 세션 격리

**상태**: 채택됨 · 2026-06-03

**맥락**: 비개발자 접근성 + 한 채널 동시 다중 사용자. 대화가 섞이면 안 됨.

**결정**: Slack 봇. `/sqlbot` 슬래시 → 모달 → 봇이 부모 메시지 게시 → 그 `thread_ts`가 세션 키. 대화는 스레드 답글(Events API). 상태는 서버사이드(`thread_ts` 키잉). 3초 ack → 비동기 워커 + `event_id` 멱등.

**결과**: (+) `thread_ts` 단위 격리, 오프보딩=SSO 비활성화. (−) 3초 ack로 비동기 필수, 회사 IP 게이트 미적용(서명 검증+멤버십 대체).

**기각**: 웹앱 → 인증·프론트 부담 보류. 채널 본문 직접 대화 → 섞여서 기각.

---

## ADR-003: Intent spec + 코드 게이트로 명확화 강제

**상태**: 채택됨 · 2026-06-03

**맥락**: 비개발자는 SQL 검증 불가. 최대 위험은 **그럴듯하게 틀린 데이터**. "반드시 확인" 프롬프트는 확률적으로 샌다.

**결정**: SQL 직전 **intent spec**(지표/그룹핑/기간/필터)을 채우고 게이트를 코드에. LLM은 슬롯 채우기만, 코드가 필수 슬롯 검사(비거나 모호→질문 턴), 완성+확인 후 SQL 잠금 해제. 확인 메시지는 spec 렌더. 입력은 폼+자유 하이브리드.

**결과**: (+) "반드시 확인"이 상태머신으로 강제, 가정 누락 차단. (−) 폼 밖 요구는 추가 재질문, 조건이 "spec 완성"이라 반복 가능.

**기각**: 프롬프트 "항상 확인"(확률적 누락), 자연어→바로 SQL(검출 지점 없음).

---

## ADR-004: 단일 카탈로그를 메타데이터 소스로, 기간을 테이블 속성으로

**상태**: 채택됨 · 2026-06-03

**맥락**: 정의·조인·기간이 흩어지면 일관성 깨짐. 기간을 LLM이 매번 추론하면 같은 질문에 다른 결과.

**결정**: 메타데이터를 **단일 카탈로그**(버전 관리 config)로, LLM·가드레일·검증·spec 폼·단건 템플릿이 공통 소비. 항목: 비즈니스 설명, 컬럼 의미, 조인 경로, 지표 정의, 시간 컬럼+기본/최대 윈도우. 기간은 테이블 속성. **카탈로그엔 그 read-only 계정에 열린 것(선별 컬럼+마스킹 뷰)만**.

**결과**: (+) 기간·정의 결정론적, spec 폼·진단 필드를 동시 규정. (−) 유지보수 부담.

**기각**: 기간 LLM 추론(일관성 결여), 원본 스키마 노출(권한 에러+마스킹 약화).

---

## ADR-005: PII 마스킹을 DB 경계(마스킹 뷰 + 뷰 한정 읽기 롤)에서 강제

**상태**: 채택됨 · 2026-06-03

**맥락**: 생성 SQL 신뢰 불가(별칭/`CONCAT`/파생으로 출력 컬럼명 마스킹 깨짐). 운영 DB는 MySQL Community.

**결정**: **DB 경계**에서 강제. 마스킹 뷰 + 읽기 롤을 뷰에만 grant. Community엔 동적 마스킹 없어 **뷰 정의에 마스킹 식 직접 작성**. grant 테이블 단위(`db.*` 금지), `SHOW GRANTS` CI 체크. **컬럼 grant(보임/안보임) ≠ 마스킹 뷰(부분 가림)** — 안 볼 건 grant 안 함, 가려 줄 건 뷰로(ADR-009).

**결과**: (+) 생성 SQL 무관 마스킹 강제, 외부 LLM 스키마 리스크 완화, 별도 마스킹 프로세스 불필요. (−) 뷰 경직, 준식별자 재식별 안 막힘, 마스킹 식 수동 유지.

**기각**: 출력 컬럼명 매칭(별칭에 깨짐), 앱 레이어 마스킹(우회), Enterprise 동적 마스킹(비용).

---

## ADR-006: 실행 안전장치 — 읽기 전용 롤 + 런타임 가드 + watchdog, EXPLAIN은 최적화 필터

**상태**: 채택됨 · 2026-06-03 *(v3 watchdog 상세)*

**맥락**: plain EXPLAIN cost는 추정값, `EXPLAIN ANALYZE`는 실제 실행이라 사전 게이트로 자기모순. 운영 DB MySQL 8.0.x.

**결정**:
- **읽기 전용 롤**(SELECT만) + 실행 직전 AST 검증(ADR-011).
- **런타임 가드**: `SET SESSION max_execution_time = <ms>` + 검증 통과 후 `/*+ MAX_EXECUTION_TIME(<ms>) */`, `LIMIT <row_cap+1>` 강제, CSV byte cap, 사용자 친화 에러.
- **Watchdog**: 실행 시작 시 `CONNECTION_ID()`를 `request_id`와 저장 → worker timeout 시 **별도 control connection**이 `KILL QUERY`. **driver-level cancel 1차, KILL은 fallback.** KILL 권한 최소화. kill 시 감사 로그에 `killed_by=watchdog`/`timeout_ms`/`connection_id`/`request_id`.
- **EXPLAIN**: `EXPLAIN FORMAT=JSON`. **버전 8.0.x 고정(현 8.0.44)**, fixture 8.0 기준. cost=`query_block.cost_info.query_cost`, rows=`rows_examined_per_scan`/`rows_produced_per_join`. 뷰 EXPLAIN에 `SHOW VIEW` 필요 가능. **8.4 마이그레이션 시 JSON 포맷 변동 가능(`explain_json_format_version`) → parser 재검증 + 포맷 버전 고정**(CI fixture가 탐지). 판단은 결정론적 코드.

**결과**: (+) 추정 틀려도 런타임 차단, DDL/DML 원천 불가, "타임아웃 걸렸는데 DB에선 계속 도는" 상황 방지. (−) `EXPLAIN ANALYZE` 게이트 불가, parser가 MySQL 버전 종속(고정·fixture 필수).

**기각**: EXPLAIN cost 게이트(추정값/자기모순), LLM 부하 판단(비결정성), `statement_timeout`(PostgreSQL — MySQL엔 없음, `max_execution_time` 대체).

---

## ADR-007: 실행 전 확인과 실행 후 감사를 별도 기능으로 분리

**상태**: 채택됨 · 2026-06-03

**맥락**: 확인 질문(실행 전 정확성)과 기록(실행 후)은 문제가 다름. 후자는 데이터가 이미 나온 뒤라 정확성 보장 못 함.

**결정**: 독립 기능. (A) 실행 전 확인 = 정확성(ADR-003). (B) 실행 후 기록 = 감사/진단, 목적은 피드백 루프(개발자가 해석 오류 진단→카탈로그/프롬프트 개선). (B)는 (A)를 대체 안 함.

**결과**: (+) 책임 명확, (B)가 점진 개선 메커니즘. (−) 둘 따로 구현·유지.

**기각**: 사후 SQL+이유로 정확성 보장 → 데이터 이미 전달돼 불가능.

---

## ADR-008: 진단 로그를 요청당 JSON 파일(`./log`)으로, 집계는 비목표

**상태**: 채택됨 · 2026-06-03

**맥락**: 진단(한 건 펼쳐보기)과 집계는 다른 요구. 현 단계엔 진단.

**결정**: **요청당 JSON** `./log/{thread_ts}_{ts}.json`. 내용: 질문/spec/확인 Q&A/SQL/실행 메타. **진단 전용, 집계 비목표**. LLM "이유" 아니라 spec에서 출처 렌더.

**결과**: (+) race 없음, 한 건 진단에 충분, 해석 단계(spec/Q&A) 보존으로 "문법 맞고 해석 틀림" 진단. (−) 집계 번거로움(비목표라 수용), `./log` 재배포/변조 취약.

**기각**: 감사 테이블(현 단계 진단만 필요), Slack 메시지(삭제 가능).

> **주의**: 본 ADR은 **개발 진단**용. PII 접근 **감사**(영속·불변·1년)는 **ADR-014**. local `./log`를 감사로 겸용하지 않음.

---

## ADR-009: 데이터 경계를 단일 read-only 계정의 DB grant로

**상태**: 채택됨 · 2026-06-03 *(v3 확정 — v2의 "catalog ACL 필드/Phase 2 강제"를 DB grant 방식으로 대체)*

**맥락**: 리뷰는 사용자별 권한을 Open Question으로 두는 위험을 지적했다. **MVP는 신뢰 소수 파일럿**이고, 데이터 경계를 앱 레이어 ACL이 아니라 **DB 권한**으로 막는 방식을 채택한다(더 강한 경계).

**결정**:
- **단일 read-only DB 계정**을 쓰고, 그 계정엔 **선별된 원본 컬럼 + 마스킹 뷰만** grant한다. 안 볼 테이블/컬럼은 **grant 자체를 안 준다**.
- **컬럼 grant(보임/안 보임) ≠ 마스킹 뷰(부분 가림)**: 가려서 보여줄 컬럼은 마스킹 뷰로(ADR-005), 아예 안 볼 건 grant 제외.
- **카탈로그도 그 열린 것만** 노출.
- **MVP는 전 사용자가 이 단일 계정 공유** → 균일 권한.
- 세션 행위자 권한(요청자만 spec 수정/confirm)은 **MVP 포함**(ACL과 무관한 접근통제).
- 역할별 차등(CS는 X, 재무는 Y)이 필요해지면 **계정/롤 분리 = Phase 2 앱 ACL**. 앱 ACL이 사라진 게 아니라 **DB grant로 위치가 내려간 것**.
- **개인별 접근 귀속은 앱 레이어**: 계정이 공유라 DB 로그로 개인 식별 불가 → 감사 로그의 `requester`(Slack→SSO)가 귀속 제공(ADR-014).

**MVP 운영 제약**: 사용자 explicit allowlist. 그 계정에 연 컬럼/뷰는 동일 민감도. 재무/결제 상세·고객 식별자 대량 export는 역할 분리 전까지 그 계정에 열지 않음.

**트리거**: 파일럿 채널 확대 / 민감도 상이 그룹 합류 / 재무·결제 데이터셋 추가 시 역할별 ACL을 차단요건으로 승격.

**결과**: (+) 데이터 경계가 앱 코드가 아니라 DB 권한이라 더 강함, 파일럿 단순, 행위자 권한은 즉시 확보. (−) 단일 계정이라 역할 차등 불가(필요 시 Phase 2), 개인 귀속을 앱 레이어에 의존.

**기각**: 앱 레이어 ACL을 MVP에 강제(파일럿엔 과함, DB grant가 더 강한 경계), 사용자별 권한 Open Question 방치(범위 확대 시 위험 → 트리거로 명시).

---

## ADR-010: 결과(CSV) 전달과 보존 — 사내 링크 기본

**상태**: 채택됨 · 2026-06-03 *(v3 기본값 확정)*

**맥락**: `chat.postMessage`는 파일 업로드가 아님. `files.upload` 폐기. CSV는 PII 잔류 위험.

**결정**:
- **MVP 기본값**: 모든 CSV는 **사내 object storage + SSO 재검증 + 짧은 TTL 다운로드 링크**. Slack엔 메타+링크만.
- **예외(Slack external upload)**: `sensitivity=internal` + row/byte cap 이하 + **PII 없음 확인**된 결과만. 흐름: `files.getUploadURLExternal` → POST → `files.completeUploadExternal`.
- retention 정책 + 자동 삭제 job.

**결과**: (+) 초기 보안 판단 단순(기본이 가장 안전한 쪽), PII 통제 명확. (−) object storage·인증 구현 필요.

**기각**: `files.upload`(폐기), `chat.postMessage`로 파일(메시지 API라 불가), Slack 업로드 기본(PII 잔류 위험).

---

## ADR-011: SQL 검증/재작성 게이트 + watchdog 구현

**상태**: 채택됨 · 2026-06-03 *(v3 watchdog)*

**맥락**: "LLM이 SELECT만 짠다"는 약속이지 보장 아님. 실행 직전 결정론적 검증 필요.

**결정**:
- **AST validator**: 단일 statement, `SELECT`/`WITH ... SELECT`만. `INSERT/UPDATE/DELETE/REPLACE/CREATE/DROP/ALTER/TRUNCATE/CALL/DO/LOAD DATA` 차단. `INTO OUTFILE`/`LOAD_FILE`/`SLEEP`/`BENCHMARK` 차단. `information_schema`/`mysql`/`performance_schema`/`sys` 차단. **카탈로그 등록 뷰/컬럼만** `FROM`/`JOIN`. `SELECT *` 금지(또는 컬럼 수 제한). `LIMIT` 강제. join 조건 없는 JOIN/cross join 차단.
- **재작성 순서**: LLM 주석/힌트 제거 → 검증 → **통과 후** 가드 힌트(`MAX_EXECUTION_TIME`)·`LIMIT` 주입.
- **Watchdog**: `CONNECTION_ID()`를 `request_id`와 저장 → worker timeout 시 별도 control connection이 `KILL QUERY`. driver-level cancel 1차, KILL fallback. KILL 권한 최소화, kill 시 감사 기록.
- 권한: 단일 read-only 롤이 EXPLAIN·실행 수행(뷰 EXPLAIN에 `SHOW VIEW` 필요 시 부여). MVP 단순화.

**결과**: (+) LLM 생성과 무관한 결정론적 안전장치, 타임아웃 후 쿼리 잔존 방지. (−) AST 파서 유지(MySQL 방언), 오탐 시 정당 쿼리 차단 가능.

**기각**: LLM 약속에만 의존(보장 아님).

---

## ADR-012: 평가(eval) 하네스

**상태**: 채택됨 · 2026-06-03

**맥락**: 사후 진단 루프(007/008)는 있으나 **배포 전 품질 게이트** 부재. 카탈로그/프롬프트 변경이 회귀를 일으켜도 배포 후 발견.

**결정**: **golden question set**(최소 50~100). 각 항목에 expected spec / SQL 패턴 / 기대 모호성 질문. 예: "지난주 결제 매출", "환불 제외 매출", "가입 후 7일 내 전환율", "특정 고객 단건". 배포 전 회귀 게이트.

**결과**: (+) 변경 회귀를 배포 전 차단. (−) set 구축·유지 비용.

**기각**: 사후 진단만으로 품질 관리(배포 후라 늦음).

---

## ADR-013: 외부 LLM provider 및 데이터 처리

**상태**: 채택됨 · 2026-06-03

**맥락**: SQL 생성에 **외부 LLM** 사용. 실데이터는 미반출하나 **스키마·질문·생성 SQL은 외부로 나감**. 질문/SQL에 사람 이름·사명 포함 가능. 자유형 식별자는 입력 마스킹 불가(이름 NER 비신뢰, 사명 패턴 없음, 정형 PII만 regex로 잡히나 부분 차단은 보장 아님).

**결정**: 외부 LLM 사용, **입력단 PII 마스킹 미추진**. **계약+고지로 수용**:
- **학습 미사용**이 약관/DPA에 문서화된 **티어** 사용(무료/일반 티어 학습 가능성 — **티어 확인 필수**, 구두 아닌 문서).
- 외부 retention 확인, region 고정(가능 시).
- **처리방침에 국외이전 명시**(수탁자/이전국가/항목) — **리스크 수용의 법적 근거. 미고지 시 위반.**
- 사명은 대개 개인정보 아님(법인) → 이미 "스키마 외부 전송" 결정에 포함된 영업비밀 카테고리.
- 단건 식별자는 비-LLM 템플릿(ADR-015)이라 외부 미경유.

**결과**: (+) 기술로 못 막는 잔여를 계약/고지로 닫음(어차피 스키마 전송에 필요한 계약). (−) provider 약관·티어·region 종속, 처리방침 갱신 의무.

**기각**: 입력 PII 마스킹 차단(자유형 이름/사명 불가), 로컬 LLM(데이터주권엔 유리하나 현 결정은 외부 — 추후 재검토).

---

## ADR-014: PII 접근 감사 로그 — 진단 로그와 분리, retention 1년

**상태**: 채택됨 · 2026-06-03 *(v3 값 확정)*

**맥락**: 진단 로그(local JSON)는 dev엔 충분하나 PII 접근 감사로는 부적격(재배포·변조 취약). Slack 메시지도 삭제 가능. DPO 관점 PII 접근기록은 사실상 의무.

**결정**: 진단 로그와 **별도** 영속·불변 감사 로그.
- backend = **append-only DB table**(application update/delete 금지, insert만).
- **server-side 암호화** + 원문 질문 별도 암호화/redaction.
- **retention 1년**(개인정보 접근기록 보존의무 기준 — 사규/고시 확인 후 조정 가능), 삭제 job.
- 필드: `request_id`, `thread_ts`, `requester`, `approver(confirmed_by/at)`, `catalog version`, `spec hash`, `SQL hash`, `row count`, `byte count`, `result object id`, `killed_by`/`timeout_ms`(해당 시), 시각.
- **개인별 귀속은 앱 레이어**: 단일 공유 DB 계정이라 DB 로그로 개인 식별 불가 → `requester`(Slack→SSO)가 귀속 제공.

**결과**: (+) PII 접근 불변 추적, 법적 요건 충족. (−) 별도 저장소·암호화·보존 운영.

**기각**: local `./log` 겸용(변조·휘발), Slack 메시지(삭제 가능).

---

## ADR-015: 단건조회는 비-LLM 파라미터 템플릿 경로로

**상태**: 채택됨 · 2026-06-03 *(신규, MVP 포함)*

**맥락**: CS 등 단건조회(특정 고객/주문)는 식별자가 질문에 들어간다. LLM SQL 생성보다 deterministic 템플릿이 안전하고, 식별자를 외부 LLM에 보내지 않게 된다(입력 PII 우려 구조적 해소).

**결정**: 단건조회를 자유 SQL 생성 경로와 **분리**.
- 흐름: 자연어 → intent slot(조회 유형 + 식별자) → **사전 검증된 prepared template**(`SELECT <masked cols> FROM v_x WHERE id = ?`) 실행.
- **LLM은 SQL 생성 안 함**(슬롯 추출/폼까지만). **자유 SQL 금지.**
- 템플릿은 개발자가 등록(카탈로그처럼), 마스킹 뷰에 대해 실행. 런타임 가드·감사 동일 적용.

**결과**: (+) deterministic·안전, 식별자 외부 LLM 미경유, injection 표면 없음, 빠름. (−) 템플릿을 개발자가 미리 만들어야 함(임의 단건 조회 제한).

**기각**: 단건조회도 LLM 자유 SQL(식별자 외부 전송 + 비결정성 + injection 표면), CS를 MVP 제외(주 사용자라 가치 훼손 — 템플릿이 더 나은 방향).
