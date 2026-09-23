# OBS Karaoke MVP v0.1.0-alpha

2026-09-22: 보컬 / MR 분리 입력 업데이트

## 설치 / 업데이트

아래 `OBS-Karaoke-Setup.exe`를 내려받아 실행하세요. 기존 사용자도 앱을 완전히
종료한 뒤 설치기를 다시 실행하고 기존 설치 폴더를 선택하면 됩니다.
설치기는 앱 본체, Turbo 모델과 런타임을 준비하며 설치 후 분석은 로컬에서 실행됩니다.
이전 버전에는 자동 업데이트 기능이 없어 이번에는 설치기를 한 번 다시 실행해야
합니다. 그다음 패치부터 앱 실행 시 업데이트 알림이 나타납니다. 수락하면
설치 파일을 검증하고 앱을 닫은 뒤 같은 폴더에 자동 설치합니다. 변경 없는
모델·CUDA 파일은 다음 업데이트에서 로컬 설치본을 재사용합니다.
GitHub의 `Source code` ZIP은 개발용 소스이며 실행용 패키지가 아닙니다.

## 변경 사항

- 보컬 트랙과 MR 트랙을 각각 불러옵니다. 분석에는 보컬만 사용합니다.
- 보컬, MR, 자막이 공통 재생 시간을 사용합니다. 일시정지, 탐색, 재시작도 함께 적용됩니다.
- 보컬과 MR의 음량을 각각 조절할 수 있습니다.
- 가사 채우기 애니메이션을 켜거나 끌 수 있습니다. OBS 투명 오버레이 URL은 동일합니다.
- EXE 내부에서 조작하며 별도 브라우저나 OBS 창을 자동 실행하지 않습니다.
- 정상 종료와 강제 종료 시 앱 소속 프로세스가 남지 않도록 개선했습니다.
- 재실행하면 입력이 초기화됩니다. 모델 파일은 유지됩니다.
- 분석 실패 시 파형만으로 임시 타이밍을 자동 생성하지 않습니다.

두 트랙은 같은 버전의 음원을 분리한 파일이며 앞부분 무음과 시작점을 유지해야 합니다.
허밍, 효과음, 짧은 감탄사의 인식 정확도는 곡에 따라 다르며 수동 보정이 필요할 수 있습니다.

## English

Import separate vocal and instrumental tracks. Only the vocal is analyzed locally.
Both tracks share a playback clock with the transparent OBS lyric overlay.
Includes individual track volumes, a karaoke-fill toggle, and improved desktop
shutdown cleanup. Keep both stems aligned to the same original start time.

Re-run the installer once to enable future in-app update prompts. On later
updates, the app downloads and verifies the installer, then reopens after setup.

Download `OBS-Karaoke-Setup.exe` below. Close the existing app before reinstalling
into the same folder. Source archives are for development, not ready-to-run apps.
