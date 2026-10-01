# research-workspace-ipad

iPad와 갤럭시 폰에서 연구 저장소를 읽고 코멘트를 남기는 웹앱. 맥의 [research-workspace](https://github.com/sungmin-park-dev/research-workspace)가 꺼져 있어도 GitHub만으로 동작한다.

- **이 저장소에는 연구 데이터가 없다.** 화면 코드만 있고, 연구 내용은 기기가 사용자의 GitHub 토큰으로 비공개 저장소에서 직접 받는다.
- **오프라인.** 받은 블록·일지·코멘트와 40 MB 이하 PDF는 기기(IndexedDB)에 보관된다. 화면 코드는 서비스 워커가 보관한다.
- **쓰기는 새 파일만.** 코멘트 하나가 `workbench/comments/inbox/<id>.md` 새 파일 하나가 된다. 토큰에 쓰기 권한이 있어도 앱은 기존 파일을 고치지 않는다 (GitHub contents API에 sha 없이 만들기만 요청하므로 기존 파일이면 거절된다). 인터넷이 없으면 기기에 쌓였다가 다음 동기화 때 올라간다.

## 설치

1. https://sungmin-park-dev.github.io/research-workspace-ipad/ 를 연다 (iPad는 Safari, 갤럭시는 Chrome).
2. iPad: 공유 › 홈 화면에 추가. 갤럭시: Chrome 메뉴(⋮) › 홈 화면에 추가 또는 앱 설치. (삼성 인터넷이면 메뉴 › 현재 페이지 추가 › 홈 화면)
3. [fine-grained 토큰](https://github.com/settings/personal-access-tokens/new)을 만든다.
   - Repository access: Only select repositories → 읽을 연구 저장소와 `research-library`
   - Permissions › Repository permissions › Contents: Read and write (코멘트 올리기용. 읽기만 하려면 Read-only)
   - 만료: 90일 권장
4. 앱의 설정에 토큰을 넣고 "저장하고 받기". 기기마다 토큰을 따로 만들면 하나를 잃어버려도 그것만 지우면 된다.

토큰은 그 기기 안에만 저장된다. 기기를 잃어버리면 GitHub에서 토큰을 지운다.

## 코멘트 형식

맥 앱의 코멘트 파일(`workbench/comments/<대상>.md`, research-workspace `apps/server/src/comments.ts`)과 같은 절 형식이다. inbox 파일은 그 대상의 한 코멘트짜리 파일이고, 숨은 줄 `<!-- rw-inbox: {"target": …} -->`이 대상을 적는다. 맥 앱이나 에이전트가 절을 대상 파일 끝에 옮겨 붙인 뒤 inbox 파일을 지운다. 대상 이름: 자료 PDF `paper-<파일 이름>`, 블록 `block-<id>`, 일지 `log-<날짜>`.

## 개발

```sh
pnpm install
pnpm dev        # http://localhost:5173/research-workspace-ipad/
pnpm test
pnpm type-check
pnpm build      # dist/ — main에 푸시하면 GitHub Actions가 Pages로 배포
```
