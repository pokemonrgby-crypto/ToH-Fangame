// /public/js/app.js

// (기존 import)
import { auth, db, fx } from './api/firebase.js';
import { fetchWorlds, App } from './api/store.js';
import { ensureUserDoc } from './api/user.js';
import { routeOnce, highlightTab } from './router.js';
import { showToast } from './ui/toast.js';
import { ensureAdmin } from './api/admin.js';
import { showMailbox } from './tabs/mail.js';
// [추가] 서비스 점검 관련 함수를 가져옵니다.
import { getMaintenanceStatus, toggleMaintenanceOverlay } from './api/maintenance.js';
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, GoogleAuthProvider, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js'; // ◀◀◀ 이 줄 추가



const appScript = document.querySelector('script[src*="/js/app.js"]');
const APP_VERSION = appScript ? (new URL(appScript.src)).searchParams.get('v') : null;

async function checkVersionAndReload() {
  if (!APP_VERSION) {
    console.warn('현재 앱 버전을 확인할 수 없습니다.');
    return;
  }

  try {
    // 2. Firestore 캐시를 무시하고 항상 서버에서 직접 최신 정보를 가져옵니다.
    const statusRef = fx.doc(db, 'configs/app_status');
    const statusSnap = await getDocFromServer(statusRef);

    if (statusSnap.exists()) {
      const latestVersion = statusSnap.data()?.latest_version;
      console.log(`버전 확인: (현재: ${APP_VERSION}, 최신: ${latestVersion})`);

      // 3. 버전이 다르면 사용자에게 알리고 새로고침을 강제합니다.
      if (latestVersion && latestVersion !== APP_VERSION) {
        console.log('새로운 버전이 감지되었습니다. 페이지를 새로고침합니다.');
        
        // 모든 UI를 덮는 오버레이 생성
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: fixed; inset: 0; z-index: 99999;
          background: rgba(10, 15, 25, 0.9); color: white;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          text-align: center; backdrop-filter: blur(8px);
        `;
        overlay.innerHTML = `
          <div style="font-size: 24px; font-weight: 800; margin-bottom: 16px;">🚀</div>
          <h2 style="margin:0 0 8px;">업데이트 안내</h2>
          <p>새로운 버전이 배포되었습니다.<br>잠시 후 앱을 다시 시작합니다.</p>
        `;
        document.body.appendChild(overlay);

        // 2초 후 강제 새로고침 (true를 전달하여 캐시 무시)
        setTimeout(() => {
          location.reload(true);
        }, 2000);

        // 더 이상 다른 작업이 실행되지 않도록 여기서 중단
        return; 
      }
    }
  } catch (error) {
    console.error('버전 확인 중 오류 발생:', error);
  }
}


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
  try {
    // [수정] 앱 시작 시 리디렉션 결과가 있는지 먼저 확인합니다.
    await getRedirectResult(auth).catch(error => {
      console.warn("getRedirectResult error on boot:", error);
    });
      
    // 1. 월드 데이터를 먼저 로드합니다.
    await fetchWorlds();

    // [추가] 앱 부팅 시 가장 먼저 버전을 확인합니다.
    await checkVersionAndReload();
    // [추가] 5분마다 주기적으로 버전을 다시 확인합니다.
    setInterval(checkVersionAndReload, 5 * 60 * 1000);

    // [수정 시작] 2. 인증 상태와 서비스 점검 상태를 동시에 확인합니다.
    onAuthStateChanged(auth, async (user) => {
      try { // [추가] onAuthStateChanged 콜백 내부도 try-catch로 감쌉니다.
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
      } catch (authError) {
        console.error("Authentication state change handler failed:", authError);
        document.body.innerHTML = `<div style="padding: 20px; text-align: center; color: white;">인증 처리 중 심각한 오류가 발생했습니다. 개발자 콘솔을 확인해주세요.</div>`;
      }
    });
    // [수정 끝]

    // 4. 해시 변경 이벤트 리스너와 인증 버튼을 연결합니다.
    window.addEventListener('hashchange', () => { routeOnce(); highlightTab(); });
    wireAuthButton();
  } catch (bootError) {
    // [추가] boot 함수 자체에서 오류 발생 시 화면에 표시합니다.
    console.error("Application boot failed:", bootError);
    document.body.innerHTML = `<div style="padding: 20px; text-align: center; color: white;">앱 초기화 중 심각한 오류가 발생했습니다. 개발자 콘솔을 확인해주세요.</div>`;
  }
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
