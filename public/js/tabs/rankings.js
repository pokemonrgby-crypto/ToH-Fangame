// /public/js/tabs/rankings.js
import { App, loadRankingsFromServer, restoreRankingCache } from '../api/store.js';
import { el } from '../ui/components.js';
// [추가] 조우 랭킹 관련 함수를 가져옵니다.
import { showEncounterRankings, showRecentEncounters, showRecentComments } from './rankings_encounter.js';
// 탭/캐시 상태
const State = {
  tab: 'weekly',     // 'weekly'|'total'|'elo'|'elo_low'|'encounter'
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
    make('encounter', '🌟조우')
  );
}

// 조우 하위 탭
function encounterSubTabs() {
    const make = (id, label) => el('button', {
        className: 'btn tab' + (State.subTab === id ? ' active' : ''),
        onclick: () => { State.subTab = id; showRankings(true); }
    }, label);
    return el('div', { className: 'row', style: 'gap:8px;margin:10px 0;' },
        make('ranking', '조우 랭킹'),
        make('recent', '최근 조우 로그'),
        make('comments', '최근 댓글') // <-- 추가된 부분
    );
}

function rankCard(c, i){
  const open = () => location.hash = `#/char/${c.id}`;

  const imgSrc = c.thumb_url || c.image_b64 || c.image_url || '';

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
  v.innerHTML = `<div class="container narrow"><div class="spin-center"></div></div>`;
  const container = el('div', { className: 'container narrow' });

  if (State.tab === 'encounter') {
      container.append(
          el('div', { className: 'title' }, '랭킹'),
          tabs(),
          encounterSubTabs(),
          el('div', { id: 'ranking-content' })
      );
      v.replaceChildren(container);
      
      const contentEl = document.getElementById('ranking-content');
      
      // [수정] 'comments' 탭이 선택되었을 때 showRecentComments 함수를 호출하는 로직을 추가합니다.
      if (State.subTab === 'ranking') {
          showEncounterRankings(contentEl);
      } else if (State.subTab === 'comments') {
          showRecentComments(contentEl); // <-- 추가된 부분
      } else {
          showRecentEncounters(contentEl);
      }
      return;
  }

  // --- 이하 기존 랭킹(주간, 누적, Elo) 표시 로직 ---
  const now = Date.now();
  const needReload = force || !App.rankings || (now - State.lastLoaded > STALE_MS);
  if (needReload) {
    try {
      await loadRankingsFromServer(50);
      State.lastLoaded = now;
    } catch (e) {
      console.error('[rankings] load error', e);
    }
  }

  const src = App.rankings || {weekly:[], total:[], elo:[], elo_low:[]};
  const list = State.tab==='weekly' ? (src.weekly||[])
             : State.tab==='total'  ? (src.total||[])
             : State.tab==='elo_low'? (src.elo_low||[])
             : (src.elo||[]);

  container.append(
    el('div',{className:'title'}, '랭킹'),
    tabs(),
    el('div',{className:'rank-grid'}, ...list.map((c,i)=>rankCard(c,i)))
  );
  v.replaceChildren(container);
}
