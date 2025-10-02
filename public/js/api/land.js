// /public/js/api/land.js (신규 파일)
import { func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

const call = (name) => httpsCallable(func, name);

export const buyMicroPlot = (data) => call('buyMicroPlot')(data);
export const sellMicroPlot = (data) => call('sellMicroPlot')(data);
