import { router, highlightTab } from './router.js';
import { onAuthChanged, signInWithGoogle, signOutNow } from './api/auth.js';

window.addEventListener('hashchange', ()=>{ highlightTab(); router(); });

async function boot(){
  const btnLogin = document.getElementById('btnLogin');
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogin)  btnLogin.onclick  = signInWithGoogle;
  if (btnLogout) btnLogout.onclick = signOutNow;

  onAuthChanged(user=>{
    if (btnLogin)  btnLogin.style.display  = user ? 'none' : 'inline-block';
    if (btnLogout) btnLogout.style.display = user ? 'inline-block' : 'none';
  });

  highlightTab();
  router();
}
boot();
