# GitHub Actions로 매일 PDF 받기

국내 증권사가 발행한 미국 산업·미국 상장 종목 관련 **10쪽 이상 산업 리포트**를 선별합니다. In-Depth·심층 표기는 필요하지 않습니다. 원문 PDF 전체 쪽수로 판단하며 개별기업·단순 일일·주간 자료는 제외합니다. 한경·네이버, 하나·미래에셋·토스·교보·유안타·상상인·현대차·한양증권의 공개 목록, 키움·메리츠·NH·신한 리서치 공개 채널의 원문을 수집합니다. 기본 출처는 14곳이며 NH 채널은 제약·바이오 범위입니다. [SOURCE_STATUS_KO.md](./SOURCE_STATUS_KO.md)에 실제 범위와 미해결 경로를 기록합니다. 원문에서 로그인을 요구하는 경로와 와이즈리포트는 기본 수집 대상에 포함하지 않습니다. 맥미니를 사용하는 대안은 SETUP_KO.md에 정리했습니다.

별도 PC나 유료 서버 없이 GitHub가 프로그램을 예약 실행합니다. 공개 저장소의 표준 GitHub 호스팅 실행기는 무료이며, 이 프로젝트는 표준 `ubuntu-latest` 실행기를 사용합니다. 유료 AI는 기본적으로 호출하지 않습니다. 기존 저장소의 코드·워크플로·Secrets를 변경하지 않고 새 전용 저장소에 독립적으로 배포합니다.

## 동작과 시각

- `.github/workflows/industry-reports.yml`을 기본 브랜치에 올립니다.
- 매일 `0 8 * * *`, 즉 한국시간 오후 5시에 실행하도록 예약합니다.
- GitHub 예약 작업은 혼잡할 때 지연되거나 누락될 수 있습니다. 정각 5시를 보장하지 않습니다. 늦게 시작해도 그날 저녁에는 한 번 처리하고, 자정 이후에는 다음 정기 실행을 기다립니다.
- `bot-state` 브랜치에 SQLite 상태 파일을 보관하여 실행기가 매번 새로 생겨도 기준점과 전송 이력을 복원합니다. 이 브랜치를 삭제하면 기존 상태를 잃습니다.
- PDF 전송 전에 대기 이력을 원격에 저장합니다. 저장에 실패하면 전송을 중단하여 중복 위험을 줄입니다. 성공 여부가 불명확한 건은 자동 재전송하지 않습니다.
- PDF와 토큰, 개인 대화 ID는 상태 브랜치에 저장하지 않습니다. 공개 상태 브랜치에는 공개 보고서의 메타데이터와 처리 이력만 남습니다. 토큰과 개인 대화 ID는 Actions Secrets에만 등록합니다.

## 설정

1. 별도의 전용 공개 저장소를 만들고 프로젝트의 **내용물**을 저장소 최상위에 올립니다. `.github` 폴더도 포함합니다. `.env`, `data/`, PDF 원문과 접근 검증용 자료는 업로드하지 않습니다. ZIP 파일 하나만 올리거나 프로젝트 폴더 전체를 하위 폴더로 올리는 방식은 사용하지 않습니다.
2. 저장소의 Settings → Secrets and variables → Actions에 Repository secrets 두 개를 등록합니다.

| 이름 | 값 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather가 발급한 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 본인의 확인된 개인 대화 ID |

3. Actions에서 워크플로 실행 권한을 허용합니다. 이 워크플로는 `contents: write` 권한으로 `bot-state` 브랜치를 갱신합니다. 조직 정책이 쓰기를 막는 경우 그 저장소의 Actions 정책을 확인해야 합니다.
4. Actions → Industry reports to Telegram → Run workflow에서 `initialize_only=true`로 한 번 실행합니다. 이 실행은 공개 PDF 다운로드를 검사한 뒤 현재 목록을 기준점으로 저장하고 PDF는 보내지 않습니다. 개별 원문 접속 검사 실패는 로그에 남기며 기준점 저장은 계속 진행합니다.
5. 성공 로그와 `bot-state` 브랜치가 생긴 것을 확인합니다. 이후 매일 예약 실행이 새 등록분을 처리합니다.

수동으로 실제 수집·발송하려면 Actions → **Industry reports to Telegram** → **Run workflow**에서 브랜치를 `main`으로 두고 **Record the starting point without sending reports**를 끕니다(`initialize_only=false`). 수동 실행은 한국시간 어느 시각이든 가능합니다. 초기화 옵션을 켜면 시각에 관계없이 기준점만 저장하고 발송하지 않습니다.

수동 실행도 하루 한 번 제한과 기존 PDF 중복 방지를 적용합니다. 같은 한국 날짜에 이미 수집 작업을 실행했다면 `already_run`으로 종료합니다. 오전에 수동 실행한 날의 오후 5시 예약 실행도 다시 발송하지 않습니다. 표준 실행기를 유지하며 유료 실행기나 유료 AI는 별도 동의 없이 켜지 않습니다.

## 확인할 상태

현재 분류 정책은 `us-industry-pages10-v3`입니다. 다음 실제 수집 때 과거 심층 표기 때문에 `review`였던 미발송 자료도 새 기준으로 재검사합니다. 이미 보낸 PDF와 최초 기준점으로 기록한 과거 자료는 재발송하지 않으며 기존 `bot-state`를 초기화하지 않습니다.

`initialized`는 초기 기준점 저장, `complete`는 수집·검사 완료, `partial`은 일부 수집·전송 문제, `failed`는 실행 실패, `already_run`은 그날 이미 실행한 상태입니다. `outside_window`는 수집 전에 실행 시간 조건으로 종료한 상태로, 새 보고서 0건을 확인한 결과가 아닙니다. 명시적인 GitHub 수동 발송에는 이 시간 제한을 적용하지 않습니다. 수집이 완료돼도 조건에 맞는 새 리포트가 없으면 텔레그램 알림은 없습니다.

GitHub의 실행 중단이나 네트워크 실패가 있으면 Actions 실행 결과를 확인해야 합니다. 초기화가 성공해도 개별 원문 다운로드 검사 로그는 함께 확인합니다. 2026-10-27 전용 공개 저장소 배포, Secrets 연결, 10개 출처 961건의 기준점 저장과 상태 복원·재저장을 확인했습니다. 실제 텔레그램 PDF 첨부는 앞선 연결 시험에서 검증했습니다. 첫 실제 예약 실행은 2026-10-27 한국시간 오후 5시 예정으로, 아직 결과를 확인하기 전입니다.

## 공개 채널 접근 검사

Actions의 **Verify public channel PDFs**는 텔레그램 Secrets 없이 공개 목록·PDF 전체 다운로드·발행사만 검사합니다. 결과는 실행 요약과 `public-channel-retrieval-check` 아티팩트의 JSON에서 확인합니다. 일부 경로가 실패하면 실패 상태로 남으며 운영 발송 시간을 변경하지 않습니다.

채널을 추가할 때는 원문 검사 후 `initialize_only=true`를 실행합니다. 이미 초기화된 출처의 기준점과 전송 이력은 유지하고, 새 출처의 기존 게시물만 기준점에 추가합니다. 텔레그램에만 있는 파일은 Bot API로 채널의 과거 파일을 읽을 수 없어 이 수집 방식에 포함하지 않습니다.

## 공식 문서

- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
