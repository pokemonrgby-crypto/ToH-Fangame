# Story System Documentation

## 개요 (Overview)

스토리 모드는 포켓몬 스타일의 RPG 게임 시스템으로, 월드맵 탐험, NPC 상호작용, 전투, 아이템 수집을 포함합니다.

시스템은 두 단계로 나뉩니다:
- **V2 (Skeleton)**: 수치와 구조를 프리롤로 생성
- **V3 (AI Flesh)**: AI가 이름과 설명을 생성

## 시스템 구조

### 월드맵 (World Map)

```
[마을] --필드1--필드2--필드3-- [거점] --필드4--필드5-- [최종거점]
  N1         F1    F2    F3        N2        F4    F5        N3
```

- **비-필드 (Non-Field)**: 마을, 거점, 랜드마크
  - 각각 5-10명의 NPC 보유
  - NPC 간 관계도 (1-5 척도)
  - 상점 시스템 (대장간, 일반상점, 의류점, 물약점)
  - 여관 (회복 가능)

- **필드 (Field)**: 몬스터 등장 지역
  - 비-필드 사이에 1-5개씩 생성
  - 난이도별 몬스터 출현
  - 이동 중 조우 이벤트 (18% 확률)

### 난이도 시스템 (Difficulty)

6단계 난이도가 있으며, 뒤로 갈수록 어려워집니다:

1. **easy** (쉬움)
2. **normal** (보통)
3. **hard** (어려움)
4. **vhard** (매우 어려움)
5. **legend** (전설)
6. **impossible** (불가능)

### 적 등급 (Enemy Grades)

5가지 등급이 있으며, 각각 다른 출현 확률을 가집니다:

1. **trash** (하급) - 가장 약함
2. **normal** (일반) - 보통
3. **elite** (정예) - 강함
4. **boss** (보스) - 매우 강함
5. **hidden** (히든) - 특수 (모든 난이도에서 1% 고정)

#### 출현 확률 예시 (easy 난이도)
- trash: 55%
- normal: 35%
- elite: 8%
- boss: 1%
- hidden: 1%

### 전투 시스템 (Battle System)

#### 플레이어 스탯
- **기본 HP**: 100
- **레벨당 HP 증가**: +5
- **최대 레벨**: 100
- **경험치 필드**: `story_exp` (일반 exp와 별도)

#### 적 스탯 (난이도별 × 등급별)
예시 - normal 난이도:
- trash: HP 30-45, 데미지 5-8
- normal: HP 40-65, 데미지 7-12
- elite: HP 90-130, 데미지 14-24
- boss: HP 160-240, 데미지 22-34
- hidden: HP 60-260, 데미지 10-36

#### 블록 시스템
플레이어가 적의 공격을 막을 확률:
- 기본 확률: 난이도 & 등급별로 다름
- 레벨 보정: 레벨당 1.5% 증가 (최소 -20%, 최대 +20%)

예시 - normal 난이도 기본 블록 확률:
- vs trash: 45%
- vs normal: 38%
- vs elite: 30%
- vs boss: 20%
- vs hidden: 18%

#### 스킬 효과 시스템

몬스터 스킬은 최대 3개의 효과를 가질 수 있습니다:

1. **DAMAGE_MULTIPLIER**: 데미지 배율 증가
   - 값: 1.2 ~ 2.0 배
   - 예: 다음 공격 데미지 1.5배

2. **DAMAGE_REDUCTION_SELF**: 받는 데미지 감소
   - 값: 1.1 ~ 1.8 배
   - 예: 다음 턴 받는 데미지 1.3배 감소

3. **MAX_HP_PERCENT_DAMAGE**: 최대 HP 비례 데미지
   - 값: 10 ~ 50%
   - 예: 플레이어 최대 HP의 25% 데미지

4. **HEAL_SELF**: 자신의 HP 회복
   - 값: 10 ~ 20%
   - 예: 자신의 최대 HP의 15% 회복

#### 트리거 시스템
효과는 즉시 또는 N턴 후 발동:
- 50% 확률로 지연 발동
- 지연 시: 1-5턴 후 발동

### 아이템 시스템 (Item System)

#### 레어리티 (Rarity)
7등급이 있으며, 높을수록 희귀합니다:

1. **normal** (일반)
2. **rare** (희귀)
3. **epic** (에픽, 표기는 "유니크")
4. **legend** (전설)
5. **aether** (에테르)
6. **alpha** (알파) - 히든에서만 드랍
7. **omega** (오메가) - 히든에서만 드랍

**중요**: alpha와 omega는 상점에서 절대 판매 불가!

#### 드랍 확률 (등급별)
예시 - boss 등급:
- normal: 20%
- rare: 34%
- epic: 26%
- legend: 18%
- aether: 2%
- alpha: 0%
- omega: 0%

