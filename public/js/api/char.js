// /public/js/api/char.js (신규 파일)
import { func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

const getUserCharactersCallable = httpsCallable(func, 'getUserCharacters');

/**
 * 현재 로그인된 유저의 모든 캐릭터 목록을 가져옵니다.
 * @returns {Promise<Array<Object>>} 캐릭터 객체 배열. 각 객체는 id, name, image_url, skills 등을 포함.
 */
export async function getUserCharacters() {
    try {
        const result = await getUserCharactersCallable();
        if (result.data.ok) {
            return result.data.characters;
        } else {
            throw new Error(result.data.error || '캐릭터 목록을 가져오지 못했습니다.');
        }
    } catch (error) {
        console.error("Error fetching user characters:", error);
        throw error;
    }
}
