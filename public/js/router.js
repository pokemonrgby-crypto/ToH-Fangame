import { showHome } from './tabs/home.js';
import { showCharDetail } from './tabs/char.js';
import { showCreate } from './tabs/create.js';

export function highlightTab(){
  const hash = location.hash || '#/home';
  const tab = hash.split('/')[1];
  document.querySelectorAll('.bottombar a').forEach(a=>{
    a.classList.toggle('active', a.dataset.tab===tab);
  });
}

export function router(){
  const hash = location.hash || '#/home';
  if(hash.startsWith('#/char/')){
    showCharDetail();
  }else if(hash === '#/create'){
    showCreate();
  }else{
    showHome();
  }
}