hidden 등급만:
- normal: 10%
- rare: 22%
- epic: 28%
- legend: 26%
- aether: 12%
- alpha: 1%
- omega: 1%

#### 아이템 ID 형식
```
{charId}_{runId}_{serial}
```
예: `char123_r1634567890_001`

#### 아이템 속성
드랍 아이템:
- `isConsumable`: true (소모품)
- `uses`: 1 (1회 사용)
- `count`: 획득할 때마다 증가

상점 아이템:
- 무기/방어구: `isConsumable: false`, `uses: 1`
- 물약: `isConsumable: true`, `uses: 1`

#### 상점 종류
1. **blacksmith** (대장간): 무기, 방어구
2. **general** (일반상점): 잡화
3. **clothes** (의류점): 옷, 액세서리
4. **potion** (물약점): 포션, 소모품

### 화폐 시스템 (Currency)

- **story_coins**: 스토리 모드 전용 화폐
- 일반 게임 화폐와 별도로 관리

### NPC 시스템

#### NPC 관계도
각 NPC는 다른 NPC에 대해 관계 값을 가집니다:

1. **1 (매우 친함)**: 최고의 친구
2. **2 (친함)**: 우호적
3. **3 (보통)**: 중립
4. **4 (나쁨)**: 적대적 (개선 가능)
5. **5 (매우 나쁨)**: 극도로 적대적 (개선 불가)

#### 집단 우호도 (Group Attitude)
각 지역의 플레이어에 대한 전체적인 태도:

- **friendly** (우호적): 시작 마을 고정
- **neutral** (중립): 보통
- **hostile** (적대적): 경계 또는 공격적

## 프리롤 시스템 (Preroll System)

모든 랜덤 요소는 프리롤 링버퍼로 관리됩니다:

- **크기**: 50개의 d100 (1-100) 값
- **순환**: 50번째 사용 후 1번째로 순환
- **재현 가능**: 같은 시드로 같은 결과 생성

사용 예:
```javascript
const roll = nextRoll(); // 1-100 사이의 값
const npcCount = rangeMap(roll, 5, 10); // 5-10 사이로 매핑
```

## API 함수

### V2 함수 (Skeleton)

#### 1. createStoryPlanV2
월드맵 골격 생성

**입력**:
```javascript
{
  charId: "char123",
  world: {
    name: "에테르 대륙",
    intro: "마법이 가득한 신비로운 대륙",
    detail: "..."
  }
}
```

**출력**:
```javascript
{
  ok: true,
  runId: "r1634567890",
  nodes: [...],  // 모든 노드 (비-필드 + 필드)
  keyEvents: [...] // 5개의 주요 이벤트
}
```

#### 2. createStoryRulesV2
전투/드랍 규칙 생성

**입력**: `{ charId: "char123" }`

**출력**:
```javascript
{
  ok: true,
  rules: {
    ENEMY_GRADES: [...],
    DROP_RARITIES: [...],
    gradeProb: {...},  // 난이도별 출현 확률
    hpRanges: {...},   // HP 범위
    dmgRanges: {...},  // 데미지 범위
    blockBase: {...},  // 블록 기본 확률
    dropRates: {...},  // 드랍 확률
    // ...
  }
}
```

#### 3. materializeFieldStatsV2
필드별 통계를 하위 컬렉션에 저장

**입력**: `{ charId: "char123" }`

**출력**: `{ ok: true, count: 30 }` (생성된 문서 수)

#### 4. getRunSkeletonV2
현재 런 정보 조회 (디버그용)

#### 5. devTakeRollV2
프리롤 1개 테스트 (디버그용)

#### 6. getStoryRulesV2
규칙 조회 (디버그용)

#### 7. getFieldStatsV2
특정 필드 통계 조회 (디버그용)

### V3 함수 (AI Enrichment)

#### 1. enrichNPCsV3
NPC 이름, 배경, 대사 생성

**AI 호출**: 1회 (모든 비-필드의 모든 NPC)

#### 2. enrichMonstersByDifficultyV3
몬스터 이름, 설명, 스킬 생성

**입력**:
```javascript
{
  charId: "char123",
  difficulties: ["easy", "normal", "hard", "vhard", "legend", "impossible"]
}
```

**AI 호출**: 난이도당 1회 (총 6회)

**출력**:
```javascript
{
  ok: true,
  monstersByDifficulty: {
    "easy": {
      "difficulty": "easy",
      "monsters": [
        {
          "name": "슬라임",
          "description": "약한 젤리 몬스터",
          "grade": "trash",
          "skills": [
            {
              "name": "끈적끈적",
              "summary": "적을 늦추는 효과",
              "effects": [
                { "type": "DAMAGE_MULTIPLIER", "value": 1.2, "triggerTurn": 0 }
              ]
            }
          ]
        },
        // ... 8-12개 몬스터
      ]
    },
    // ... 다른 난이도
  }
}
```

