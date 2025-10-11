// /public/js/tabs/rankings.js
import { App, loadRankingsFromServer, restoreRankingCache } from '../api/store.js';
import { el } from '../ui/components.js';

// 탭/캐시 상태
const State = {
  tab: 'weekly',     // 'weekly'|'total'|'elo'
  subTab: 'recent',  // 'ranking'|'recent' (조우 탭 전용)  
  lastLoaded: 0,
};
const STALE_MS = 60 * 1000; // 60초 지나면 새로 불러오기

restoreRankingCache(); // App.rankings 복원 시도

function tabs(){
  const make=(id,label)=> el('button',{
    className:'btn tab'+(State.tab===id?' active':''), 
    onclick:()=>{ State.tab=id; showRankings(true); }
  }, label);
  return el('div',{className:'row', style:'gap:8px;margin-bottom:10px'},
    make('weekly','주간 좋아요'),
    make('total','누적 좋아요'),
    make('elo','Elo'),
    make('elo_low','Elo(역순)'),
    make('encounter', '🌟조우') // [추가]
  );
}

// [추가] 조우 하위 탭
function encounterSubTabs() {
    const make = (id, label) => el('button', {
        className: 'btn tab' + (State.subTab === id ? ' active' : ''),
        onclick: () => { State.subTab = id; showRankings(true); }
    }, label);
    return el('div', { className: 'row', style: 'gap:8px;margin:10px 0;' },
        make('ranking', '조우 랭킹'),
        make('recent', '최근 조우 로그')
    );
}

function rankCard(c, i){
  const open = () => location.hash = `#/char/${c.id}`;

  // ✅ KV/CDN 전환 대응: thumb_url 최우선, 없으면 b64, 마지막에 기존 url
  const imgSrc = c.thumb_url || c.image_b64 || c.image_url || '';

  // onerror 시 빈 틀로 교체(깨진 링크 대비)
  const thumb = imgSrc
    ? (() => {
        const img = el('img', { className: 'rank-thumb', src: imgSrc, alt: c.name || '' });
        img.onerror = () => {
          const ph = el('div', { className: 'rank-thumb noimg' });
          img.replaceWith(ph);
        };
        return img;
      })()
    : el('div', { className: 'rank-thumb' });

  const stat = (State.tab==='weekly') ? (c.likes_weekly||0)
            : (State.tab==='total')  ? (c.likes_total||0)
            : (c.elo||0);
  const statLabel = (State.tab==='elo' || State.tab==='elo_low') ? 'Elo' : '❤';

  return el('div',{className:'rank-card', onclick:open, style:'cursor:pointer'},
    el('div',{className:'rank-no'}, `#${i+1}`),
    thumb,
    el('div',{}, 
      el('div',{className:'rank-name'}, c.name),
      el('div',{className:'muted'}, c.world_id||'-')
    ),
    el('div',{className:'rank-stat'}, `${statLabel} ${stat}`)
  );
}

export async function showRankings(force=false){
  const v = document.getElementById('view');

  // 데이터가 없거나 오래됐거나 강제 갱신이면 서버에서 재로딩
  const now = Date.now();
  const needReload = force || !App.rankings || (now - State.lastLoaded > STALE_MS);
  if (needReload) {
    try {
      v.replaceChildren(el('div',{className:'muted'}, '랭킹 불러오는 중…'));
      // 서버에서 세 종류 모두 갱신하는 로더(프로젝트 기존 시그니처 유지)
      await loadRankingsFromServer(50);
      State.lastLoaded = now;
    } catch (e) {
      console.error('[rankings] load error', e);
    }
  }

  const src = App.rankings || {weekly:[], total:[], elo:[]};
  const list = State.tab==='weekly' ? (src.weekly||[])
             : State.tab==='total'  ? (src.total||[])
             : State.tab==='elo_low'? (src.elo_low||[])
             : (src.elo||[]);


  v.replaceChildren(
    el('div',{className:'container narrow'},
      el('div',{className:'title'}, '랭킹'),
      tabs(),
      el('div',{className:'rank-grid'}, ...list.map((c,i)=>rankCard(c,i)))
    )
  );
}
