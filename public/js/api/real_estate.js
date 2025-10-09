// /public/js/api/real_estate.js (수정)
import { func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

// callFn과 동일한 역할을 하는 내부 헬퍼
const call = (name, data) => httpsCallable(func, name)(data).then(r => r.data);

// 시설에 캐릭터 할당
export const assignCharacterToFacility = (data) => call('assignCharacterToFacility', data);

// 새 농지 생성
export const createFarmland = (data) => call('createFarmland', data);

// 건물 건설 시작
export const startConstruction = (data) => call('startConstruction', data);
