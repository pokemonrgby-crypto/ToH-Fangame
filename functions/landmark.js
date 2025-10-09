// /functions/landmark.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/**
 * [스케줄링용] 일주일에 한 번 새로운 랜드마크 경매를 시작하는 함수
 */
exports.createLandmarkAuction = onCall({ region: 'us-central1' }, async (req) => {
    // TODO: 현재 진행중인 경매가 없는지 확인
    // TODO: landmarks.json에서 아직 건설되지 않은 랜드마크 중 하나를 무작위로 선택
    // TODO: 'landmark_auctions' 컬렉션에 새 경매 문서 생성 (일주일 후 마감)
    
    console.log("Creating a new landmark auction...");
    return { success: true, message: "새로운 랜드마크 경매가 시작되었습니다." };
});

/**
 * 현재 진행중인 랜드마크 경매에 입찰하는 함수
 */
exports.bidOnLandmark = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { auctionId, bidAmount } = req.data;
    
    // TODO: auctionId로 경매 정보 조회
    // TODO: 입찰 금액이 현재 최고 입찰가보다 높은지 확인
    // TODO: 사용자 코인 확인 및 차감 (또는 입찰 시에는 보유량만 확인하고 낙찰 시 차감)
    // TODO: 경매 문서에 최고 입찰 정보 업데이트
    
    return { success: true, message: `${bidAmount} 코인으로 입찰했습니다.` };
});

/**
 * [스케줄링용] 경매 시간이 만료되었을 때 최종 낙찰자를 처리하는 함수
 */
exports.awardLandmark = onCall({ region: 'us-central1' }, async (req) => {
    const { auctionId } = req.data;
    
    // TODO: auctionId로 경매 정보 조회
    // TODO: 최고 입찰자에게 '랜드마크 건축권' 아이템 부여 또는 별도 필드에 기록
    // TODO: 낙찰 비용 차감
    // TODO: 경매 문서를 'closed' 상태로 변경
    
    return { success: true, message: "랜드마크가 낙찰되었습니다." };
});
