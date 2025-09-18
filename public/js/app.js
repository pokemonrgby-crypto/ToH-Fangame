// /public/js/app.js (최종 수정본)
import { auth } from './api/firebase.js';
import { fetchWorlds, App } from './api/store.js';
import { ensureUserDoc } from './api/user.js';
import { routeOnce, highlightTab } from './router.js';
import { showToast } from './ui/toast.js';
import { ensureAdmin } from './api/admin.js';



// firebase-auth 모듈을 미리 import 합니다.
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, GoogleAuthProvider, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';

// /public/js/app.js

// --- Mailbox Logic ---
let mailUnsubscribe = null;

function setupMailbox(user) {
  const btnMail = document.getElementById('btnMail');
  const mailDot = document.getElementById('mail-dot');
  if (!btnMail || !mailDot) return;

  btnMail.style.display = 'block';

  // 안 읽은 메일 실시간 감지
  if (mailUnsubscribe) mailUnsubscribe(); // 이전 구독 해제
  const mailQuery = fx.query(
    fx.collection(db, 'mail', user.uid, 'msgs'),
    fx.where('read', '==', false),
    fx.limit(1)
  );
  mailUnsubscribe = fx.onSnapshot(mailQuery, (snapshot) => {
    mailDot.style.display = snapshot.empty ? 'none' : 'block';
  });

  // 이제 버튼이 a 태그이므로 onclick 핸들러는 필요 없습니다.
}

function teardownMailbox() {
    if (mailUnsubscribe) mailUnsubscribe();
    mailUnsubscribe = null;
    const btnMail = document.getElementById('btnMail');
    if(btnMail) btnMail.style.display = 'none';
}


async function boot() {
  // 1. 월드 데이터를 먼저 로드합니다.
  await fetchWorlds();

  // 2. 🔐 Firebase 인증 상태 감시자를 설정합니다.
  // 이 함수는 Firebase가 사용자의 로그인 상태를 완전히 파악했을 때,
  // 그리고 그 이후에 로그인/로그아웃 할 때마다 실행됩니다.
  onAuthStateChanged(auth, async (user) => {
    App.state.user = user || null;
    toggleAuthButton(!!user);
    
    if (user) {
      // ✅ 사용자가 로그인한 것이 "확실히" 확인된 상태!
      console.log('✅ Auth state confirmed. User:', user.uid);
      try {
        await ensureUserDoc(); // 유저 문서 생성/병합
      } catch (e) {
        console.warn('[ensureUserDoc] 실패', e);
      }
    } else {
      // ❌ 사용자가 로그아웃했거나, 로그인하지 않은 상태
      console.log('❌ No user is signed in.');
    }
      const ok = await ensureAdmin();
      ['nav-logs','nav-mail','nav-manage'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = ok ? '' : 'none';
    });



    // 3. ✅ 인증 상태가 확정된 후에만 라우팅을 시작합니다.
    // 이것이 모든 권한 문제의 핵심 해결책입니다.
    routeOnce(); 
    highlightTab();
  });

  // 4. 해시 변경 이벤트 리스너와 인증 버튼을 연결합니다.
  window.addEventListener('hashchange', () => { routeOnce(); highlightTab(); });
  wireAuthButton();
}

// 앱 부팅 시작!
boot();

// ===== helpers =====
// (onClickAuthButton, wireAuthButton, toggleAuthButton 함수는 변경사항 없습니다)
async function onClickAuthButton() {
  try {
    if (auth.currentUser) {
      await signOut(auth);
      showToast('로그아웃 완료');
      return;
    }
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (String(e?.code || '').includes('popup')) {
        await signInWithRedirect(auth, provider);
        return;
      }
      throw e;
    }
    showToast('로그인 완료');
  } catch (e) {
    console.error('[auth] error', e);
    showToast(auth.currentUser ? '로그아웃 실패' : '로그인 실패');
  } finally {
    try {
      await getRedirectResult(auth);
    } catch {}
  }
}

function wireAuthButton() {
  const btn = document.getElementById('btnAuth');
  if (!btn) return;
  btn.onclick = onClickAuthButton;
}

function toggleAuthButton(isLoggedIn) {
  const btn = document.getElementById('btnAuth');
  if (!btn) return;
  btn.textContent = isLoggedIn ? '로그아웃' : '구글 로그인';
  btn.title = isLoggedIn ? '현재 로그인됨' : '로그인이 필요해';
}