#### 3. enrichShopsAndDropsV3
상점 아이템과 드랍 아이템 이름/설명 생성

**AI 호출**: 1회 (모든 상점 + 드랍 템플릿)

**출력**:
```javascript
{
  ok: true,
  shopInventories: {
    "N1": {
      "potion": [
        {
          "name": "체력 물약",
          "description": "HP를 50 회복합니다",
          "suggestedRarity": "normal",
          "isConsumable": true,
          "uses": 1,
          "price": 120,
          "effect": { "type": "HEAL_HP", "value": 50 }
        },
        // ... 3-6개 아이템
      ],
      "blacksmith": [...],
      // ... 다른 카테고리
    },
    // ... 다른 노드
  },
  dropLore: [
    { "name": "늑대 가죽", "description": "회색 늑대의 질긴 가죽" },
    // ... 12-16개 템플릿
  ]
}
```

## 개발자 콘솔 출력

모든 함수는 상세한 로그를 출력합니다:

### 예시 출력

```
[StoryV2] Starting story plan creation { charId: 'char123', worldName: '에테르 대륙' }
[StoryV2] Generated spine structure { spineCount: 5, difficulties: ['easy', 'easy', 'normal', 'hard', 'vhard'] }
[StoryV2] Non-field node 1 { npcCount: 7, groupAttitude: 'friendly', bias: -1 }
[StoryV2] Non-field node 2 { npcCount: 8, groupAttitude: 'neutral', bias: 0 }
[StoryV2] Creating field connections between non-field nodes { nonFieldCount: 5 }
[StoryV2] Connecting N1 to N2 with 3 field(s)
[StoryV2] Connecting N2 to N3 with 2 field(s)
...
[StoryV2] ✅ Story plan created successfully
┌────────────────┬─────────────┐
│                │   Value     │
├────────────────┼─────────────┤
│ Run ID         │ r1634567890 │
│ Total Nodes    │ 15          │
│ Field Nodes    │ 10          │
│ Non-Field Nodes│ 5           │
│ Key Events     │ 5           │
└────────────────┴─────────────┘
```

## 사용 순서

### 1단계: V2 실행
```javascript
// 1. 스토리 플랜 생성
await createStoryPlanV2({ charId, world });

// 2. 규칙 생성
await createStoryRulesV2({ charId });

// 3. 필드 통계 물리화
await materializeFieldStatsV2({ charId });
```

### 2단계: V3 실행
```javascript
// 1. NPC 이름/배경 생성
await enrichNPCsV3({ charId });

// 2. 몬스터 이름/스킬 생성
await enrichMonstersByDifficultyV3({ charId, difficulties });

// 3. 상점/드랍 아이템 생성
await enrichShopsAndDropsV3({ charId });
```

### 3단계: 게임 플레이
이제 플레이어는:
- 월드맵을 탐험할 수 있습니다
- NPC와 대화할 수 있습니다
- 필드에서 몬스터와 전투할 수 있습니다
- 상점에서 아이템을 구매할 수 있습니다
- 드랍 아이템을 수집할 수 있습니다

## 주의사항

1. **V2를 먼저 실행**: V3는 V2가 생성한 구조를 참조합니다
2. **alpha/omega 제한**: 상점에서 절대 판매하지 않습니다
3. **경험치 분리**: `story_exp`를 사용하며 일반 `exp`와 혼용 금지
4. **프리롤 순환**: 50개 사용 후 자동 순환됩니다
5. **AI 수치 금지**: AI는 name/description만 생성, 수치 변경 불가

## 파일 구조

```
functions/
├── storyV2.js          # V2 골격 시스템
├── storyV3.js          # V3 AI 생성 시스템
├── storyLogger.js      # 공용 로깅 유틸리티
└── STORY_SYSTEM.md     # 이 문서
```

## 개발 팁

### 디버깅
- `getRunSkeletonV2()`: 현재 런 상태 확인
- `devTakeRollV2()`: 프리롤 테스트
- `getFieldStatsV2()`: 필드 통계 확인

### 로그 레벨
- `info`: 주요 이벤트
- `debug`: 상세 정보 (프리롤 등)
- `warn`: 경고
- `error`: 오류

### 프리롤 디버깅
프리롤 값을 확인하려면:
```javascript
const roll = await devTakeRollV2({ charId });
console.log('Next roll:', roll);
```

## 향후 계획

현재 V2와 V3는 구조만 제공합니다. 다음 기능은 별도 구현 예정:

- [ ] 실제 배틀 로직 (턴제 전투)
- [ ] 아이템 사용 시스템
- [ ] 엔딩 시스템
- [ ] 저장/로드 기능
- [ ] 퀘스트 시스템 (아이템 수집, NPC 대화)

---

**작성일**: 2025-10-15  
**버전**: 1.0.0  
**작성자**: Story System Team
