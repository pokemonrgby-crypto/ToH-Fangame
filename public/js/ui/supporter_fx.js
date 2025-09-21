// 교체할 전체 코드 블록
export function attachSupporterFX(root, theme = 'orbits', opts = {}) {
  if (!root || root.__fxAttached) return;
  root.__fxAttached = true;

  // ----- 옵션 -----
  const mode = (opts.mode || theme || 'orbits');
  const HALO = Number.isFinite(opts.haloPx) ? opts.haloPx : 32;
  const dprCap = Math.min(1.75, window.devicePixelRatio || 1);
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // 테마 클래스 부여
  root.classList.add(`supporter-${mode}`);

  // ----- 뒤/앞 레이어 두 겹 -----
  const fxBack = document.createElement('div');
  const fxFront = document.createElement('div');
  fxBack.className = 'supporter-fx supporter-fx-back';
  fxFront.className = 'supporter-fx supporter-fx-front';
  fxBack.style.setProperty('--halo', HALO + 'px');
  fxFront.style.setProperty('--halo', HALO + 'px');

  const cvsB = document.createElement('canvas'); cvsB.className = 'fx-canvas fx-back';
  const cvsF = document.createElement('canvas'); cvsF.className = 'fx-canvas fx-front';
  fxBack.appendChild(cvsB);
  fxFront.appendChild(cvsF);

  const anchor = root.querySelector('.avatar-clip') || root.firstElementChild;
  if (anchor) root.insertBefore(fxBack, anchor);
  else root.appendChild(fxBack);
  root.appendChild(fxFront);

  // ----- 캔버스/크기 -----
  const bctx = cvsB.getContext('2d', { alpha: true });
  const fctx = cvsF.getContext('2d', { alpha: true });
  let bw = 0, bh = 0, fw = 0, fh = 0, dpr = dprCap;

  function resize() {
    const r = root.getBoundingClientRect();
    bw = Math.max(2, Math.floor((r.width + HALO * 2) * dpr));
    bh = Math.max(2, Math.floor((r.height + HALO * 2) * dpr));
    fw = bw; fh = bh;
    cvsB.width = bw; cvsB.height = bh;
    cvsF.width = fw; cvsF.height = fh;
  }
  resize();
  new ResizeObserver(resize).observe(root);

  // ----- 러닝 가드 -----
  let running = !prefersReduced, last = performance.now();
  const io = new IntersectionObserver(([en]) => running = !prefersReduced && !!(en && en.isIntersecting), { threshold: .05 });
  io.observe(root);
  document.addEventListener('visibilitychange', () => { running = !prefersReduced && (document.visibilityState === 'visible'); });

  // ▼▼▼▼▼ 테마에 따른 분기 처리 ▼▼▼▼▼
  if (mode === 'nexus') {
    // --- 'nexus' (포탈) 이펙트 로직 ---
    const portalParticles = [];
    const RIPPLE_COUNT = 5;
    const PARTICLE_COUNT = 80;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        portalParticles.push({
            angle: Math.random() * Math.PI * 2,
            radius: 1 + Math.random() * 0.1,
            speed: 0.01 + Math.random() * 0.02,
            size: 1 + Math.random() * 1.5,
            alpha: 0.2 + Math.random() * 0.5
        });
    }
    
    const drawPortalEffect = (ctx, time) => {
        const cx = bw / 2;
        const cy = bh / 2;
        const baseRx = (bw / 2) - (HALO * dpr * 0.5);
        const baseRy = (bh / 2) - (HALO * dpr * 0.5);

        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRx);
        gradient.addColorStop(0, 'rgba(100, 180, 255, 0.4)');
        gradient.addColorStop(0.7, 'rgba(50, 100, 255, 0.2)');
        gradient.addColorStop(1, 'rgba(20, 50, 150, 0.1)');
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.ellipse(cx, cy, baseRx, baseRy, 0, 0, 2 * Math.PI);
        ctx.fill();

        ctx.lineWidth = 1.5 * dpr;
        for (let i = 0; i < RIPPLE_COUNT; i++) {
            const rippleProgress = (time / 2000 + i * 0.2) % 1;
            ctx.strokeStyle = `rgba(150, 200, 255, ${1 - rippleProgress})`;
            ctx.beginPath();
            ctx.ellipse(cx, cy, baseRx * (0.95 + rippleProgress * 0.05), baseRy * (0.95 + rippleProgress * 0.05), 0, 0, 2 * Math.PI);
            ctx.stroke();
        }

        portalParticles.forEach(p => {
            p.angle += p.speed;
            const x = cx + Math.cos(p.angle) * baseRx * p.radius;
            const y = cy + Math.sin(p.angle) * baseRy * p.radius;

            ctx.fillStyle = `rgba(200, 225, 255, ${p.alpha})`;
            ctx.beginPath();
            ctx.arc(x, y, p.size * dpr, 0, 2 * Math.PI);
            ctx.fill();
        });
    };
    
    const step = (ts) => {
        if (!running) { requestAnimationFrame(step); return; }
        bctx.clearRect(0, 0, bw, bh);
        fctx.clearRect(0, 0, fw, fh);
        drawPortalEffect(bctx, ts); // 포탈은 배경(bctx)에만 그립니다.
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

  } else {
    // --- 기존 'orbits' 이펙트 로직 ---
    const ORBITS = 2;
    const SATS = 1;
    const SPEED = 0.8;
    const TAIL_N = 64;
    const TAIL_W = 3.5;
    const TWINKS = 12;
    const COLOR = (opts.color || '#ffffff');
    const RGB = ((hex) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; })(COLOR);
    const rgba = (a) => `rgba(${RGB.r},${RGB.g},${RGB.b},${a})`;
    const Orbits = [{ rX: 0.92, rY: 0.32, tilt: 0, dir: 1 }, { rX: 0.78, rY: 0.28, tilt: 0, dir: 1 }].slice(0, ORBITS);
    const Sats = []; Orbits.forEach((o, i) => { for (let k = 0; k < SATS; k++) { Sats.push({ orbit: i, a: (k / SATS) * Math.PI * 2 + Math.random() * Math.PI * 2 / SATS, sp: (SPEED + Math.random() * 0.12 - 0.06) * o.dir, size: Math.random() * 0.7 + 1.8 * dpr, trail: [] }); } });
    const Stars = []; for (let i = 0; i < TWINKS; i++) { Stars.push({ x: Math.random() * 0.9 + 0.05, y: Math.random() * 0.9 + 0.05, t: Math.random(), life: Math.random() * 1.3 + 1.5, size: Math.random() * 1 + 1.2 * dpr, zrand: Math.random() < .5 }); }

    const step = (ts) => {
      if (!running) { requestAnimationFrame(step); return; }
      const dt = Math.min(.05, (ts - last) / 1000); last = ts;
      bctx.clearRect(0, 0, bw, bh); fctx.clearRect(0, 0, fw, fh);
      bctx.globalCompositeOperation = fctx.globalCompositeOperation = 'lighter'; bctx.lineCap = fctx.lineCap = 'round';
      const cx = bw / 2, cy = bh / 2, base = Math.min(bw, bh);
      for (const s of Sats) {
        const o = Orbits[s.orbit]; s.a = (s.a + s.sp * dt) % (Math.PI * 2);
        const rx = o.rX * base * .5, ry = o.rY * base * .5; const cosT = Math.cos(o.tilt), sinT = Math.sin(o.tilt); let ox = Math.cos(s.a) * rx, oy = Math.sin(s.a) * ry; const x2 = ox * cosT - oy * sinT, y2 = ox * sinT + oy * cosT, z = y2, x = cx + x2, y = cy + y2;
        s.trail.push({ x, y, z }); if (s.trail.length > TAIL_N) s.trail.shift();
        drawTrailSplit(s.trail, bctx, fctx, TAIL_W, rgba);
        const headCtx = (z >= 0) ? fctx : bctx; headCtx.fillStyle = rgba(.95); headCtx.beginPath(); headCtx.arc(x, y, s.size, 0, Math.PI * 2); headCtx.fill();
      }
      for (let i = 0; i < Stars.length; i++) {
        const st = Stars[i]; st.t += dt; if (st.t > st.life) { st.x = Math.random() * 0.9 + 0.05; st.y = Math.random() * 0.9 + 0.05; st.t = 0; st.life = Math.random() * 1.3 + 1.5; st.size = Math.random() * 1 + 1.2 * dpr; st.zrand = !st.zrand; }
        const p = st.t / st.life, a = p < .5 ? p * 2 : (1 - p) * 2; const sx = HALO + st.x * (bw - 2 * HALO), sy = HALO + st.y * (bh - 2 * HALO); const ctx = st.zrand ? fctx : bctx;
        ctx.fillStyle = rgba(0.55 + 0.45 * a); ctx.beginPath(); ctx.arc(sx, sy, st.size * a, 0, Math.PI * 2); ctx.fill();
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);

    function drawTrailSplit(trail, back, front, headW, rgbaFn) {
      if (trail.length < 2) return;
      for (const pass of ['back', 'front']) {
        const ctx = (pass === 'back' ? back : front);
        for (let i = 1; i < trail.length; i++) {
          const p0 = trail[i - 1], p1 = trail[i]; const zMid = (p0.z + p1.z) / 2; const isFront = zMid >= 0; if ((pass === 'front') !== isFront) continue;
          const t = i / (trail.length - 1); const w = Math.max(0.6, headW * t); const a = Math.max(0, 0.6 * t);
          ctx.strokeStyle = rgbaFn(a); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
      }
    }
  }
  // ▲▲▲▲▲ 테마에 따른 분기 처리 ▲▲▲▲▲

  if (opts.tilt !== false) {
    root.dataset.tilt = '1';
    const onMove = (e) => {
      const r = root.getBoundingClientRect(); const ex = ('touches' in e ? e.touches[0].clientX : e.clientX), ey = ('touches' in e ? e.touches[0].clientY : e.clientY);
      const x = (ex - r.left) / r.width, y = (ey - r.top) / r.height; const tx = (x - 0.5) * 30, ty = (0.5 - y) * 30;
      fxFront.style.transform = `rotateX(${ty}deg) rotateY(${tx}deg)`;
      root.style.transform = `rotateX(${ty * 0.5}deg) rotateY(${tx * 0.5}deg)`;
    };
    const onLeave = () => { root.style.transform = ''; fxFront.style.transform = ''; };
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerleave', onLeave);
  }
}
