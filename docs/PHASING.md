# SQL Bot 구현 Phase 계획

최신 루트 문서인 `ADR.md`/`PRD.md` v4 기준으로, 단건·다건·JOIN 모두 LLM 단일 경로를 유지한다.

## Phase 0 — Directory Structure & Agent Guardrails

**목표**: 구현 전에 사람이 읽기 편한 디렉토리 구조를 고정하고, 향후 작업자가 구조를 임의로 깨지 않도록 원칙을 문서화한다.

- TypeScript 기반 단일 프로젝트 구조를 선언한다.
- 재사용 가능한 단위 모듈은 `src/core/<domain>` 아래에 domain별로 격리한다.
- 외부 시스템 어댑터(Slack, LLM, MySQL, storage)는 core와 분리해 이후 phase에서 `src/adapters/<system>`에 둔다.
- 테스트는 소스 구조를 따라 `tests/unit`, `tests/integration`, `tests/eval`로 분리한다.
- 자세한 원칙은 `docs/PHASE0_DIRECTORY_STRUCTURE.md`를 따른다.

## Phase 1 — MVP Core Safety Foundation

**목표**: Slack/DB 연동 전에 모든 실행 경로가 공유할 결정론적 핵심 게이트를 만든다.

- 카탈로그 config 로더: read-only bot 계정에 열린 테이블/뷰/컬럼만 표현.
- Intent spec 검증: 지표, 기간, 요청자 확인 누락 시 SQL 생성 차단.
- SQL AST safety gate: 단일문, SELECT-only, 카탈로그 테이블/컬럼 한정, denylist, LIMIT cap.
- Golden/eval 테스트가 붙을 수 있는 TypeScript 테스트 골격.

## Phase 2 — Slack Session State & Clarification Flow

**목표**: `/sqlbot` → 모달 → `thread_ts` 세션 → 요청자만 spec 수정/confirm 가능한 상태머신을 구현한다.

- Slack 엔드포인트와 3초 ack/비동기 작업 큐 골격.
- `event_id` dedupe와 `thread_ts`별 실행 mutex.
- spec 렌더링, clarification question, confirmation lock.

## Phase 3 — LLM SQL Generation Adapter

**목표**: LLM이 결과 row에 접근하지 않고 카탈로그+확정 spec으로만 SQL 텍스트를 생성하게 한다.

- provider 인터페이스와 prompt builder.
- 질문/스키마/SQL 외부 전송 고지에 맞춘 diagnostic logging.
- 단건 특수 템플릿 없는 단일 generation path.

## Phase 4 — MySQL Execution Guardrails

**목표**: MySQL 8.0.x에서 EXPLAIN 필터와 런타임 가드로 운영 DB를 보호한다.

- `EXPLAIN FORMAT=JSON` parser fixture 및 view-EXPLAIN PoC 테스트.
- `max_execution_time`, row/file cap, watchdog 전용 커넥션.
- driver cancel 1차, KILL fallback, KILL 전 connection id/status double-check.

## Phase 5 — Result Delivery & Logs

**목표**: CSV 결과는 사내 링크로 전달하고 진단 로그와 PII 접근 감사 로그를 분리한다.

- object storage adapter, TTL 링크, Slack reply.
- local JSON diagnostic log.
- append-only audit backend, 1년 retention, 원문질문 redaction.

## Phase 6 — MVP Launch Gates & Pilot Hardening

**목표**: PRD 부록 Launch Gates를 배포 차단 조건으로 자동화한다.

- allowlist, grant smoke/CI check, masking view checks.
- 50~100개 golden NL eval regression.
- 보존/삭제 job과 ACL trigger 문서화.
