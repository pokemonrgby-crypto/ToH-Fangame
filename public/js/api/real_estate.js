// /public/js/api/real_estate.js (신규 파일)
import { func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

const call = (name) => httpsCallable(func, name);

// 시설에 캐릭터 할당
export const assignCharacterToFacility = (data) => call('assignCharacterToFacility')(data);

// 새 농지 생성
export const createFarmland = (data) => call('createFarmland')(data);

// 건물 건설 시작 (미구현)
export const startConstruction = (data) => call('startConstruction')(data);
