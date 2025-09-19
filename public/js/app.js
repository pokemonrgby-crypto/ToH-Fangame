// /public/js/app.js (기존 내용)
import { auth, db, fx } from './api/firebase.js';
import { fetchWorlds, App } from './api/store.js';
import { ensureUserDoc } from './api/user.js';
import { routeOnce, highlightTab } from './router.js';
import { showToast } from './ui/toast.js';
import { ensureAdmin } from './api/admin.js';
import { showMailbox } from './tabs/mail.js';
// [추가] 서비스 점검 관련 함수를 가져옵니다.
import { getMaintenanceStatus, toggleMaintenanceOverlay } from './api/maintenance.js';


// firebase-auth 모듈을 미리 import 합니다.
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, GoogleAuthProvider, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';

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

  btnMail.onclick = null; // a 태그의 기본 동작을 위해 JS 클릭 이벤트를 제거합니다.
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

  // [수정 시작] 2. 인증 상태와 서비스 점검 상태를 동시에 확인합니다.
  onAuthStateChanged(auth, async (user) => {
    App.state.user = user || null;
    toggleAuthButton(!!user);

    // [추가] 서비스 점검 상태와 관리자 여부를 확인합니다.
    const [{ isMaintenance, message }, isAdmin] = await Promise.all([
      getMaintenanceStatus(),
      ensureAdmin() // ensureAdmin은 내부적으로 user 상태를 사용합니다.
    ]);

    // [추가] 점검 모드가 켜져 있고, 현재 사용자가 관리자가 아닐 경우
    if (isMaintenance && !isAdmin) {
      // 모든 UI를 덮는 점검 화면을 표시하고, 앱의 나머지 로직 실행을 중단합니다.
      toggleMaintenanceOverlay(true, message);
      teardownMailbox(); // 혹시 모를 기능들을 비활성화합니다.
      // 관리자 탭 등도 숨깁니다.
      ['nav-logs', 'nav-manage'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      return; // 여기서 함수 실행을 중단
    }

    // [추가] 점검 모드가 아니거나 관리자일 경우, 점검 화면을 숨깁니다.
    toggleMaintenanceOverlay(false);

    if (user) {
      console.log('✅ Auth state confirmed. User:', user.uid);
      try {
        await ensureUserDoc();
        setupMailbox(user);
      } catch (e) {
        console.warn('[ensureUserDoc] 실패', e);
      }
    } else {
      console.log('❌ No user is signed in.');
      teardownMailbox();
    }

    const adminChip = document.getElementById('adminChip');
    if (adminChip) {
      adminChip.style.display = isAdmin ? 'inline-block' : 'none';
    }
    ['nav-logs','nav-manage'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isAdmin ? '' : 'none';
    });

    // 3. ✅ 인증 및 점검 상태가 확정된 후에만 라우팅을 시작합니다.
    routeOnce();
    highlightTab();
  });
  // [수정 끝]

  // 4. 해시 변경 이벤트 리스너와 인증 버튼을 연결합니다.
  window.addEventListener('hashchange', () => { routeOnce(); highlightTab(); });
  wireAuthButton();
}

// 앱 부팅 시작!
boot();

// ===== helpers =====
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
