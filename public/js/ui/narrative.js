// /public/js/ui/narrative.js

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 캐릭터, 이름, 대사 텍스트를 받아 말풍선 HTML을 생성합니다.
 * @param {object} character - 캐릭터 객체 (thumb_url, name 포함)
 * @param {string} speakerName - 화자 이름
 * @param {string} line - 대사 내용
 * @param {number} charIndex - 캐릭터 인덱스 (0 또는 1)
 * @returns {string} - 말풍선 HTML 문자열
 */
function createDialogueBubble({ character, speakerName, line, charIndex }) {
    const side = charIndex === 0 ? 'left' : 'right';
    const char = character || { name: speakerName, thumb_url: '' };
    
    // **굵게** 처리 및 앞뒤 따옴표 제거
    const processedLine = esc(line).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    const strippedLine = processedLine.replace(/^「|」$/g, '');

    return `
      <div class="dialogue-bubble-wrap" data-side="${side}">
        <img src="${esc(char.thumb_url)}" class="dialogue-avatar" onerror="this.style.display='none'">
        <div class="dialogue-bubble">
          <div class="dialogue-name">${esc(char.name)}</div>
          <div class="dialogue-text">${strippedLine}</div>
        </div>
      </div>
    `;
}

/**
 * 서사 텍스트를 풍부한 HTML로 렌더링합니다.
 * @param {string} text - 원본 서사 텍스트
 * @param {Array<object>} party - 대화에 참여하는 캐릭터 객체 배열 (주로 2명)
 * @returns {string} - 렌더링된 HTML 문자열
 */
export function renderRich(text, party = []) {
    if (typeof text !== 'string') text = String(text ?? '');

    let processedText = text.replace(/\r\n?/g, '\n');
    if (processedText.includes('\\n')) processedText = processedText.replace(/\\n/g, '\n');

    const dialogues = [];
    // 정규식 수정: [대화:이름]「대사」 형식을 감지합니다.
    processedText = processedText.replace(/\[대화:([^\]]+)\]「([^」]*)」/g, (match, name, line) => {
        dialogues.push({ name: name.trim(), line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    // 기본 마크업 처리
    let narrativeBody = esc(processedText)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, inner) => `${pre}<i>${inner}</i>`)
        .replace(/^###\s+(.*)/gm, '<h4>$1</h4>')
        .replace(/^##\s+(.*)/gm, '<h3>$1</h3>')
        .replace(/^#\s+(.*)/gm, '<h2>$1</h2>')
        .replace(/^>\s+(.*)/gm, '<blockquote>$1</blockquote>')
        .replace(/^\*\s+(.*)/gm, '<ul><li>$1</li></ul>') // 간단한 목록 처리
        .replace(/<\/ul>\n<ul>/g, ''); // 연속된 목록 합치기

    // 대화 플레이스홀더를 말풍선 HTML로 교체
    dialogues.forEach((dialogue, index) => {
        const charIndex = party.findIndex(p => p.name === dialogue.name);
        const bubbleHtml = createDialogueBubble({
            character: party[charIndex],
            speakerName: dialogue.name,
            line: dialogue.line,
            charIndex: charIndex
        });
        narrativeBody = narrativeBody.replace(`__DIALOGUE_PLACEHOLDER_${index}__`, bubbleHtml);
    });

    // 최종적으로 문단으로 나누고, 줄바꿈 처리
    return narrativeBody.split(/\n{2,}/)
        .map(p => p.trim())
        .filter(p => p)
        .map(p => {
            if (p.startsWith('<div class="dialogue-bubble-wrap"')) return p;
            return `<p>${p.replace(/\n/g, '<br>')}</p>`;
        })
        .join('');
}
