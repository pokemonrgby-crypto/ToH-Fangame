// /public/js/api/firebase.js  (전체 교체)

// --- Firebase SDK v10+ modular ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc,
  collection, query, where, getDocs, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// !! 여기에 네 프로젝트 설정값 유지 !!
const firebaseConfig = {
  apiKey: "AIzaSyA4ilV6tRpqZrkgXRTKdFP_YjAl3CmfYWo",
  authDomain: "tale-of-heros---fangame.firebaseapp.com",
  projectId: "tale-of-heros---fangame",
  storageBucket: "tale-of-heros---fangame.firebasestorage.app",
  messagingSenderId: "648588906865",
  appId: "1:648588906865:web:eb4baf1c0ed9cdbc7ba6d0"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

export const fx = { doc, getDoc, setDoc, addDoc, updateDoc, collection, query, where, getDocs, orderBy, limit, serverTimestamp };
export const sx = { ref, uploadBytes, getDownloadURL };
export const ax = { onAuthStateChanged, signInWithPopup, signOut };
