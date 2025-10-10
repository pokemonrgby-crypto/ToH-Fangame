// /functions/assets.js (전체 교체)
const fs = require('fs');
const path = require('path');

// 재사용을 위해 에셋을 메모리에 캐싱합니다.
const cachedAssets = {};

function loadAsset(assetName) {
  if (cachedAssets[assetName]) return cachedAssets[assetName];
  try {
    const rawdata = fs.readFileSync(path.join(__dirname, 'assets', `${assetName}.json`));
    const jsonData = JSON.parse(rawdata);
    cachedAssets[assetName] = jsonData;
    return jsonData;
  } catch (error) {
    console.error(`Error loading asset [${assetName}.json]:`, error);
    return null;
  }
}

// 개별 에셋 로더
const items = () => loadAsset('items');
const recipes = () => loadAsset('recipes');
const researchTree = () => loadAsset('research_tree');
const buildingMaterials = () => loadAsset('building_materials');
const facilities = () => loadAsset('facilities');
const buildingPurposes = () => loadAsset('building_purposes');
const jobs = () => loadAsset('jobs');
const landmarks = () => loadAsset('landmarks');
const roomsCatalog = () => loadAsset('rooms');
const architecturalStyles = () => loadAsset('architectural_styles'); // ✅ 추가

module.exports = {
  items,
  recipes,
  researchTree,
  buildingMaterials,
  facilities,
  buildingPurposes,
  jobs,
  landmarks,
  roomsCatalog,
  architecturalStyles, // ✅ 꼭 export에 포함
};
