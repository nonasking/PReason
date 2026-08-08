# review-gate (한국어)

**리뷰 컨벤션을 코드로 관리하고(convention-as-code), 어떤 AI 리뷰어를 쓰든 같은
기준으로 리뷰받고, 그 결과가 머지 게이트를 거쳐 사람 리뷰어 1명에게 이어지는
파이프라인 템플릿.**

AI 도입으로 PR이 인당 하루 몇 건씩 쏟아지면 사람이 전부 리뷰하는 건 불가능해지고,
결국 빈 approve(러버스탬프)로 무너진다. 이 템플릿이 제안하는 구조:

1. **AI 1차 리뷰** — Claude / Copilot / CodeRabbit 무엇을 쓰든
   `review-conventions.yml` 하나에서 생성된 동일한 규칙을 읽고, 모든 코멘트에
   `[blocker]` / `[warn]` / `[nit]` severity 태그를 강제한다.
2. **머지 게이트** — 해결되지 않은 `[blocker]` 스레드가 하나라도 있으면 status
   check가 빨간불. 작성자는 고치거나, 반박 코멘트를 달고 스레드를 resolve해야
   진행된다. AI 피드백이 조용히 무시되는 일이 없어진다.
3. **사람 리뷰어 1명 자동 배정** — 게이트 통과 후에만. 이 사람의 역할은 diff
   전체를 다시 읽는 게 아니라 **"리뷰의 리뷰"**: PR 설명과 변경 의도, AI 지적과
   작성자의 대응, 위험 지점만 본다. 목표 공수는 PR당 5분. 결제·인증·마이그레이션
   등 위험 경로를 건드린 PR은 라벨이 붙고 지정 리뷰어에게 승격된다.

```
review-conventions.yml            ← 단일 소스
   ├─→ CLAUDE.md                  → Claude (claude-code-action)
   ├─→ .github/copilot-instructions.md + instructions/*  → Copilot
   └─→ .coderabbit.yaml           → CodeRabbit (선택)
              ↓ AI 리뷰 (severity 태그 강제)
   게이트: unresolved [blocker] → check 실패
              ↓ 통과 시
   랜덤(결정적) 리뷰어 1명 배정 / 위험 경로면 라벨 + 지정 리뷰어
```

## 빠른 시작

1. 이 레포를 템플릿으로 사용 (또는 `review-conventions.yml`, `scripts/`,
   `.github/workflows/`, `package.json`을 기존 레포로 복사).
2. `review-conventions.yml` 수정 — 팀 규칙, 위험 경로, 리뷰어 풀:
   ```yaml
   reviewers:
     pool: [alice, bob, carol]
   risk_reviewers: [tech-lead]
   ```
3. 생성 파일 갱신 후 커밋: `npm install && npm run sync`
4. Claude 리뷰를 쓰려면 레포 시크릿에 `ANTHROPIC_API_KEY` 추가
   (Copilot/CodeRabbit만 쓸 거면 `claude-review.yml` 삭제).
5. 브랜치 보호에서 `gate` check를 required로 지정 — 이게 없으면 파이프라인은
   권고에 그친다. 사람 approve 1명도 함께 required로 걸면 완성.

## 게이트 판정 방식

`scripts/review-gate.mjs`가 GraphQL로 PR의 리뷰 스레드를 전부 읽고, 설정된 AI
리뷰어(`ai_reviewers`, `[bot]` 접미사 무시)가 시작한 스레드만 남긴다. 첫 코멘트의
첫 토큰에서 severity를 파싱:

- `[blocker]` → 스레드 resolve 전까지 check 실패
- `[warn]` / `[nit]` → 리포트만, 차단 안 함
- 태그 없음 → `severity.default`(기본 warn)로 처리 — Copilot instructions는
  강제력이 없어 태그를 빼먹을 수 있으므로, 누락이 머지를 조용히 막지도/열지도
  않게 하는 안전장치

스레드를 resolve하면 `pull_request_review_thread` 이벤트로 워크플로가 재실행되어
수동 재시도 없이 check가 초록불로 바뀐다.

## 설계 노트

- **리뷰어 픽은 결정적** (`PR 번호 % 풀 크기`) — 재실행해도 배정이 바뀌지 않고,
  장기적으로는 공평하게 순환한다. GitHub 팀의 auto-assignment(load balance)를
  쓰고 싶으면 `pool`을 비워두면 된다 — 게이트와 위험 경로 승격은 그대로 동작.
- **반박은 정당한 처리다.** 스레드에 답글을 달고 resolve하면 게이트는 통과.
  사람 리뷰어는 스레드 히스토리에서 그 반박을 보게 되고, 그 판단이 바로 사람
  5분의 몫이다.
- **비용**: `claude-opus-5` 기준 PR당 수십 센트 수준. 물량 많은 저위험 레포는
  `claude-review.yml`에서 `--model claude-haiku-4-5`로 교체. Anthropic 콘솔에서
  실행별 토큰이 보이므로, 팀 도입 전 비용 실측 장비로도 쓸 수 있다.

자세한 내용은 [영문 README](../README.md) 참고.
