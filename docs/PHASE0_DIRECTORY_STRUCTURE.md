# Phase 0 — Directory Structure & Agent Guardrails

이 문서는 `sql-agent`의 기본 디렉토리 구조와 변경 원칙을 정의한다. 목적은 사람이 빠르게 읽을 수 있고, 이후 다른 에이전트가 작업하더라도 구조를 임의로 부수지 않게 하는 것이다.

## 1. 기준 원칙

1. **TypeScript 우선**: 실행 코드와 테스트는 TypeScript로 작성한다.
2. **Core는 재사용 가능해야 한다**: `src/core` 아래 모듈은 Slack, LLM provider, MySQL driver 같은 외부 시스템에 직접 의존하지 않는다.
3. **Adapter는 바깥 세계를 감싼다**: Slack, LLM, DB, storage, logger 같은 I/O 연동은 `src/adapters/<system>`에 둔다.
4. **Application은 흐름만 조립한다**: 상태머신, command handler, worker orchestration은 `src/application`에 둔다. domain 규칙을 새로 만들지 않고 core와 adapter를 조합한다.
5. **Config는 선언형으로 둔다**: 카탈로그, 정책 기본값, fixture 성격의 설정은 `config` 또는 `tests/fixtures`에 둔다.
6. **테스트는 목적별로 분리한다**: 순수 모듈은 `tests/unit`, 외부 연동은 `tests/integration`, golden question 회귀는 `tests/eval`에 둔다.
7. **문서는 phase와 운영 결정을 분리한다**: phase 계획은 `docs/PHASING.md`, 구조 원칙은 이 문서, 루트 `ADR.md`/`PRD.md`는 제품·아키텍처 기준 문서로 유지한다.

## 2. 디렉토리 구조

```text
.
├── ADR.md                         # 최신 아키텍처 결정 기록
├── PRD.md                         # 최신 제품 요구사항
├── config/                        # 버전 관리되는 선언형 설정 예시/기본값
│   └── catalog.example.json       # read-only bot 계정에 열린 객체만 담은 예시 카탈로그
├── docs/
│   ├── PHASING.md                 # phase별 구현 순서
│   └── PHASE0_DIRECTORY_STRUCTURE.md
├── src/
│   ├── core/                      # 외부 I/O 없는 재사용 가능 domain 모듈
│   │   ├── catalog/               # 카탈로그 로딩/조회
│   │   ├── intent/                # intent spec과 clarification gate
│   │   └── sql-safety/            # SQL AST safety gate
│   ├── adapters/                  # Slack/LLM/MySQL/storage 등 외부 연동, 이후 phase에서 추가
│   ├── application/               # 세션 상태머신/worker orchestration, 이후 phase에서 추가
│   └── index.ts                   # 공개 export surface
└── tests/
    ├── unit/                      # core 중심 단위 테스트
    ├── integration/               # 실제 adapter 경계 테스트, 이후 phase에서 추가
    └── eval/                      # golden NL regression, 이후 phase에서 추가
```

## 3. 에이전트 작업 규칙

- 새 domain 규칙은 먼저 `src/core/<domain>`에 둘 수 있는지 검토한다.
- `src/core`에서 `src/adapters`를 import하면 안 된다. 의존 방향은 `application → core/adapters`, `adapters → core type`까지만 허용한다.
- 한 파일에 여러 domain을 섞지 않는다. 예: catalog 검증 로직은 `catalog`, SQL AST 검증은 `sql-safety`에 둔다.
- 모듈마다 `index.ts`를 두고 외부 공개 API를 명확히 export한다.
- phase를 넘어서는 대규모 구조 변경이 필요하면 먼저 이 문서와 `docs/PHASING.md`를 업데이트한다.
- 루트 `ADR.md`/`PRD.md`의 최신 버전과 충돌하는 구현을 추가하지 않는다. 특히 단건조회 전용 비-LLM 경로를 만들지 않는다.
- 테스트 없이 core 동작을 변경하지 않는다.

## 4. Phase 0 완료 기준

- TypeScript 프로젝트 메타파일이 존재한다.
- `src/core`, `config`, `docs`, `tests/unit`의 역할이 문서화되어 있다.
- 향후 phase가 추가할 `src/adapters`, `src/application`, `tests/integration`, `tests/eval`의 위치와 책임이 명확하다.
- 구조 원칙을 위반하지 않는 최소 core 모듈과 테스트가 존재한다.
