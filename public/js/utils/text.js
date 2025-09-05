export function countChars(s){ return (s||'').length; }
export function countSentences(s){
  if(!s) return 0;
  return (s.trim().match(/[\.!?]\s|\n|$/g)||[]).length;
}
export function withinLimits({name, info, narrative, summary, abilities}){
  const okName = countChars(name) <= 20;
  const okInfo = countChars(info) <= 500;
  const okNar  = countChars(narrative||'') <= 1000 && countSentences(narrative||'') <= 20;
  const okSum  = countChars(summary||'')   <= 200 && countSentences(summary||'')   <= 8;
  const okAb   = (abilities||[]).length===4 && abilities.every(a=>(
    countChars(a.name)<=20 && countChars(a.desc_raw||a.desc||'')<=100 && countSentences(a.desc_raw||a.desc||'')<=4
  ));
  return okName && okInfo && okNar && okSum && okAb;
}
