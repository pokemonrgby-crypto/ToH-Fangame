// /public/js/api/ai.js
// BYOK: localStorage('toh_byok') 에 저장된 Gemini API 키 사용 (절대 서버에 저장하지 않음)
const GEM_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

function getKey(){
  return localStorage.getItem('toh_byok') || '';
}

export function setByok(k){
  localStorage.setItem('toh_byok', (k||'').trim());
}

// 공통 호출
async function callGemini(model, systemText, userText){
  const key = getKey();
  if(!key) throw new Error('Gemini API Key(BYOK)가 필요해.');
  const url = `${GEM_ENDPOINT}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role:"user", parts:[{text: (systemText?(`[SYSTEM]\n${systemText}\n\n`):'') + userText }] }],
    generationConfig: { temperature: 0.9 }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok){ const t = await res.text(); throw new Error(`Gemini 호출 실패: ${res.status} ${t}`); }
  const json = await res.json();
  const out = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return out;
}

// 저가 스케치(3안) → 내부 랜덤 1안 채택
export async function genSketch({worldDetailSites, participants, items, relationNote}){
  const sys = `너는 TRPG 조우 스케치러. JSON만 출력해.
- 장소는 입력된 sites 중에서 하나를 id로 선택해야 한다.
- 3안 생성 후 내부 랜덤으로 하나를 고를 것이므로, 각 안의 톤/디테일은 살짝씩 달라야 한다.
- 출력 스키마:
{ "options":[
  {"where":{"world_id":"...","site_id":"...","why":"..."},
   "what":["...","...","...","..."],
   "result_hint":{"verdict":["win","loss","draw","mutual"],"gains":["..."],"losses":["..."]}},
  ...
] }`;
  const usr = `sites(JSON): ${JSON.stringify(worldDetailSites).slice(0,4000)}
participants(desc_soft): ${JSON.stringify(participants).slice(0,2000)}
items(simple): ${JSON.stringify(items||[])}
relation_note(optional): ${relationNote||''}`;
  const text = await callGemini('gemini-1.5-flash', sys, usr);
  return text;
}

// 고가 정제(최종 서사)
export async function refineNarrative({sketchOne, worldIntro}){
  const sys = `너는 서사 편집자. 아래 스케치를 짧고 선명한 최종 서사로 다듬어라.
- 어디서/왜: 2문장
- 무슨 일이 있었나: 4~8문장 (스킬/아이템 "등장 타이밍"만 콕 집어)
- 결과: verdict, gains[], losses[]를 JSON으로 첨부
- 출력 포맷:
{ "where":"...", "what":"...", "result":{"verdict":"win|loss|draw|mutual","gains":[],"losses":[]} }`;
  const usr = `world_intro: ${worldIntro}
sketch_selected: ${JSON.stringify(sketchOne).slice(0,4000)}`;
  const text = await callGemini('gemini-1.5-pro', sys, usr);
  return text;
}

// 스킬 리롤(4개) — desc_raw + desc_soft 동시 생성
export async function rerollSkills({name, worldName, info}){
  const sys = `캐릭터의 능력 4개를 제안해라.
제약:
- 각 능력 이름 ≤ 20자
- 각 설명 desc_raw ≤ 100자, 4문장 이하
- desc_soft(완곡화)는 절대어를 피해서 "대부분/흔히/짧게" 같은 톤으로 누그러뜨린 버전
출력:
{"abilities":[{"name":"","desc_raw":"","desc_soft":""}, ... (x4)]}`;
  const usr = `name:${name}\nworld:${worldName}\ninfo(≤500자):${info}`;
  const text = await callGemini('gemini-1.5-flash', sys, usr);
  return text;
}

// 에피소드(본문+요약) — 요약은 리롤용으로만 별도 호출 가능
export async function genEpisode({seedNote, povName}){
  const sys = `개인 관점 에피소드를 작성.
제약: 본문 ≤ 500자, 25문장 이하. 이후 한 줄 요약도 생성.
출력: {"episode":"...", "summary":"..."}`;
  const usr = `seed:${seedNote||''}\npov:${povName||''}`;
  const text = await callGemini('gemini-1.5-pro', sys, usr);
  return text;
}
