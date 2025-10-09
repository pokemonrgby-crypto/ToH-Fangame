// /public/js/api/construction.js
import { callFunction } from './firebase.js';

/**
 * 새로운 건물 건설을 시작합니다.
 * @param {object} constructionData - 건설에 필요한 데이터
 * @returns {Promise<any>}
 */
export const startConstruction = (constructionData) => callFunction('startConstruction', constructionData);

/**
 * 진행 중인 건설을 완료 처리합니다.
 * @param {string} projectId - 완료할 건설 프로젝트의 ID
 * @returns {Promise<any>}
 */
export const completeConstruction = (projectId) => callFunction('completeConstruction', { projectId });

/**
 * 기존 건물을 관리합니다.
 * @param {string} plotId - 부지 ID
 * @param {string} buildingId - 건물 ID
 * @param {string} action - 수행할 관리 액션 (예: 'inspect_collapse')
 * @returns {Promise<any>}
 */
export const manageBuilding = (plotId, buildingId, action) => callFunction('manageBuilding', { plotId, buildingId, action });
