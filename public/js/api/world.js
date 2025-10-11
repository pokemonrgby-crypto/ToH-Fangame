// /public/js/api/world.js

let mapCache = new Map();
let worldsCache = null;

/**
 * 모든 월드 데이터를 불러와 ID를 키로 하는 객체로 변환하고 캐시합니다.
 * @returns {Promise<object>} 월드 데이터 객체 (e.g., { gionkir: { ... }, ahnoria: { ... } })
 */
async function fetchWorldsData() {
    if (worldsCache) return worldsCache;
    try {
        const response = await fetch('/assets/worlds.json');
        if (!response.ok) throw new Error('worlds.json not found');
        const data = await response.json();
        // 배열을 ID를 키로 하는 객체(맵)로 변환
        worldsCache = (data.worlds || []).reduce((acc, world) => {
            acc[world.id] = world;
            return acc;
        }, {});
        return worldsCache;
    } catch (error) {
        console.error("Failed to load worlds.json:", error);
        return {};
    }
}

// story.js에서 import할 수 있도록 WORLD_LIST를 초기화하고 비동기적으로 채웁니다.
export let WORLD_LIST = {};
fetchWorldsData().then(data => {
    // 비동기적으로 불러온 데이터를 WORLD_LIST에 할당합니다.
    Object.assign(WORLD_LIST, data);
});


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
