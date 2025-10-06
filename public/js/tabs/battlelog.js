// /public/js/tabs/battlelog.js
import { db, auth, fx } from '../api/firebase.js';
import { createOrUpdateRelation, getRelationBetween, getBattleLog } from '../api/store.js';
import { showToast } from '../ui/toast.js';

function parseLogId() {
  const h = location.hash || '';
  const m = h.match(/^#\/battlelog\/([^/]+)$/);
  return m ? m[1] : null;
}

function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c])); }

// [신규] 리치 텍스트 렌더러
const rarityColors = {
    normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
    legend: '#ffe9ad', myth: '#ffc9ce', aether: '#d6fff7'
};

function renderRichText(text = '') {
    return esc(text)
        .replace(/\[대사:(\d)\]「([^」]*)」\[\/대사\]/g, '<div class="rich-dialogue char-$1">「$2」</div>')
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (match, rarity, itemName) => {
            const color = rarityColors[rarity.toLowerCase()] || rarityColors.normal;
            return `<strong style="color: ${color}; font-weight: 800; text-shadow: 0 0 5px ${color}55;">${itemName}</strong>`;
        })
        .replace(/\[CUT\]/g, '<hr class="rich-cut">')
        .replace(/\[SFX:small\]([^\[]*)\[\/SFX\]/g, '<span class="rich-sfx-small">$1</span>')
        .replace(/\[SFX:big\]([^\[]*)\[\/SFX\]/g, '<strong class="rich-sfx-big">$1</strong>')
        .replace(/\n/g, '<br>');
}


export async function showBattleLog() {
  const root = document.getElementById('view');
  const logId = parseLogId();

  if (!logId) {
    root.innerHTML = `<section class="container narrow"><p>잘못된 경로입니다.</p></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center" style="margin-top: 40px;"></div></section>`;

  try {
    const log = await getBattleLog(logId);

    const attackerId = log.attacker_char.replace('chars/', '');
    const defenderId = log.defender_char.replace('chars/', '');

    const [attackerSnap, defenderSnap] = await Promise.all([
      fx.getDoc(fx.doc(db, 'chars', attackerId)),
      fx.getDoc(fx.doc(db, 'chars', defenderId))
    ]);

    const attacker = attackerSnap.exists() ? { id: attackerId, ...attackerSnap.data() } : {id: attackerId, ...log.attacker_snapshot};
    const defender = defenderSnap.exists() ? { id: defenderId, ...defenderSnap.data() } : {id: defenderId, ...log.defender_snapshot};

    await render(root, log, attacker, defender);

  } catch (e) {
    console.error("Failed to load battle log:", e);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
  }
}

async function render(root, log, attacker, defender) {
    const currentUserId = auth.currentUser?.uid;
    const isOwnerOfAttacker = currentUserId && attacker.owner_uid === currentUserId;
    const isParty = isOwnerOfAttacker || (currentUserId && defender.owner_uid === currentUserId);

    const winnerIsAttacker = log.winner === 0;
    const winnerIsDefender = log.winner === 1;

    const characterCard = (char, isWinner, isLoser) => {
        let label = '';
        if (log.simulated) {
            label = '<span class="chip" style="background:#8b5cf6;color:white;font-weight:bold;">모의전</span>';
        } else if (isWinner) {
            label = '<span class="chip" style="background:#3b82f6;color:white;font-weight:bold;">승리</span>';
        } else if (isLoser) {
            label = '<span class="chip" style="background:#ef4444;color:white;font-weight:bold;">패배</span>';
        }

        return `
            <a href="#/char/${char.id}" class="battle-result-card">
                <img src="${esc(char.thumb_url || '')}" onerror="this.style.display='none'" class="avatar">
                <div class="name">${esc(char.name)}</div>
                <div class="label">${label}</div>
            </a>
        `;
    };
    
    let topButtonHtml = isOwnerOfAttacker
        ? `<a href="#/battle" class="btn" style="text-decoration: none;">다시 배틀하기</a>`
        : '<button class="btn ghost" onclick="history.back()">이전으로 돌아가기</button>';
    
    root.innerHTML = `
      <style>
        .battle-result-card { text-decoration: none; color: inherit; display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .battle-result-card .avatar { width: 120px; height: 120px; object-fit: cover; border-radius: 12px; border: 3px solid var(--border-color); }
        .battle-result-card .name { font-weight: 800; font-size: 16px; }
        .rich-dialogue { margin: 1em 0; padding: 0.8em 1em; border-radius: 8px; background: rgba(255,255,255,0.05); }
        .rich-dialogue.char-0 { border-left: 3px solid #3b82f6; }
        .rich-dialogue.char-1 { border-left: 3px solid #ef4444; }
        .rich-cut { border: none; border-top: 1px dashed rgba(255,255,255,0.2); margin: 2em 0; }
        .rich-sfx-small { font-style: italic; color: #9aa4b2; }
        .rich-sfx-big { font-weight: 900; text-transform: uppercase; letter-spacing: 1px; }
      </style>
      <section class="container narrow">
        <div style="display:flex; justify-content: flex-end; margin-bottom: 16px;">
            ${topButtonHtml}
        </div>
        <div style="display: flex; justify-content: space-around; align-items: flex-start; margin: 24px 0;">
            <div style="--border-color: ${winnerIsAttacker ? '#3b82f6' : winnerIsDefender ? '#ef4444' : '#273247'}">
                ${characterCard(attacker, winnerIsAttacker, winnerIsDefender)}
            </div>
            <div style="font-size: 40px; font-weight: 900; color: #9aa5b1; align-self: center;">VS</div>
            <div style="--border-color: ${winnerIsDefender ? '#3b82f6' : winnerIsAttacker ? '#ef4444' : '#273247'}">
                ${characterCard(defender, winnerIsDefender, winnerIsAttacker)}
            </div>
        </div>
        <div class="card p16">
            <h1 style="font-size: 24px; font-weight: 900; text-align: center; margin-bottom: 16px;">${esc(log.title)}</h1>
            <div style="white-space: pre-wrap; line-height: 1.7; font-size: 15px; padding: 0 8px;">${renderRichText(log.content)}</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 24px; align-items: center;">
            ${!log.simulated ? `<button class="btn large ghost" id="btnRelate">관계 확인 중...</button>` : ''}
        </div>
      </section>
    `;

    const btnRelate = root.querySelector('#btnRelate');
    if (!btnRelate) return;
    
    if (!isParty) {
        btnRelate.style.display = 'none';
        return;
    }

    const existingRelation = await getRelationBetween(attacker.id, defender.id);

    btnRelate.textContent = existingRelation ? '관계 업데이트하기' : 'AI로 관계 생성하기';
    btnRelate.disabled = false;

    btnRelate.onclick = async () => {
        btnRelate.disabled = true;
        btnRelate.textContent = 'AI가 관계를 분석하는 중...';
        try {
            await createOrUpdateRelation({
                aCharId: attacker.id,
                bCharId: defender.id,
                battleLogId: log.id
            });
            showToast('관계가 갱신되었습니다!');
            btnRelate.textContent = '관계가 갱신됨';
        } catch(e) {
            console.error('관계 생성/업데이트 실패:', e);
            showToast(`오류: ${e.message}`);
            btnRelate.disabled = false;
            btnRelate.textContent = existingRelation ? '업데이트 재시도' : '생성 재시도';
        }
    };
}

export default showBattleLog;
