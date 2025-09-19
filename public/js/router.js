// /public/js/router.js (최적화 후)

// 정적 import 구문을 모두 제거하고, 필요할 때 동적으로 모듈을 로드합니다.

export const routes = {
  // 각 경로에 접근 시 import() 함수를 호출하여 해당 모듈을 동적으로 불러옵니다.
  // 모듈이 로드되면, 그 안의 기본 export(default) 또는 특정 export(e.g., showHome)를 실행합니다.
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
  '#/explorelog': () => import('./tabs/explorelog.js').then(m => (m.showExploreLog || m.default)()),
  '#/plaza': () => import('./tabs/plaza.js').then(m => (m.showPlaza || m.default)()),
  '#/guild': () => import('./tabs/guild.js').then(m => (m.showGuild || m.default)()),
  '#/logs': () => import('./tabs/logs.js').then(m => (m.showLogs || m.default)()),
  '#/mail': () => import('./tabs/mail.js').then(m => (m.showMailbox || m.default)()),
  '#/manage': () => import('./tabs/manage.js').then(m => (m.showManage || m.default)()),
};

export function highlightTab() {
  const hash = location.hash || '#/home';
  // 동적 경로(#/char/123)도 올바르게 인식하도록 첫 번째 세그먼트만 사용합니다.
  const mainRoute = '#/' + hash.split('/')[1];
  const tabName = mainRoute.substring(2); // '#/' 제거

  document.querySelectorAll('.bottombar a').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tabName);
  });
}

export function router() {
  // 고정 액션바가 남아있으면 제거 (다른 화면 가릴 수 있음)
  document.querySelector('.fixed-actions')?.remove();
  
  const hash = location.hash || '#/home';
  
  // 동적으로 변화하는 상세 페이지 경로들을 먼저 확인합니다.
  // startsWith를 사용하여 /:id 와 같은 파라미터를 포함하는 경로를 처리합니다.
  const dynamicRoutes = [
    '#/char/', '#/relations/', '#/explore-run/', '#/explore-battle/', 
    '#/battlelog/', '#/explorelog/', '#/plaza', '#/guild/'
  ];
  
  // URL 해시가 동적 경로 패턴 중 하나로 시작하는지 찾습니다.
  const matchedRoute = dynamicRoutes.find(route => hash.startsWith(route));

  if (matchedRoute) {
    // '/plaza'와 같이 하위 경로가 없는 경우를 위해 끝의 '/'를 제거한 키를 사용합니다.
    const key = matchedRoute.endsWith('/') ? matchedRoute.slice(0, -1) : matchedRoute;
    const handler = routes[key];
    if (handler) {
      handler();
      return;
    }
  }

  // 정적 경로 또는 일치하는 동적 경로가 없는 경우
  // routes 객체에서 직접 일치하는 경로를 찾거나 기본 경로('#/home')를 사용합니다.
  const handler = routes[hash] || routes['#/home'];
  if (handler) {
    handler();
  }
}

// 앱 시작 시 한 번만 실행되도록 이름을 유지합니다.
export function routeOnce() { 
  router(); 
}
