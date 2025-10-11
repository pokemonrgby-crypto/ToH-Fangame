// /public/js/api/firebase.js (최종 수정본: serverTimestamp 직접 export 추가)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp, writeBatch,
  arrayUnion, runTransaction, increment, onSnapshot, collectionGroup
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
// import { initializeAppCheck, ReCaptchaV3Provider } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app-check.js';




// === 환경 분기: 호스트명으로 스테이징/운영 판단 ===
const IS_STAGE = location.hostname.includes('tale-of-heros-staging.web.app')
  || location.hostname.includes('tale-of-heros-staging.firebaseapp.com')
  || location.hostname.includes('--pr-'); // PR 미리보기도 스테이징 백엔드 사용

// === 운영(Prod) 설정 ===
const CONFIG_PROD = {
  apiKey: "AIzaSyA4ilV6tRpqZrkgXRTKdFP_YjAl3CmfYWo",
  authDomain: "tale-of-heros---fangame.firebaseapp.com",
  projectId: "tale-of-heros---fangame",
  storageBucket: "tale-of-heros---fangame.firebasestorage.app", 
  messagingSenderId: "648588906865",
  appId: "1:648588906865:web:eb4baf1c0ed9cdbc7ba6d0"
};

// === 스테이징(Stage) 설정 — 콘솔에서 복붙한 값으로 교체 ===
const CONFIG_STAGE = {
  apiKey: "AIzaSyAtXftthns2GdrbncB7L5VEowSwGT0ozQM",
  authDomain: "tale-of-heros-staging.firebaseapp.com",
  projectId: "tale-of-heros-staging",
  storageBucket: "tale-of-heros-staging.firebasestorage.app",
  messagingSenderId: "72932012253",
  appId: "1:72932012253:web:2cbe7684eee6183a46ab34"
};

// 최종 선택
const firebaseConfig = IS_STAGE ? CONFIG_STAGE : CONFIG_PROD;

// 표준 초기화 방식
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const func = getFunctions(app, 'us-central1');
// App Check (디버그/운영 공통) — 반드시 app 생성 "후"에!
// === App Check (선택) ===
// 1) 급하면 콘솔에서 '강제 적용' 해제 후 아래 블록은 잠시 주석 처리해도 됨.
// 2) 사용하려면: 콘솔 ▸ App Check ▸ 웹앱에 reCAPTCHA v3 등록 후 각 사이트 키를 여기에 넣어줘.
const APP_CHECK_SITE_KEY_PROD  = "PROD_RECAPTCHA_V3_SITE_KEY";   // 운영 키
const APP_CHECK_SITE_KEY_STAGE = "STAGE_RECAPTCHA_V3_SITE_KEY";  // 스테이징 키
const APP_CHECK_SITE_KEY = IS_STAGE ? APP_CHECK_SITE_KEY_STAGE : APP_CHECK_SITE_KEY_PROD;

// 미리보기(PR)에서는 디버그 토큰 허용(콘솔에서 한 번 등록 필요)
if (location.hostname.includes('--pr-')) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

/*try {
  if (APP_CHECK_SITE_KEY && APP_CHECK_SITE_KEY !== "PROD_RECAPTCHA_V3_SITE_KEY" && APP_CHECK_SITE_KEY !== "STAGE_RECAPTCHA_V3_SITE_KEY") {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } else {
    // 키 미설정 시 건너뛰기(로그인/파이어스토어는 동작하도록)
    console.warn('[AppCheck] site key not set for current env; skipping init.');
  }
} catch (e) {
  console.warn('[AppCheck] init failed, continue without it:', e);
}*/




// 콘솔/디버그 편의: 전역 바인딩
if (typeof window !== 'undefined') {
  window.__fx = func;                 // functions 인스턴스
  window.__httpsCallable = httpsCallable; // 호출기
}

// 편의를 위한 네임스페이스 export
export const fx = {
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp, writeBatch,
  arrayUnion, runTransaction, increment, onSnapshot, collectionGroup
};

export const sx = { ref: sRef, uploadBytes, getDownloadURL };
export * as ax from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';

// ⚠️ store.js와의 호환성을 위해 serverTimestamp를 직접 export합니다.
// 이 라인이 새로운 SyntaxError를 해결할 것입니다.
export { serverTimestamp };

// onCall 편의 래퍼
export function callFn(name, data) {
  return httpsCallable(func, name)(data).then(r => r.data);
}
if (typeof window !== 'undefined') {
  window.__callFn = callFn; // 콘솔에서 __callFn('함수명', {..})
}

