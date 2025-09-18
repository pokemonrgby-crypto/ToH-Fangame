// /public/js/router.js
import { showHome } from './tabs/home.js';
import { showAdventure } from './tabs/adventure.js';
import { showRankings } from './tabs/rankings.js';
import { showFriends } from './tabs/friends.js';
import { showMe } from './tabs/me.js';
import { showRelations } from './tabs/relations.js';
import { showCreate } from './tabs/create.js';
import { showBattle } from './tabs/battle.js';
import { showEncounter } from './tabs/encounter.js';
import showExploreRun from './tabs/explore_run.js';
import { showExploreBattle } from './tabs/explore_battle.js';
import { showBattleLog } from './tabs/battlelog.js';
import { showLogs } from './tabs/logs.js';
import { showMailbox } from './tabs/mail.js';
import { showManage } from './tabs/manage.js'; // 추가


export const routes = {
  '#/home': showHome,
  '#/adventure': showAdventure,
  '#/rankings': showRankings,
  '#/friends': showFriends,
  '#/me': showMe,
  '#/relations': showRelations,   // #/relations/:id
  // #/char/:id — 동적 import + 폴백
  '#/char': () => import('./tabs/char.js')
    .then(m => (m.showCharDetail ?? m.default ?? m.showChar)?.()
      ?? console.warn('[router] char.js: export가 없어 실행 못함')),
  '#/create': showCreate,
  '#/battle': showBattle,
  '#/encounter': showEncounter,
  '#/explore-battle': showExploreBattle,
  // 수정됨: 키(key)에 '#'를 추가하여 다른 라우트와 형식을 통일
  '#/explore-run': showExploreRun,
  '#/battlelog': showBattleLog, // 신규 추가
  '#/explorelog': () => import('./tabs/explorelog.js').then(m => (m.default ?? m.showExploreLog)?.()),
  '#/plaza': () => import('./tabs/plaza.js').then(m => (m.default ?? m.showPlaza)?.()),
  '#/guild': () => import('./tabs/guild.js').then(m => (m.default ?? m.showGuild)?.()),
  '#/logs': showLogs,
  '#/mail': showMailbox,
    '#/manage': showManage, 


  
};

export function highlightTab(){
  const hash = location.hash || '#/home';
  const tab = hash.split('/')[1];
  document.querySelectorAll('.bottombar a').forEach(a=>{
    a.classList.toggle('active', a.dataset.tab===tab);
  });
}

export function router(){
  // 고정 액션바가 남아있으면 제거 (다른 화면 가릴 수 있음)
  document.querySelector('.fixed-actions')?.remove();
  const hash = location.hash || '#/home';
  
  // 상세 페이지는 :id 필요
  if(hash.startsWith('#/char/')) return routes['#/char']();
  if(hash.startsWith('#/relations/')) return routes['#/relations']();
  // 수정됨: 불필요한 dynamic import를 제거하고 다른 동적 라우트와 동일한 패턴으로 변경
  if(hash.startsWith('#/explore-run/')) return routes['#/explore-run']();
  if(hash.startsWith('#/explore-battle/')) return routes['#/explore-battle']();
  if(hash.startsWith('#/battlelog/')) return routes['#/battlelog']();
  if(hash.startsWith('#/explorelog/')) return routes['#/explorelog']();
  if(hash.startsWith('#/plaza')) return routes['#/plaza']();
  if(hash.startsWith('#/guild/')) return routes['#/guild']();


  (routes[hash] || routes['#/home'])();
}

export function routeOnce(){ router(); }
