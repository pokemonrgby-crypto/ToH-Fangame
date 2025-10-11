// /public/js/tabs/rankings_encounter.js

// [수정] 필요한 함수들을 import 합니다.
import { db, fx } from '../api/firebase.js';
import { getRecentEncounterComments } from '../api/store.js';
import { prettyTime } from '../ui/utils.js';


const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/**
 * 조우 랭킹 탭 렌더링 (캐릭터 별점 기반)
 */
export async function showEncounterRankings(root) {
    root.innerHTML = `<div class="spin-center"></div>`;
    try {
        const q = fx.query(
            fx.collection(db, 'char_encounter_stats'),
            fx.orderBy('ratingCount', 'desc'),
            fx.limit(100)
        );
        const snapshot = await fx.getDocs(q);
        const stats = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 평균 평점 계산 및 내림차순 정렬
        stats.forEach(s => {
            s.avgRating = s.ratingCount > 0 ? (s.totalRating / s.ratingCount) : 0;
        });
        stats.sort((a, b) => b.avgRating - a.avgRating);
        
        // 캐릭터 정보 병렬 조회
        const charSnaps = await Promise.all(stats.map(s => fx.getDoc(fx.doc(db, 'chars', s.id))));
        const rankedChars = stats.map((s, i) => {
            const charData = charSnaps[i].exists() ? charSnaps[i].data() : { name: '(알 수 없음)', thumb_url: '' };
            return { ...s, ...charData };
        });

        root.innerHTML = `
            <div class="col" style="gap: 12px;">
                ${rankedChars.length > 0 ? rankedChars.map((char, i) => rankingCard(char, i)).join('') : '<div class="kv-card text-dim">아직 랭킹 데이터가 없습니다.</div>'}
            </div>
        `;

    } catch (e) {
        root.innerHTML = `<div class="kv-card error">랭킹을 불러오는 중 오류가 발생했습니다: ${e.message}</div>`;
    }
}

function rankingCard(char, index) {
    return `
        <a href="#/char/${char.id}" class="kv-card" style="text-decoration:none; color:inherit;">
            <div class="row" style="align-items:center; gap:12px;">
                <span style="font-weight:bold; font-size:1.2em; width:30px; text-align:center;">${index + 1}</span>
                <img src="${esc(char.thumb_url)}" class="avatar-sm" style="width:48px; height:48px; border-radius:8px;">
                <div style="flex:1;">
                    <b style="font-size:1.1em;">${esc(char.name)}</b>
                    <div class="text-dim" style="font-size:12px;">${char.world_id || '알 수 없는 세계'}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:1.2em;">⭐ <b>${(char.avgRating || 0).toFixed(2)}</b></div>
                    <div class="text-dim" style="font-size:12px;">(${char.ratingCount}개의 평가)</div>
                </div>
            </div>
        </a>
    `;
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
            fx.orderBy('simulated'), // 복합 색인 필요: (simulated asc, createdAt desc)
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

    } catch (e) {
        root.innerHTML = `<div class="kv-card error">로그를 불러오는 중 오류가 발생했습니다: ${e.message}</div>`;
    }
}

function logCard(log) {
    const charA = log.a_snapshot;
    const charB = log.b_snapshot;
    const avgRating = (log.ratingCount > 0) ? (log.avgRating || 0).toFixed(2) : '-';
    return `
        <a href="#/encounter-log/${log.id}" class="kv-card" style="text-decoration:none; color:inherit;">
            <div class="row" style="justify-content:space-between; align-items:flex-start;">
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:bold; font-size:1.1em; margin-bottom:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(log.title)}</div>
                    <div class="row" style="gap:10px; align-items:center;">
                        <img src="${esc(charA.thumb_url)}" class="avatar-sm" title="${esc(charA.name)}">
                        <span>vs</span>
                        <img src="${esc(charB.thumb_url)}" class="avatar-sm" title="${esc(charB.name)}">
                    </div>
                </div>
                <div style="text-align:right; flex-shrink:0; margin-left:12px;">
                    <div class="chip">${new Date(log.createdAt.seconds * 1000).toLocaleDateString()}</div>
                    <div style="margin-top:8px;">⭐ <b>${avgRating}</b> (${log.ratingCount || 0})</div>
                </div>
            </div>
        </a>
    `;
}

/**
 * [신규] 최근 댓글 탭 렌더링
 */
export async function showRecentComments(root) {
    root.innerHTML = `<div class="spin-center"></div>`;
    try {
        const comments = await getRecentEncounterComments(50);

        root.innerHTML = `
            <div class="col" style="gap: 12px;">
                ${comments.length > 0 ? comments.map(commentCard).join('') : '<div class="kv-card text-dim">최근 댓글이 없습니다.</div>'}
            </div>
        `;

    } catch (e) {
        root.innerHTML = `<div class="kv-card error">댓글을 불러오는 중 오류가 발생했습니다: ${e.message}</div>`;
        console.error(e);
    }
}

/**
 * [신규] 댓글 카드 UI 템플릿
 * @param {object} comment - 댓글 데이터 객체
 * @returns {string} HTML 문자열
 */
function commentCard(comment) {
    // Firestore Timestamp 객체를 Date 객체로 변환하여 prettyTime 함수에 전달
    const createdAtDate = comment.createdAt?.toDate ? comment.createdAt.toDate() : new Date();

    return `
        <a href="#/encounter-log/${comment.logId}" class="kv-card" style="text-decoration:none; color:inherit;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: bold; margin-bottom: 4px;">${esc(comment.author)}</div>
                    <p style="margin: 0 0 8px; font-size: 1.1em; line-height: 1.5;">${esc(comment.text)}</p>
                    <div class="text-dim" style="font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        └ 원본: ${esc(comment.logTitle)}
                    </div>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                    <div class="chip">${prettyTime(createdAtDate)}</div>
                    ${comment.rating ? `<div style="margin-top: 8px;">⭐ <b>${Number(comment.rating).toFixed(1)}</b></div>` : ''}
                </div>
            </div>
        </a>
    `;
}
