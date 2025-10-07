// /public/js/router.js
// 기존 파일 전체를 아래 코드로 교체하세요.

export const routes = {
  '#/home': () => import('./tabs/home.js').then(m => (m.showHome || m.default)()),
  '#/adventure': () => import('./tabs/adventure.js').then(m => (m.showAdventure || m.default)()),
  '#/rankings': () => import('./tabs/rankings.js').then(m => (m.showRankings || m.default)()),
  '#/friends': () => import('./tabs/friends.js').then(m => (m.showFriends || m.default)()),
  '#/me': () => import('./tabs/me.js').then(m => (m.showMe || m.default)()),
  '#/relations': () => import('./tabs/relations.js').then(m => (m.showRelations || m.default)()),
  '#/char': () => import('./tabs/char.js').then(m => (m.showCharDetail || m.showChar || m.default)()),
  '#/create': () => import('./tabs/create.js').then(m => (m.showCreate || m.default)()),
  '#/battle': () => import('./tabs/battle.js').then(m => (m.showBattle || m.default)()),
  '#/encounter': () => import('./tabs/encounter.js').then(m => (m.showEncounter || m.default)()),
  '#/explore-battle': () => import('./tabs/explore_battle.js').then(m => (m.showExploreBattle || m.default)()),
  '#/explore-run': () => import('./tabs/explore_run.js').then(m => (m.showExploreRun || m.default)()),
  '#/battlelog': () => import('./tabs/battlelog.js').then(m => (m.showBattleLog || m.default)()),
  '#/encounter-log': () => import('./tabs/encounterlog.js').then(m => (m.showEncounterLog || m.default)()),
  '#/explorelog': () => import('./tabs/explorelog.js').then(m => (m.showExploreLog || m.default)()),
  '#/plaza': () => import('./tabs/plaza.js').then(m => (m.showPlaza || m.default)()),
  '#/economy': () => import('./tabs/economy.js').then(m => (m.default)()),
  '#/economy/shop':  () => import('./tabs/economy.js').then(m => (m.default)()),
  '#/economy/stock': () => import('./tabs/economy.js').then(m => (m.default)()),
  '#/economy/mystocks': () => import('./tabs/economy.js').then(m => (m.default)()),
  '#/economy/estate':() => import('./tabs/economy.js').then(m => (m.default)()),
  '#/market': () => import('./tabs/market.js').then(m => (m.showMarket || m.default)()),
  '#/guild': () => import('./tabs/guild.js').then(m => (m.showGuild || m.default)()),
  '#/logs': () => import('./tabs/logs.js').then(m => (m.showLogs || m.default)()),
  '#/mail': () => import('./tabs/mail.js').then(m => (m.showMailbox || m.default)()),
  '#/manage': () => import('./tabs/manage.js').then(m => (m.showManage || m.default)()),
  '#/worldmap': () => import('./tabs/worldmap.js').then(m => m.showWorldMap()),
  '#/land': () => import('./tabs/land_detail.js').then(m => m.showLandDetail()),
  '#/land-management': () => import('./tabs/land_management.js').then(m => m.showLandManagement()),
  '#/raid': () => import('./tabs/raid.js').then(m => m.showRaid()),
  '#/raidlog': () => import('./tabs/raidlog.js').then(m => m.showRaidLog()),
};

export function highlightTab() {
  const hash = location.hash || '#/home';
  const mainRoute = '#/' + hash.split('/')[1];
  let tabName = mainRoute.substring(2);

  // [수정] /char/ID/xxx 경로에서 tabName이 'char'로 시작하면 'char'로 통일
  if (tabName.startsWith('char')) tabName = 'char';
  
  if (['economy', 'market', 'worldmap', 'land', 'land-management'].includes(tabName)) {
    tabName = 'plaza';
  }

  document.querySelectorAll('.bottombar a').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tabName);
  });
}

export function router() {
  // 기존 뷰의 클린업 함수가 있다면 호출 (메모리 누수 방지)
  const view = document.getElementById('view');
  if (view && view.__cleanup) {
    try { view.__cleanup(); } catch(e) { console.error('View cleanup failed:', e); }
    delete view.__cleanup;
  }
  document.querySelector('.fixed-actions')?.remove();
  
  const hash = location.hash || '#/home';
  
  const dynamicRoutes = [
    '#/char/', '#/relations/', '#/explore-run/', '#/explore-battle/',
    '#/battlelog/', '#/encounter-log/', '#/explorelog/',
    '#/guild/', '#/market', '#/worldmap', '#/land/', '#/raidlog/', '#/land-management/'
  ];
  
  const matchedRoute = dynamicRoutes.find(route => hash.startsWith(route));

  if (matchedRoute) {
    const key = matchedRoute.endsWith('/') ? matchedRoute.slice(0, -1) : matchedRoute;
    
    // [수정] /char/ID/growth/create 등 상세 경로를 처리하기 위해 #/char로 매핑
    const charSubMatch = hash.match(/^#\/char\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (charSubMatch && ['bio', 'loadout', 'growth', 'history', 'narrative'].includes(charSubMatch[2])) {
        const handler = routes['#/char'];
        if (handler) {
            handler();
            return;
        }
    }
    
    const handler = routes[key];
    if (handler) {
      handler();
      return;
    }
  }

  const handler = routes[hash] || routes['#/home'];
  if (handler) {
    handler();
  }
}

// 앱 시작 시 한 번만 호출
export function routeOnce() { 
  router(); 
}
