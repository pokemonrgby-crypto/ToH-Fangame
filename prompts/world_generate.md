# World Generator (JSON only)
다음 요구를 따르세요.

## 목표
- 주어진 키워드/톤을 바탕으로 한 "세계관 프로필" JSON만 생성합니다.
- 설명/코드블록/주석 없이 **순수 JSON**만 반환합니다.

## 출력 스키마
{
  "name": string,
  "intro": string,                       // 한 줄 요약
  "detail": {
    "lore": string,                      // 세계관 배경 설명
    "sites": [                           // 유명 명소 목록(3~6개)
      { "id": string, "name": string, "description": string, "type": "city|dungeon|landmark|wild" }
    ],
    "orgs": [                            // 조직 목록(2~5개)
      { "id": string, "name": string, "description": string }
    ],
    "npcs": [                            // NPC 목록(3~6명)
      { "id": string, "name": string, "role": string, "description": string }
    ]
  }
}

## 제약
- 값은 한국어.
- id는 소문자-영문-숫자-하이픈만 사용.
- **반드시 유효 JSON**만 출력(코드펜스 금지).

## 입력
- 키워드: {{KEYWORD}}
