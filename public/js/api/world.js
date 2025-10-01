// /public/js/api/world.js
// 기존 파일 전체를 아래 코드로 교체하세요.

let mapCache = new Map();

/**
 * 월드맵 데이터를 불러옵니다 (캐시 우선).
 * @param {string} mapId - 불러올 맵의 ID (예: 'gionkir_main', 'ahnoria_main')
 * @returns {Promise<object|null>} 맵 데이터 객체
 */
export async function getMapData(mapId) {
  if (!mapId) return null;

  if (mapCache.has(mapId)) {
    return mapCache.get(mapId);
  }
  try {
    // 제안해주신 폴더 구조에 맞춰 경로를 생성합니다.
    // 예: mapId 'gionkir_main' -> worldId 'gionkir', file 'main'
    const [worldId, file] = mapId.split('_');
    const path = `/assets/mapdata/${worldId}/${file}.json`;
    
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Map data not found at ${path}`);
    
    const data = await response.json();
    mapCache.set(mapId, data);
    return data;
  } catch (error) {
    console.error("Failed to load map data:", error);
    return null;
  }
}
