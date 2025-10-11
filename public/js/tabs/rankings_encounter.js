// /public/js/tabs/rankings_encounter.js
import { db, fx, auth, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';

const call = (name) => httpsCallable(func, name);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/**
 * 조우 랭킹 탭 렌더링
 */
export async function showEncounterRankings(root) {
    root.innerHTML = `<div class="kv-card text-dim">조우 랭킹은 현재 준비 중입니다.</div>`;
    // TODO: 집계된 캐릭터 별점 랭킹을 불러와 표시하는 로직 구현
}

/**
 * 최근 조우 로그 탭 렌더링
 */
export async function showRecentEncounters(root) {
    root.innerHTML = `<div class="spin-center"></div>`;

    try {
        const q = fx.query(
            fx.collection(db, 'encounter_logs'),
            fx.where('simulated', '!=', true),
            fx.orderBy('simulated', 'asc'), // 색인 필요
            fx.orderBy('createdAt', 'desc'),
            fx.limit(100)
        );
        const snapshot = await fx.getDocs(q);
        const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        root.innerHTML = `
            <div class="col" style="gap: 12px;">
                ${logs.length > 0 ? logs.map(logCard).join('') : '<div class="kv-card text-dim">최근 조우 기록이 없습니다.</div>'}
            </div>
        `;
        attachLogCardEvents(root);

    } catch (e) {
        console.error("Error fetching recent encounters:", e);
        root.innerHTML = `<div class="kv-card error">로그를 불러오는 중 오류가 발생했습니다: ${e.message}</div>`;
    }
}

function logCard(log) {
    const charA = log.a_snapshot;
    const charB = log.b_snapshot;
    return `
        <div class="kv-card" data-log-id="${log.id}">
            <a href="#/encounter-log/${log.id}" style="text-decoration:none; color:inherit;">
                <div class="row" style="justify-content:space-between; align-items:flex-start;">
                    <div class="col" style="gap:8px;">
                        <div class="row" style="gap:10px; align-items:center;">
                            <img src="${esc(charA.thumb_url)}" class="avatar-sm">
                            <b>${esc(charA.name)}</b>
                        </div>
                        <div class="row" style="gap:10px; align-items:center;">
                            <img src="${esc(charB.thumb_url)}" class="avatar-sm">
                            <b>${esc(charB.name)}</b>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div class="chip">${new Date(log.createdAt.seconds * 1000).toLocaleDateString()}</div>
                        <div style="font-weight:bold; margin-top:8px;">${esc(log.title)}</div>
                    </div>
                </div>
            </a>
            <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px; border-top:1px solid var(--bd); padding-top:12px;">
                <button class="btn small ghost btn-rate" data-log-id="${log.id}" data-char-a-id="${log.a_char.replace('chars/', '')}" data-char-b-id="${log.b_char.replace('chars/', '')}">⭐ 별점 주기</button>
                <button class="btn small ghost btn-comment" data-log-id="${log.id}">💬 댓글</button>
            </div>
        </div>
    `;
}

function attachLogCardEvents(root) {
    root.querySelectorAll('.btn-rate').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const logId = btn.dataset.logId;
            const charAId = btn.dataset.charAId;
            const charBId = btn.dataset.charBId;
            // TODO: 별점 부여 모달 열기
            showToast(`별점 기능 구현 중 (log: ${logId})`);
        };
    });

    root.querySelectorAll('.btn-comment').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const logId = btn.dataset.logId;
            // TODO: 댓글 보기/작성 모달 열기
            showToast(`댓글 기능 구현 중 (log: ${logId})`);
        };
    });
}
