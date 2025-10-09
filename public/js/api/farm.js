// /public/js/api/farm.js
import { func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

const call = (name) => httpsCallable(func, name);

// 씨앗 구매 (관리자용)
export const buySeed = (data) => call('buySeed')(data);

// 특정 토지의 상세 정보 (심어진 작물 등) 가져오기
export const getFarmPlotDetail = (data) => call('getFarmPlotDetail')(data);

// 특정 타일에 씨앗 심기
export const plantSeedOnTile = (data) => call('plantSeedOnTile')(data);

// [추가] 수확 함수
export const harvestTiles = (data) => call('harvestTiles')(data);

// 작업 취소 (심기 예약 취소)
export const cancelPlanting = (data) => call('cancelPlanting')(data);
