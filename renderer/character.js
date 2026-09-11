// The live character. Sources: built-in SVG (default or pixel variant), a GIF pack
// (idle/thinking/writing/speaking.gif in a folder), or a Live2D model.
(function () {
  const STATES = ['idle', 'thinking', 'writing', 'speaking'];

  const PIXEL = {
    face: [
      '......ffff......', '....ffffffff....', '...ffffffffff...', '...ffffffffff...', '..ffffffffffff..', '..ffEEffffEEff..', '..ffEEffffEEff..', '..ffffffffffff..',
      '..fCffffffffCf..', '...fffMMMMfff...', '...ffffffffff...', '....ffffffff....', '......ffff......', '....bbbbbbbb....', '...bbbbbbbbbb...', '..bbbbbbbbbbbb..', '..bbbbbbbbbbbb..', '..bbbbbbbbbbbb..',
    ],
  };

  class Character {
    constructor(el) { this.el = el; this.state = 'idle'; this.cfg = { source: 'svg', variant: 'default' }; this.timers = []; this.audio = null; this.live2d = null; this.mount(); }
    dispose() { this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyLive2d(); this.detachAudio(); this.el.innerHTML = ''; }
    clearTimers() { this.timers.forEach(clearInterval); this.timers = []; if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
    configure(cfg) { const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg); this.cfg = { ...this.cfg, ...cfg }; if (changed) this.mount(); }
    setState(state) { if (!STATES.includes(state)) state = 'idle'; if (state !== 'idle') this.idleVariant = null; this.state = state; this.el.dataset.state = state; this.render(); }

    mount() {
      this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyLive2d(); this.el.innerHTML = '';
      const { source } = this.cfg;
      if (source === 'pet' && this.cfg.petFolder) this.mountPet().catch((e) => { console.warn('pet failed', e); this.el.innerHTML = `<div class="char-missing">Could not load the pet:<br>${e.message}</div>`; });
      else if (source === 'gif' && this.cfg.gifFolder) this.mountGif();
      else if (source === 'live2d' && this.cfg.live2dModel) this.mountLive2d().catch((e) => { console.warn('Live2D failed, using built-in character:', e.message); this.el.dataset.live2dError = e.message; this.mountSvg(); });
      else this.mountSvg();
    }

    /* --- built-in SVG --- */
    mountSvg() {
      this.mode = 'svg';
      this.el.innerHTML = this.cfg.variant === 'pixel' ? this.pixelSvg() : this.vectorSvg();
      this.render();
      // blink
      this.timers.push(setInterval(() => { this.el.querySelectorAll('.c-eye').forEach((e) => { e.classList.add('blink'); setTimeout(() => e.classList.remove('blink'), 140); }); }, 4200));
      if (this.cfg.variant === 'pixel') this.timers.push(setInterval(() => { if (this.state === 'speaking' && !this.audio) this.pixelMouth(this.mouthOpen = !this.mouthOpen); }, 160));
    }
    vectorSvg() {
      return `<svg class="char vector" viewBox="0 0 200 200" aria-hidden="true"><g class="c-body">
        <path d="M42 200 C42 146 62 124 100 124 C138 124 158 146 158 200 Z" class="c-shirt"/>
        <circle cx="100" cy="84" r="52" class="c-skin"/>
        <circle cx="74" cy="100" r="7" class="c-cheek"/><circle cx="126" cy="100" r="7" class="c-cheek"/>
        <ellipse class="c-eye" cx="82" cy="82" rx="5" ry="7"/><ellipse class="c-eye" cx="118" cy="82" rx="5" ry="7"/>
        <path class="c-mouth c-smile" d="M91 104 Q100 111 109 104"/>
        <line class="c-mouth c-flat" x1="93" y1="106" x2="107" y2="106"/>
        <ellipse class="c-mouth c-open" cx="100" cy="106" rx="9" ry="7"/>
        <g class="c-think"><circle cx="150" cy="44" r="4"/><circle cx="162" cy="30" r="6"/><circle cx="178" cy="14" r="8"/></g>
        <g class="c-write" transform="translate(146 20)"><rect x="0" y="0" width="34" height="22" rx="6"/><circle cx="9" cy="11" r="2.5"/><circle cx="17" cy="11" r="2.5"/><circle cx="25" cy="11" r="2.5"/></g>
      </g></svg>`;
    }
    pixelSvg() {
      const rows = PIXEL.face; const w = rows[0].length, h = rows.length, cell = 10;
      const cls = { f: 'p-skin', E: 'p-eye c-eye', C: 'p-cheek', M: 'p-mouth', b: 'p-shirt' };
      let rects = '';
      rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" class="${cls[ch]}" data-x="${x}" data-y="${y}"/>`; }));
      rects += `<g class="c-think">${[[15, 3, 1], [16, 1, 1], [17, -1, 2]].map(([x, y, s]) => `<rect x="${x * cell}" y="${y * cell}" width="${s * cell}" height="${s * cell}" class="p-skin"/>`).join('')}</g>`;
      rects += `<g class="c-write">${[14, 15, 16].map((x) => `<rect x="${x * cell}" y="${1 * cell}" width="${cell}" height="${cell}" class="p-eye"/>`).join('')}</g>`;
      rects += `<g class="p-open">${[6, 7, 8, 9].map((x) => `<rect x="${x * cell}" y="${10 * cell}" width="${cell}" height="${cell}" class="p-mouth"/>`).join('')}</g>`;
      return `<svg class="char pixel" viewBox="-20 -20 ${w * cell + 40} ${h * cell + 20}" shape-rendering="crispEdges" aria-hidden="true"><g class="c-body">${rects}</g></svg>`;
    }
    pixelMouth(open) { const g = this.el.querySelector('.p-open'); if (g) g.style.display = open ? '' : 'none'; }
    render() {
      if (this.mode === 'gif') { const img = this.el.querySelector('img'); if (!img) return; let file = `${this.state}.gif`; if (this.state === 'idle' && this.idleVariant) file = this.idleVariant; if (img.dataset.want !== file) { img.dataset.want = file; img.src = this.gifUrl(file) + `?t=${Date.now()}`; } return; }
      if (this.mode === 'live2d') { this.live2dState(); return; }
      if (this.mode === 'pet') { if (this.pet) { const r = this.pet.rowFor(this.state); if (r !== this.pet.row) { this.pet.row = r; this.pet.frame = 0; this.pet.draw(); } } return; }
      if (this.cfg.variant === 'pixel') this.pixelMouth(false);
    }

    /* --- Hermes / petdex pet: a 192x208 cell spritesheet, one animation row per state --- */
    async mountPet() {
      const seq = this.mountSeq; this.mode = 'pet';
      const folder = this.cfg.petFolder.replace(/\/$/, '');
      let sheet = 'spritesheet.webp';
      try { const j = await (await fetch(this.toFileUrl(`${folder}/pet.json`))).json(); if (j.spritesheetPath) sheet = j.spritesheetPath; this.el.dataset.petName = j.displayName || ''; } catch {}
      const blob = await (await fetch(this.toFileUrl(`${folder}/${sheet}`))).blob();
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('spritesheet not readable')); i.src = URL.createObjectURL(blob); });
      const FW = 192, FH = 208; const cols = Math.max(1, Math.floor(img.width / FW)), rows = Math.max(1, Math.floor(img.height / FH));
      const names = rows >= 9 ? ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'] : ['idle', 'wave', 'run', 'failed', 'review', 'jump', 'extra1', 'extra2'];
      // Count non-blank frames per row (rows are left-packed with transparent padding).
      const probe = document.createElement('canvas'); probe.width = img.width; probe.height = img.height; const pc = probe.getContext('2d', { willReadFrequently: true }); pc.drawImage(img, 0, 0);
      const counts = [];
      for (let r = 0; r < rows; r++) { let n = 0; for (let c = 0; c < cols; c++) { const d = pc.getImageData(c * FW, r * FH, FW, FH).data; let blank = true; for (let i = 3; i < d.length; i += 64) if (d[i] > 8) { blank = false; break; } if (blank) break; n++; } counts.push(n); }
      const rowFor = (state) => { const pref = { idle: ['idle'], thinking: ['review', 'waiting', 'idle'], writing: ['running', 'run', 'running-right', 'idle'], speaking: ['waving', 'wave', 'jumping', 'jump', 'idle'] }[state] || ['idle']; for (const p of pref) { const i = names.indexOf(p); if (i >= 0 && i < rows && counts[i] > 0) return i; } return 0; };
      if (seq !== this.mountSeq) return;
      this.el.innerHTML = ''; const canvas = document.createElement('canvas'); canvas.className = 'char pet'; this.el.appendChild(canvas); const ctx = canvas.getContext('2d');
      const draw = () => { const cs = getComputedStyle(this.el); const H = this.el.clientHeight || 250; const scale = (H * 0.95) / FH; canvas.width = Math.round(FW * scale); canvas.height = Math.round(FH * scale); canvas.style.width = canvas.width + 'px'; canvas.style.height = canvas.height + 'px'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.clearRect(0, 0, canvas.width, canvas.height); const r = this.pet.row; ctx.drawImage(img, this.pet.frame * FW, r * FH, FW, FH, 0, 0, canvas.width, canvas.height); void cs; };
      this.pet = { row: 0, frame: 0, counts, rowFor, draw, img };
      const LOOP = 1100, MAX = 6;
      this.timers.push(setInterval(() => { const n = Math.min(MAX, this.pet.counts[this.pet.row] || 1); this.pet.frame = (this.pet.frame + 1) % n; draw(); }, LOOP / MAX));
      this.render(); draw();
    }

    /* --- GIF pack --- */
    toFileUrl(p) { if (p.startsWith('builtin:')) return 'character/' + p.slice(8).replace(/\/$/, '') + '/'; return p.startsWith('file://') ? p : 'file://' + encodeURI(p); }
    gifUrl(file) { const f = this.cfg.gifFolder; return f.startsWith('builtin:') ? this.toFileUrl(f) + file : this.toFileUrl(`${f}/${file}`); }
    mountGif() {
      this.mode = 'gif';
      const img = document.createElement('img'); img.className = 'char gif'; img.alt = '';
      img.onerror = () => { if (!(img.dataset.want || '').startsWith('idle.gif')) { img.dataset.want = 'idle.gif'; img.src = this.gifUrl('idle.gif'); } else { this.el.innerHTML = `<div class="char-missing">No idle.gif in<br>${this.cfg.gifFolder}</div>`; } };
      this.el.appendChild(img); this.idleVariant = null; this.idleVariants = ['idle.gif'];
      // Idle variations: idle-2.gif … idle-6.gif play now and then instead of idle.gif.
      for (let i = 2; i <= 6; i++) { const probe = new Image(); const name = `idle-${i}.gif`; probe.onload = () => this.idleVariants.push(name); probe.src = this.gifUrl(name); }
      this.timers.push(setInterval(() => { if (this.state !== 'idle' || this.idleVariants.length < 2) return; const pick = Math.random() < 0.55 ? 'idle.gif' : this.idleVariants[1 + Math.floor(Math.random() * (this.idleVariants.length - 1))]; this.idleVariant = pick === 'idle.gif' ? null : pick; this.render(); }, 7000));
      this.render();
    }

    /* --- Live2D (needs pixi + pixi-live2d-display, and live2dcubismcore.min.js next to the model) --- */
    loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s); }); }
    async mountLive2d() {
      const seq = this.mountSeq; this.mode = 'live2d';
      const modelPath = this.cfg.live2dModel; const dir = modelPath.slice(0, modelPath.lastIndexOf('/'));
      await this.loadScript('vendor/pixi.min.js');
      await this.loadScript(this.toFileUrl(`${dir}/live2dcubismcore.min.js`)).catch(() => { throw new Error('live2dcubismcore.min.js not found next to the model (download it from the Live2D site)'); });
      await this.loadScript('vendor/cubism4.min.js');
      const PIXI = window.PIXI; if (!PIXI || !PIXI.live2d) throw new Error('pixi-live2d-display did not load');
      if (seq !== this.mountSeq) return;
      const app = new PIXI.Application({ width: this.el.clientWidth || 260, height: this.el.clientHeight || 250, backgroundAlpha: 0, autoStart: true });
      this.el.appendChild(app.view); app.view.className = 'char live2d';
      const model = await PIXI.live2d.Live2DModel.from(this.toFileUrl(modelPath));
      app.stage.addChild(model);
      const scale = Math.min(app.screen.width / model.width, app.screen.height / model.height) * 0.95; model.scale.set(scale); model.anchor.set(0.5, 0.5); model.x = app.screen.width / 2; model.y = app.screen.height / 2;
      this.live2d = { app, model };
      this.live2dState();
    }
    live2dState() {
      if (!this.live2d) return; const { model } = this.live2d;
      const groups = { idle: ['Idle', 'idle'], thinking: ['Think', 'Idle'], writing: ['Tap', 'TapBody', 'Idle'], speaking: ['Speak', 'Idle'] }[this.state] || ['Idle'];
      for (const g of groups) { try { if (model.internalModel.motionManager.definitions[g]) { model.motion(g); break; } } catch {} }
    }
    destroyLive2d() { if (this.live2d) { try { this.live2d.app.destroy(true, { children: true }); } catch {} this.live2d = null; } }

    /* --- lip sync from an <audio> element --- */
    attachAudio(audioEl) {
      this.detachAudio();
      try {
        const ctx = this.actx || (this.actx = new (window.AudioContext || window.webkitAudioContext)());
        if (audioEl._lyraSrc) { audioEl._lyraSrc.connect(ctx.destination); }
        const src = audioEl._lyraSrc || (audioEl._lyraSrc = ctx.createMediaElementSource(audioEl));
        const an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an); an.connect(ctx.destination);
        const data = new Uint8Array(an.frequencyBinCount); this.audio = { an, data, el: audioEl, since: performance.now(), max: 0 };
        const tick = () => { const a = this.audio; if (!a) return; an.getByteFrequencyData(data); let s = 0; for (let i = 2; i < 40; i++) s += data[i]; const v = Math.min(1, s / 38 / 120); a.max = Math.max(a.max, v); if (a.max === 0 && performance.now() - a.since > 1500) { this.detachAudio(); return; } this.mouth(v); this.raf = requestAnimationFrame(tick); };
        tick();
        audioEl.addEventListener('ended', () => this.detachAudio(), { once: true });
      } catch (e) { console.warn('lip sync unavailable', e); }
    }
    detachAudio() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; this.audio = null; this.mouth(0); }
    mouth(v) {
      if (this.mode === 'live2d' && this.live2d) { try { this.live2d.model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', v); } catch {} return; }
      if (this.mode !== 'svg') return;
      if (this.cfg.variant === 'pixel') { this.pixelMouth(v > 0.25); return; }
      const m = this.el.querySelector('.c-open'); if (m) { m.style.animation = this.audio ? 'none' : ''; m.style.transform = this.audio ? `scaleY(${0.25 + v * 0.75})` : ''; }
    }
  }
  window.LyraCharacter = Character;
})();
