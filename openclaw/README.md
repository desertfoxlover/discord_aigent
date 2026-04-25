# OpenClaw (Docker)

이 폴더는 **OpenClaw 게이트웨이**를 Docker로 띄우는 설정을 담습니다.  
공식 문서: [OpenClaw — Docker](https://docs.openclaw.ai/install/docker), [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw)

---

## 현재 구성 요약 (스냅샷)

| 항목 | 값 |
|------|-----|
| 이미지 | `ghcr.io/openclaw/openclaw:latest` (로컬 빌드 없이 pull) |
| 게이트웨이 HTTP | 호스트 `18789` → 컨테이너 `18789` |
| Bridge 포트 | 호스트 `18790` (기본) |
| 설정 디렉터리 (호스트) | `data/config` → `/home/node/.openclaw` |
| 작업 워크스페이스 (호스트) | `data/workspace` → `/home/node/.openclaw/workspace` |
| `docker-compose` | `openclaw-gateway` 기본 기동, `openclaw-cli`는 **profile `cli`** (일회 명령용) |

**모델 ( `data/config/openclaw.json` )**

- Primary: `anthropic/claude-opus-4-7`
- Fallback: `google/gemini-3.1-pro-preview`, `google/gemini-2.5-pro`, `anthropic/claude-sonnet-4-6`  
- 별칭: `opus`, `sonnet`, `gemini31`, `gemini25`

> 모델 ID는 OpenClaw/공급자 버전에 따라 조정될 수 있습니다. `openclaw models list` / `openclaw models status`로 확인하세요.

**인증:** Anthropic + Google(Gemini) API 키는 **환경 변수**로 컨테이너에 전달 (`docker-compose.yml` 참고). `onboard`로 생성된 프로필은 `data/config` 아래에 저장될 수 있습니다.

---

## 사전 요건

- Docker Desktop (WSL2 백엔드 권장) 실행 가능 상태
- Anthropic / Google(AI Studio) API 키(필요 시)

---

## 처음 세팅

1. **`.env` 만들기**

   ```text
   copy .env.example .env
   ```

2. **`.env`에 채울 항목 (비밀 값은 절대 Git에 올리지 말 것)**

   - `OPENCLAW_CONFIG_DIR` / `OPENCLAW_WORKSPACE_DIR` — Windows 경로(슬래시 사용 가능)
   - `OPENCLAW_GATEWAY_TOKEN` — **긴 임의 문자열** (대시보드·게이트웨이 인증)
   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (또는 문서에 맞는 `GOOGLE_*` 조합)
   - 필요 시: `GOOGLE_API_KEY` (Gemini 키와 동일할 수 있음; compose가 전달)

3. **데이터 폴더**  
   `data/config`, `data/workspace`가 없으면 생성 (비어 있어도 됨).

4. **온보딩 (권장)**  
   설정이 꼬였을 때는 OpenClaw 공식 절차대로 `onboard`로 `openclaw.json`을 다시 잡는 것이 안전합니다. (비대화식 예는 공식 [CLI / Docker](https://docs.openclaw.ai/install/docker) 참고)

5. **기동**

   ```powershell
   cd c:\my_AI_agent\openclaw
   docker compose pull
   docker compose up -d
   ```

   `discord-bridge/.env` 가 있으면 같은 명령으로 **디스코드 브리지 컨테이너**도 함께 올라갑니다(이미지 빌드가 필요하면 `docker compose up -d --build`). 브리지는 OpenClaw 이미지를 기반으로 **`openclaw agent` CLI(WebSocket)** 로 게이트웨이에 붙으며, compose에서 `OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789` 를 넣습니다(`POST /v1/agent/run` 은 사용하지 않음).

---

## 일상 사용

| 할 일 | 명령 |
|--------|------|
| 백그라운드 기동 | `docker compose up -d` |
| 중지·삭제(스택) | `docker compose down` |
| 로그 | `docker compose logs -f openclaw-gateway` |

**대시보드:** 브라우저 `http://127.0.0.1:18789`  
연결 시 **WebSocket**은 `ws://127.0.0.1:18789` 그대로 두고, **Gateway Token**에는 `.env`의 `OPENCLAW_GATEWAY_TOKEN` 값을 입력합니다.

- PC에 `openclaw`를 **네이티브로 설치하지 않은 경우**, 문구대로 `openclaw gateway run`을 호스트에서 실행할 필요는 없고, **이미 Docker로 게이트웨이가 떠 있으면** 토큰만 맞추면 됩니다.
- 토큰이 포함된 URL이 필요하면 (선택):  
  `docker compose --profile cli run --rm openclaw-cli dashboard --no-open`

---

## Docker Desktop에서 “어느 컨테이너가 본체인가”

- **포트 `18789`가 열려 있는 `openclaw-gateway`** 가 OpenClaw **서버(게이트웨이)** 입니다.
- `docker compose run ... openclaw-cli` 로 생긴 **일회용 CLI 컨테이너**는 **보조**이며, **항시 둘 필요 없음**. 오래 “실행 중”으로 남으면 `run`이 끝나지 않았거나 잔留일 수 있어 중지·삭제해도 됩니다(게이트웨이는 유지).

---

## CLI (같은 compose에서)

`openclaw-cli`는 **profile `cli`** 사용:

```powershell
cd c:\my_AI_agent\openclaw
docker compose --profile cli run --rm openclaw-cli <서브명령>
```

예:

```powershell
docker compose --profile cli run --rm openclaw-cli models status
```

> CLI는 `network_mode: service:openclaw-gateway`이므로 **게이트웨이가 떠 있어야** 합니다.

---

## 워크스페이스(여기 파일을 수정시키기)

- **한 개 마운트:** `.env`의 `OPENCLAW_WORKSPACE_DIR`이 컨테이너의 `/home/node/.openclaw/workspace`로 연결됩니다.
- **여러 위치**를 쓰려면: 상위 공통 폴더로 `OPENCLAW_WORKSPACE_DIR`을 넓히거나, `docker-compose.yml`에 **추가 `volumes` bind**를 넣는 방식이 확실합니다.
- **Windows `.lnk` 바로가기**는 컨테이너·에이전트가 폴더로 따라가지 못하는 경우가 많으므로 **권장하지 않음**. **정션/디렉터리 심볼릭 링크**는 환경에 따라 동작이 갈릴 수 있어, **추가 마운트**가 가장 예측 가능합니다.

경로·볼륨을 바꾼 뒤에는 `docker compose up -d`로 반영하세요.

---

## 보안

- **`.env`는 Git에 올리지 말 것** (이 저장소는 `.gitignore`로 제외).
- API 키·게이트웨이 토큰이 **채팅·로그·스크린샷**에 노출되면 **즉시 폐기(rotate)** 후 `.env`를 갱신하세요.
- `gateway.bind`가 `lan`이면 공인망에 포트를 열지 말고, 방화벽·Tailscale 등은 [OpenClaw Security](https://docs.openclaw.ai/gateway/security)에 맞게 운용하세요.

---

## 구성/모델 변경 시

- 환경 변수만 바꾼 경우: `docker compose up -d` 재기동
- `data/config/openclaw.json` 수정 후 문제가 있으면: `openclaw doctor` (CLI 컨테이너로 실행) 등 공식 도구로 스키마 확인

---

## 공식 링크

- [OpenClaw Docker 설치](https://docs.openclaw.ai/install/docker)  
- [Configuration](https://docs.openclaw.ai/configuration)  
- [Anthropic (Claude)](https://docs.openclaw.ai/providers/anthropic)  
- [Google (Gemini)](https://docs.openclaw.ai/providers/google)

---

## 이후(이 저장소의 목표와 별도)

- Discord 채널 연결, “클로드 수정 ↔ 제미나이 검토” 전용 **오케스트레이션**은 OpenClaw **위에** 별도 봇/스크립트로 쌓는 단계로 진행하는 것이 일반적입니다. 이 README는 **Docker + OpenClaw 기동까지**의 기준으로 유지합니다.
