// me.js — BYOK 로컬 저장 & 통계
import { el } from '../ui/components.js';
import { setByok } from '../api/ai.js';

function byokBox(){
  const box = el('div',{ className:'card' },
    el('div',{ className:'title' }, 'AI 키(BYOK)'),
    el('div',{ className:'muted' }, 'Google Gemini API 키를 여기 입력. 로컬에만 저장돼.'),
    el('input',{ id:'byokInput', placeholder:'AIza...', style:'width:100%' }),
    el('button',{ className:'btn', onclick:()=>{
      const val = document.getElementById('byokInput').value.trim();
      setByok(val);
      showToast && showToast('저장 완료 (로컬)');
    }}, '저장')
  );
  return box;
}

function render(){
  const v=document.getElementById('view');
  v.replaceChildren(el('div',{className:'stack'},
    el('div',{className:'title'},'내 정보'),
    byokBox()
  ));
}
window.addEventListener('route', e=>{ if(e.detail.path==='me') render(); });
