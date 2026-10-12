# Visualizer · Message Queue

메시지 큐 기반 **비동기 작업 처리 과정을 실시간으로 눈으로 볼 수 있게** 만든 Next.js 프로젝트입니다.

사용자가 웹 화면에서 작업을 큐에 넣으면 서버리스 워커가 CPU 연산을 수행합니다. 각 작업이 **대기 → 처리 중 → 재시도 → 완료 / 실패(DLQ)** 로 이동하는 과정을 칸반 보드와 이벤트 로그로 실시간 표시합니다. 일부러 실패를 일으켜 **재시도, Dead Letter Queue, 재처리(Replay)** 같은 실무형 실패 처리 흐름도 직접 확인할 수 있습니다.

> Next.js 16 · React 19 · TypeScript · Upstash QStash · Upstash Redis · Server-Sent Events · Tailwind CSS 4 · Motion · Vercel

---

## 목차

1. [주요 기능](#주요-기능)
2. [아키텍처](#아키텍처)
3. [실패 처리 설계](#실패-처리-설계)
4. [기술 스택과 버전](#기술-스택과-버전)
5. [개발 환경 (Node 버전)](#개발-환경-node-버전)
6. [설치 방법](#설치-방법)
7. [환경변수 설정](#환경변수-설정)
8. [실행 방법](#실행-방법)
9. [사용 방법 (시연 시나리오)](#사용-방법-시연-시나리오)
10. [Vercel 배포](#vercel-배포)
11. [프로젝트 구조](#프로젝트-구조)
12. [API 명세](#api-명세)
13. [Redis 데이터 구조](#redis-데이터-구조)
14. [설계 결정과 트레이드오프](#설계-결정과-트레이드오프)
15. [한계와 개선 아이디어](#한계와-개선-아이디어)

---

## 주요 기능

| 기능 | 설명 |
|---|---|
| **실시간 칸반 보드** | `Queued` · `Processing` · `Retrying` · `Done` · `Failed (DLQ)` 5개 칸으로 작업 상태를 SSE로 실시간 표시합니다. 새 카드는 위에서 떨어지듯 쌓이고, 기존 카드는 부드럽게 한 칸씩 밀려납니다. |
| **실제 CPU 작업** | 워커가 `2 ~ N` 범위의 소수를 직접 셉니다. N을 키우면 처리 시간이 길어집니다(로컬 기준 N=2,000만이면 약 3초). |
| **동시 처리 수 조절** | QStash Flow Control의 `parallelism`(×1, ×2, ×3, ×5)으로 순차 처리와 병렬 처리를 비교할 수 있습니다. |
| **재시도 횟수 설정** | 0~3회 사이로 입력받아 QStash 재시도 정책에 그대로 반영합니다. |
| **실패 시나리오** | `Normal`, `Transient`(첫 시도만 실패), `Permanent`(매번 실패), 잘못된 입력(`abc`, `-5`, 너무 큰 값)을 선택할 수 있습니다. |
| **실패 사유 상세 보기** | Failed 카드를 클릭하면 실패 원인 설명, 에러 메시지, **시도별 타임라인**(시각, 진행률, HTTP 응답 코드, 워커 ID)을 보여줍니다. |
| **재처리 (Replay)** | DLQ에 들어간 작업을 다시 큐에 넣을 수 있습니다. 잘못된 입력은 값을 고쳐서 재처리(Fix & replay)할 수 있습니다. |
| **이벤트 로그** | 화면 오른쪽 사이드바에 큐에서 일어나는 모든 이벤트를 시간순으로 표시합니다. |
| **통계** | 상태별 개수와 평균 대기 시간, 평균 처리 시간을 보여줍니다. |

---

## 아키텍처

```
 ┌────────────┐  ① POST /api/jobs      ┌──────────────────┐  ② publishJSON       ┌───────────────────────┐
 │  Browser   │ ─────────────────────▶ │  Next.js API     │ ───────────────────▶ │  Upstash QStash       │
 │ (Dashboard)│                        │  (enqueue)       │   flowControl,       │  (메시지 큐)            │
 └─────▲──────┘                        └────────┬─────────┘   retries            └───────────┬───────────┘
       │                                        │ "queued" 기록                                │ ③ HTTP POST
       │                                        ▼                                            │  (서명 포함, parallelism 만큼만 동시에)
       │                               ┌──────────────────┐   ④ 상태·진행률 기록     ┌───────────▼───────────┐
       │  ⑤ SSE /api/stream            │  Upstash Redis   │ ◀──────────────────── │  /api/worker          │
       └────────────────────────────── │  (상태 저장소)      │                       │  (CPU 연산: 소수 세기)   │
          mq:ver 변경 감지 시 전체 상태 전송 └──────────────────┘                       └───────────────────────┘
```

### 처리 흐름

1. **작업 생성**: 사용자가 `Enqueue`를 누르면 `POST /api/jobs`가 호출됩니다.
2. **상태 기록과 발행**: API가 Redis에 작업을 `queued` 상태로 저장한 뒤 QStash에 메시지를 발행합니다. 이때 `retries`, `retryDelay`, `flowControl.parallelism`을 함께 지정합니다.
3. **워커 호출**: QStash가 `parallelism` 개수만큼만 동시에 `/api/worker`를 HTTP로 호출합니다(push 방식). 요청에는 서명이 붙어 있고, 워커는 서명을 검증해 QStash가 보낸 요청만 처리합니다.
4. **처리**: 워커가 입력값을 검증하고 CPU 연산을 수행하면서 진행률을 10% 단위로 Redis에 기록합니다. 성공하면 `200`, 일시적 실패면 `500`(QStash가 재시도), 재시도해도 소용없는 실패면 `489`를 응답합니다.
5. **실시간 표시**: `/api/stream`(SSE)이 Redis의 버전 키(`mq:ver`)만 주기적으로 확인하다가, 값이 바뀌었을 때만 전체 상태를 브라우저로 보냅니다.

### 왜 이런 구조인가

Vercel 같은 서버리스 환경에는 **항상 켜져 있는 워커 프로세스가 없습니다.** 그래서 RabbitMQ나 Kafka처럼 워커가 큐에서 메시지를 꺼내 가는(pull) 방식을 쓸 수 없습니다. 이 프로젝트는 **큐가 워커를 HTTP로 호출하는(push) QStash**를 사용해 이 제약을 해결했습니다.

---

## 실패 처리 설계

| 시나리오 | 워커 동작 | 워커 응답 | QStash 동작 | 최종 상태 |
|---|---|---|---|---|
| **Normal** | 정상 처리 | `200` | 완료 | `Done` |
| **Transient** | 첫 시도만 50% 지점에서 에러 | `500` → `200` | 3초 후 재시도 → 성공 | `Retrying` → `Done` |
| **Permanent** | 매 시도 50% 지점에서 에러 | `500` × (재시도 + 1) | 재시도를 모두 소진 | `Retrying` → `Failed (DLQ)` |
| **잘못된 입력** (`abc`, `-5`, `99.9B`) | 계산 전 검증 단계에서 실패 | `489` + `Upstash-NonRetryable-Error: true` | 재시도 없이 DLQ로 이동 | `Failed (DLQ)` |
| **Retries = 0 + Transient** | 첫 시도 실패 | `500` | 재시도 없음 | `Failed (DLQ)` |

- **현재 몇 번째 시도인지**는 QStash가 보내는 `Upstash-Retried` 헤더로 판단합니다.
- **잘못된 입력은 API에서 미리 거르지 않습니다.** 잘못된 메시지(poison message)가 큐에 들어왔을 때 워커가 어떻게 처리하는지 보여주기 위해서입니다.
- **멱등성**: 이미 `done`이나 `failed` 상태이거나 초기화로 지워진 작업이 다시 전달되면, 워커는 처리하지 않고 `200`을 돌려줘 QStash가 더 보내지 않게 합니다.
- **시도 기록**: 매 시도가 끝날 때마다 시작/종료 시각, 도달한 진행률, HTTP 응답 코드, 워커 ID, 에러 메시지를 `history`에 쌓습니다. 실패 상세 창에서 이 기록을 보여줍니다.
- 재시도 간격은 시연을 위해 **3초**로 고정했습니다(`retryDelay`). QStash 기본값은 지수 백오프라 수십 초에서 수 분까지 걸립니다.

---

## 기술 스택과 버전

| 구분 | 기술 | 버전 | 용도 |
|---|---|---|---|
| 프레임워크 | [Next.js](https://nextjs.org) (App Router) | 16.4.0 | 화면, API Route Handler |
| UI | React | 19.3.0 | 대시보드 UI |
| 언어 | TypeScript | 5.9.3 | 전체 코드 |
| 메시지 큐 | [Upstash QStash](https://upstash.com/docs/qstash) (`@upstash/qstash`) | 2.12.0 | 발행, 재시도, DLQ, Flow Control |
| 상태 저장소 | [Upstash Redis](https://upstash.com/docs/redis) (`@upstash/redis`) | 1.39.0 | 작업 상태, 이벤트 로그 (REST 기반) |
| 실시간 전송 | Server-Sent Events | - | 서버에서 브라우저로 상태 푸시 |
| 스타일 | Tailwind CSS | 4.3.3 | 다크 테마 UI |
| 애니메이션 | [Motion](https://motion.dev) | 14.1.0 | 카드 이동, 레이아웃 애니메이션 |
| 폰트 | [Pretendard](https://github.com/orioncactus/pretendard) | 1.3.9 | `next/font/local`로 직접 제공 |
| 배포 | Vercel | - | 서버리스 함수 |

---

## 개발 환경 (Node 버전)

이 프로젝트는 아래 환경에서 개발하고 빌드를 확인했습니다.

| 항목 | 버전 |
|---|---|
| **Node.js** | **v22.16.0** |
| npm | 11.5.2 |
| OS | Windows 11 |

- 최소 요구 버전은 **Node.js 20.9.0 이상**입니다. Next.js 16의 요구사항이며, `package.json`의 `engines`에도 적어 두었습니다.
- 루트의 `.nvmrc`에 `22.16.0`이 적혀 있습니다. nvm을 쓴다면 다음 명령으로 같은 버전을 맞출 수 있습니다.

```bash
nvm install   # .nvmrc의 버전 설치
nvm use       # .nvmrc의 버전 사용
node -v       # v22.16.0 확인
```

> Windows에서는 [nvm-windows](https://github.com/coreybutler/nvm-windows)를 쓰거나, [Node.js 공식 사이트](https://nodejs.org)에서 22.x LTS를 설치하면 됩니다. nvm-windows는 `.nvmrc`를 자동으로 읽지 않으므로 `nvm install 22.16.0` → `nvm use 22.16.0`처럼 버전을 직접 입력합니다.

---

## 설치 방법

### 1. 저장소 클론

```bash
git clone https://github.com/Mithpasong/visualizer-message-queue.git
cd visualizer-message-queue
```

### 2. 의존성 설치

```bash
npm ci
```

- `npm ci`는 `package-lock.json`에 기록된 버전 그대로 설치합니다. 위 표와 같은 버전으로 재현할 때 권장합니다.
- lock 파일을 갱신해도 괜찮다면 `npm install`을 써도 됩니다.

### 3. Upstash 계정 준비

[Upstash 콘솔](https://console.upstash.com)에 가입합니다. 무료 플랜으로 충분합니다.

1. **Redis 데이터베이스 생성**
   - `Redis` → `Create Database`
   - Name: 원하는 이름 (예: `visualizer-mq`)
   - Primary Region: Vercel 기본 리전과 가까운 `us-east-1` 권장
   - **Eviction: 끄기**. 작업 상태 데이터가 임의로 삭제되면 안 되기 때문입니다.
   - Plan: Free
   - 생성 후 **REST API** 섹션의 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 복사합니다.
2. **QStash 토큰 확인** (배포할 때만 필요)
   - `QStash` 메뉴에서 `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`를 확인합니다.
   - 로컬 개발에서는 QStash 토큰이 필요 없습니다. 아래 [환경변수 설정](#환경변수-설정)을 참고하세요.

---

## 환경변수 설정

템플릿을 복사해 `.env.local`을 만듭니다.

```bash
cp .env.example .env.local
```

| 변수 | 로컬 | 배포 | 설명 |
|---|:---:|:---:|---|
| `UPSTASH_REDIS_REST_URL` | 필수 | 필수 | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | 필수 | 필수 | Upstash Redis REST 토큰 |
| `QSTASH_DEV` | `true` | **넣지 않음** | `true`이면 QStash SDK가 **로컬 QStash 개발 서버를 자동으로 내려받아 실행**합니다. 토큰과 서명 키가 필요 없습니다. |
| `QSTASH_URL` | - | 필수 | QStash API 주소 (리전별로 다름) |
| `QSTASH_TOKEN` | - | 필수 | 메시지 발행용 토큰 |
| `QSTASH_CURRENT_SIGNING_KEY` | - | 필수 | 워커에서 요청 서명 검증용 |
| `QSTASH_NEXT_SIGNING_KEY` | - | 필수 | 서명 키 교체(rotation) 대비용 |
| `APP_URL` | 선택 | 선택 | QStash가 호출할 워커 주소의 기준 URL입니다. 비우면 요청이 들어온 주소(origin)를 사용합니다. |

로컬 개발용 `.env.local` 예시:

```dotenv
UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxxxxx
QSTASH_DEV=true
```

> `.env.local`은 `.gitignore`에 포함되어 있어 커밋되지 않습니다. 토큰은 절대 저장소에 올리지 마세요.

---

## 실행 방법

### 개발 서버

```bash
npm run dev
```

브라우저에서 http://localhost:3000 을 엽니다.

- 오른쪽 위 연결 상태가 **`Live (SSE)`** 로 바뀌면 준비가 끝난 것입니다.
- `QSTASH_DEV=true`라면 첫 작업을 넣을 때 QStash SDK가 로컬 QStash 서버를 띄웁니다. 처음 한 번은 실행 파일을 내려받느라 조금 걸릴 수 있습니다.

### 프로덕션 빌드 후 실행

```bash
npm run build
npm run start
```

> 로컬 QStash 개발 모드(`QSTASH_DEV`)는 `NODE_ENV=production`에서 자동으로 꺼집니다. 그래서 `npm run start`로 실행하려면 배포용 QStash 환경변수가 필요하고, QStash 클라우드가 워커 주소에 접근할 수 있어야 합니다(localhost는 접근 불가). 로컬 확인은 `npm run dev`를 사용하세요.

### 린트와 타입 검사

```bash
npm run lint        # ESLint
npx tsc --noEmit    # TypeScript 타입 검사
```

### npm 스크립트 정리

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 실행 (http://localhost:3000) |
| `npm run build` | 프로덕션 빌드 |
| `npm run start` | 빌드 결과 실행 |
| `npm run lint` | ESLint 검사 |

---

## 사용 방법 (시연 시나리오)

입력 패널에서 다음 값을 고른 뒤 **Enqueue**를 누릅니다.

| 항목 | 설명 |
|---|---|
| **Input N** | 2부터 N까지 소수를 셉니다 (최대 5,000만). 프리셋 버튼 중 빨간색(`abc`, `-5`, `99.9B`)은 일부러 잘못된 입력입니다. |
| **Failure scenario** | Normal / Transient / Permanent |
| **Jobs** | 한 번에 넣을 작업 수 (1, 3, 5, 10) |
| **Concurrency** | 동시에 처리할 최대 작업 수 (×1, ×2, ×3, ×5) |
| **Retries** | 실패 시 재시도 횟수 (0~3) |

### 추천 시나리오

1. **순차 처리 확인**: N=20M, Normal, 5 jobs, ×1
   → 한 번에 하나씩 처리되고, 뒤에 들어간 작업일수록 `Wait` 시간이 길어집니다.
2. **병렬 처리와 비교**: 같은 조건에서 ×5
   → 동시에 처리되며 `Avg wait`가 크게 줄어듭니다.
3. **재시도로 복구**: Transient, 3 jobs, ×1
   → 50%에서 실패해 `Retrying`으로 갔다가 3초 후 재시도되어 `Done`이 됩니다.
4. **재시도 소진 → DLQ**: Permanent, Retries 2
   → 3번 모두 실패해 `Failed (DLQ)`로 이동합니다. 카드를 클릭하면 시도별 타임라인을 볼 수 있습니다.
5. **잘못된 입력**: `abc` 프리셋 선택 후 Enqueue
   → 재시도 없이 바로 실패합니다. 카드에서 값을 고쳐 **Fix & replay**를 누르면 다시 처리됩니다.
6. **재시도가 없을 때**: Transient, Retries 0
   → 일시적인 오류인데도 재시도가 없어 바로 실패합니다.

**Reset** 버튼은 Redis의 모든 작업과 이벤트를 지웁니다.

---

## Vercel 배포

1. 이 저장소를 Vercel에 Import합니다 (Framework Preset: Next.js, 설정 변경 없음).
2. **Settings → Environment Variables**에 아래 6개를 추가합니다. `QSTASH_DEV`는 **넣지 않습니다.**
   ```
   UPSTASH_REDIS_REST_URL
   UPSTASH_REDIS_REST_TOKEN
   QSTASH_URL
   QSTASH_TOKEN
   QSTASH_CURRENT_SIGNING_KEY
   QSTASH_NEXT_SIGNING_KEY
   ```
3. Deploy합니다.

**주의사항**

- **Deployment Protection**: Preview 배포에 Vercel Authentication이 켜져 있으면 QStash가 워커(`/api/worker`)를 호출하지 못합니다. **Production 도메인에서 테스트**하거나, `APP_URL`을 Production 도메인으로 지정하세요.
- **실행 시간**: 워커와 SSE 라우트의 `maxDuration`은 60초입니다. SSE 연결은 50초마다 스스로 닫히고, 브라우저의 `EventSource`가 자동으로 다시 연결합니다.
- **무료 한도**: Upstash 무료 플랜은 월 명령 수와 일 메시지 수에 제한이 있습니다. 탭이 숨겨지면 SSE 연결을 끊고, 상태가 바뀌었을 때만 전체 데이터를 읽어 사용량을 줄였습니다.

---

## 프로젝트 구조

```
visualizer-message-queue/
├── app/                              # Next.js App Router
│   ├── api/
│   │   ├── jobs/route.ts             # POST: 작업 생성·발행 / DELETE: 전체 초기화
│   │   ├── replay/route.ts           # POST: 실패한 작업 재처리 (입력값 수정 가능)
│   │   ├── stream/route.ts           # GET: SSE 실시간 상태 스트림
│   │   └── worker/route.ts           # POST: QStash가 호출하는 워커 (서명 검증, CPU 연산, 재시도 판단)
│   ├── components/
│   │   ├── Dashboard.tsx             # 메인 대시보드 (입력 패널, 통계, 칸반 보드, 이벤트 로그, SSE 연결)
│   │   └── FailureDetails.tsx        # 실패 상세 모달 (실패 사유, 작업 정보, 시도별 타임라인, 재처리)
│   ├── favicon.ico
│   ├── globals.css                   # Tailwind 설정, 다크 테마 색상, 버튼 커서 등 전역 스타일
│   ├── layout.tsx                    # 루트 레이아웃 (Pretendard 폰트, 다크 모드 기본, 메타데이터)
│   └── page.tsx                      # 메인 페이지 (Dashboard 렌더링)
├── lib/                              # 서버/클라이언트 공용 로직
│   ├── cpu-task.ts                   # 입력값 검증(parseInput), 소수 세기(countPrimes), 의도적 실패
│   ├── enqueue.ts                    # 작업 생성 → Redis 기록 → QStash 발행 (재시도·동시성 옵션)
│   ├── limits.ts                     # 재시도 기본값/최대값 등 UI와 API가 함께 쓰는 상수
│   ├── qstash.ts                     # QStash 클라이언트 (지연 생성), Flow Control 키
│   ├── redis.ts                      # Redis 클라이언트, 키 정의, 상태 조회·저장·정리 함수
│   └── types.ts                      # Job, AttemptLog, QueueEvent, QueueState 타입
├── .env.example                      # 환경변수 템플릿
├── .nvmrc                            # Node.js 버전 (22.16.0)
├── AGENTS.md                         # AI 코딩 에이전트용 Next.js 안내 (create-next-app 생성)
├── eslint.config.mjs                 # ESLint 설정
├── next.config.ts                    # Next.js 설정 (Cache Components, Turbopack + Tailwind)
├── package.json
├── package-lock.json
├── tsconfig.json                     # TypeScript 설정 (경로 별칭 @/*)
└── LICENSE                           # MIT
```

### 파일별 상세 설명

#### `app/api/jobs/route.ts`
- `POST`: 요청 본문의 값을 안전한 범위로 보정합니다(작업 수 1~10, 동시성 1~5, 재시도 0~3). 그 뒤 작업 수만큼 `enqueueJob()`을 호출하고, 60개가 넘는 오래된 완료/실패 작업을 정리합니다.
- `DELETE`: Redis의 작업, 이벤트, 순번을 모두 지웁니다.
- 입력값 N은 **일부러 검증하지 않습니다.** 검증은 워커의 몫입니다.

#### `app/api/worker/route.ts`
- `verifySignatureAppRouter`로 QStash 서명을 검증합니다. 키가 없는 빌드 환경에서도 깨지지 않도록 첫 요청 때 핸들러를 만듭니다.
- 처리 순서는 다음과 같습니다.
  1. 작업 조회 → 이미 끝났거나 지워진 작업이면 `200`으로 건너뜀
  2. `Upstash-Retried` 헤더로 시도 번호 계산 → `processing` 기록
  3. `parseInput()`으로 입력 검증 → `countPrimes()` 실행 (진행률 10%마다 Redis 기록)
  4. 결과에 따라 `done`(200) / `retrying`(500) / `failed`(500 또는 489) 기록과 응답
- 매 시도의 결과를 `history`에 추가합니다.
- 워커 ID(`리전-인스턴스ID`)를 기록해, 같은 서버리스 인스턴스가 재사용되는지 볼 수 있습니다.

#### `app/api/stream/route.ts`
- `ReadableStream`으로 SSE를 구현했습니다.
- 처리 중인 작업이 있으면 500ms, 없으면 2초 간격으로 `mq:ver`만 조회하고, 값이 바뀌었을 때만 `getState()`로 전체 상태를 읽어 `event: state`로 보냅니다.
- 50초 후 스스로 닫고(`retry: 1000`), 클라이언트가 자동으로 다시 연결합니다.
- `connection()`을 호출해 빌드 시 미리 실행(prerender)되지 않게 했습니다.

#### `app/api/replay/route.ts`
- `failed` 상태의 작업만 재처리할 수 있습니다.
- 원래 작업의 동시성과 재시도 설정을 그대로 쓰고, 실패 시나리오는 `none`으로 바꿉니다(원인을 고쳤다고 가정).
- 새 작업에는 `replayOf`로 원래 작업 번호를 남깁니다.

#### `app/components/Dashboard.tsx`
- `EventSource`로 `/api/stream`에 연결하고, 탭이 숨겨지면 연결을 끊습니다.
- 각 칸은 그 칸에 **가장 최근에 들어온 작업이 맨 위**에 오도록 정렬합니다(`statusAt` 기준).
- Motion의 `AnimatePresence mode="popLayout"`과 `layout` 애니메이션으로 카드 등장, 이동, 퇴장을 표현합니다. 페이지를 처음 열 때는 이미 있던 카드가 한꺼번에 움직이지 않도록 애니메이션을 끕니다.
- 처리 중인 작업이 있을 때만 200ms 간격의 시계를 돌려 경과 시간을 갱신합니다.

#### `app/components/FailureDetails.tsx`
- 실패 유형별 설명(잘못된 입력 / 영구 실패 / 재시도 0회 / 재시도 소진), 에러 메시지, 작업 설정, 시도별 타임라인을 보여주는 모달입니다.
- Esc 키, 바깥 영역 클릭, Close 버튼으로 닫히고, 모달 안에서 바로 재처리할 수 있습니다.

#### `lib/cpu-task.ts`
- `parseInput()`: 쉼표와 밑줄을 허용하고, 숫자가 아니거나 2 미만 또는 5,000만 초과이면 `InvalidInputError`를 던집니다.
- `countPrimes()`: 시도 나눗셈으로 소수를 셉니다. 10단계로 나눠 진행률 콜백을 호출하고, `failAt`이 지정되면 해당 진행률에서 `SimulatedFailure`를 던집니다.

#### `lib/enqueue.ts`
- 작업 객체 생성 → Redis에 `queued`로 저장하고 이벤트 기록 → QStash `publishJSON` 순서로 실행합니다.
- 발행 옵션은 `retries`(사용자 설정), `retryDelay: "3000"`, `flowControl: { key: "mq-demo", parallelism }`입니다.

#### `lib/redis.ts`
- `getState()`: 파이프라인 한 번으로 작업 전체(`HGETALL`), 최근 이벤트 40개, 버전을 읽습니다.
- `saveJob()`: 작업 저장, 이벤트 기록, 버전 증가를 파이프라인 한 번에 처리합니다.
- `trimJobs()`, `resetAll()`: 정리와 초기화를 담당합니다.

---

## API 명세

### `POST /api/jobs` — 작업 생성

```jsonc
// Request
{
  "input": "20000000",        // 문자열 그대로 큐에 들어감 (검증은 워커에서)
  "count": 3,                 // 1~10
  "failMode": "transient",    // "none" | "transient" | "permanent"
  "parallelism": 1,           // 1~5
  "retries": 2                // 0~3
}
// Response 200
{ "jobs": [ /* Job[] */ ] }
```

### `DELETE /api/jobs` — 전체 초기화

```jsonc
// Response 200
{ "ok": true }
```

### `POST /api/replay` — 실패 작업 재처리

```jsonc
// Request
{ "id": "<job id>", "input": "1000000" }   // input은 선택 (입력값을 고칠 때)
// Response 200
{ "job": { /* Job */ } }
// 404: 작업 없음 / 400: failed 상태가 아님
```

### `GET /api/stream` — 실시간 상태 (SSE)

```
event: state
data: {"ver":12,"jobs":[...],"events":[...]}

: ping

event: server-error
data: {"message":"..."}
```

### `POST /api/worker` — 워커 (QStash 전용)

- QStash 서명(`Upstash-Signature`)이 없거나 잘못되면 거부합니다.
- 본문: `{ "id": "<job id>" }`
- 응답: `200` 성공 또는 건너뜀 / `500` 실패(재시도 대상) / `489` 재시도 불가 실패

### Job 객체 주요 필드

| 필드 | 설명 |
|---|---|
| `seq` | 화면에 표시되는 작업 번호 (#1, #2 …) |
| `status` | `queued` · `processing` · `retrying` · `done` · `failed` |
| `progress` | 0~100 |
| `attempt` / `maxAttempts` | 현재 시도 / 최대 시도 (재시도 + 1) |
| `createdAt` · `startedAt` · `finishedAt` · `statusAt` | 생성, 처리 시작, 종료, 현재 상태 진입 시각 (ms) |
| `worker` | 처리한 워커 ID |
| `error` · `errorKind` | 에러 메시지, `invalid-input` 또는 `processing` |
| `history` | 시도별 기록 (`AttemptLog[]`) |
| `replayOf` | 재처리 작업이면 원래 작업 번호 |

---

## Redis 데이터 구조

| 키 | 타입 | 내용 |
|---|---|---|
| `mq:jobs` | Hash | `{ [jobId]: Job(JSON) }`, 전체 작업 (최대 60개 유지) |
| `mq:events` | List | 최근 이벤트 40개 (`LPUSH` + `LTRIM`) |
| `mq:ver` | String (정수) | 상태가 바뀔 때마다 1씩 증가 → SSE의 변경 감지용 |
| `mq:seq` | String (정수) | 작업 번호 발급용 카운터 |

모든 키에는 24시간 TTL이 걸려 있어 방치된 데이터가 자동으로 정리됩니다.

---

## 설계 결정과 트레이드오프

- **Push 방식 큐 (QStash)**: 서버리스 환경에는 상시 실행되는 컨슈머를 둘 수 없어서, 큐가 워커를 HTTP로 호출하는 방식을 택했습니다. 재시도, DLQ, 동시성 제한을 큐가 담당하므로 워커 코드는 "처리하고 HTTP 상태 코드로 결과를 알린다"는 역할만 맡습니다.
- **큐와 상태 저장소 분리**: QStash는 메시지 전달만 담당하고, 화면에 보여줄 상태는 Redis에 따로 기록합니다. 큐 내부를 조회하지 않고도 대시보드를 그릴 수 있고, 진행률 같은 세부 정보를 남길 수 있습니다.
- **Redis 명령 수 최소화**: 작업 전체를 해시 하나에 두어 `HGETALL` 한 번으로 읽고, 쓰기는 파이프라인으로 묶었습니다. SSE는 버전 키만 확인하다가 바뀔 때만 전체를 읽고, 진행률은 10% 단위로만 기록합니다.
- **WebSocket 대신 SSE**: 서버리스 함수는 WebSocket 서버를 유지할 수 없습니다. SSE는 일반 HTTP 응답이고, 함수 시간 제한 전에 닫아도 `EventSource`가 자동으로 다시 연결합니다.
- **검증 위치**: 입력 검증을 API가 아닌 워커에 두어 poison message 처리 흐름을 보여줍니다. 실제 서비스라면 API 단계에서도 검증하는 것이 일반적입니다.

---

## 한계와 개선 아이디어

- **알림**: 최종 실패 시 QStash `failureCallback`으로 Slack 같은 곳에 알림을 보내는 기능
- **일괄 재처리**: DLQ에 쌓인 작업을 한 번에 재처리하는 `Replay all`
- **현실적인 실패 시나리오**: 확률 기반 랜덤 실패, 함수 실행 시간 초과
- **QStash DLQ 직접 연동**: 현재 Failed 칸은 Redis에 기록한 상태를 보여줍니다. QStash DLQ API를 직접 조회해 함께 표시하면 실제 DLQ와 비교할 수 있습니다.
- **동시성 키 분리**: 현재는 모든 사용자가 하나의 Flow Control 키(`mq-demo`)를 공유합니다. 여러 사람이 동시에 쓰면 서로의 큐에 영향을 줍니다.
- **테스트**: `parseInput`, `countPrimes`, 재시도 판단 로직의 단위 테스트

---

## License

[MIT](./LICENSE) © 2026 Mithpasong
