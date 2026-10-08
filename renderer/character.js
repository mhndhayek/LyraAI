// The live character. Sources: built-in SVG (default or pixel variant), a GIF pack
// (idle/thinking/writing/speaking.gif in a folder), a Live2D model, or a 3D VRM model.
(function () {
  const STATES = ['idle', 'thinking', 'writing', 'speaking'];

  const PIXEL = {
    face: [
      '......ffff......', '....ffffffff....', '...ffffffffff...', '...ffffffffff...', '..ffffffffffff..', '..ffEEffffEEff..', '..ffEEffffEEff..', '..ffffffffffff..',
      '..fCffffffffCf..', '...fffMMMMfff...', '...ffffffffff...', '....ffffffff....', '......ffff......', '....bbbbbbbb....', '...bbbbbbbbbb...', '..bbbbbbbbbbbb..', '..bbbbbbbbbbbb..', '..bbbbbbbbbbbb..',
    ],
  };

  class Character {
    constructor(el) { this.el = el; this.state = 'idle'; this.cfg = { source: 'svg', variant: 'default' }; this.timers = []; this.audio = null; this.live2d = null; this.vrm = null; this.mount(); }
    dispose() { this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyLive2d(); this.destroyVrm(); this.detachAudio(); this.el.innerHTML = ''; }
    clearTimers() { this.timers.forEach(clearInterval); this.timers = []; if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
    configure(cfg) { const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg); this.cfg = { ...this.cfg, ...cfg }; if (changed) this.mount(); }
    setState(state) { if (!STATES.includes(state)) state = 'idle'; if (state !== 'idle') this.idleVariant = null; this.state = state; this.el.dataset.state = state; this.render(); }

    mount() {
      this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyLive2d(); this.destroyVrm(); this.el.innerHTML = ''; delete this.el.dataset.vrmError;
      const { source } = this.cfg;
      if (source === 'pet' && this.cfg.petFolder) this.mountPet().catch((e) => { console.warn('pet failed', e); this.el.innerHTML = `<div class="char-missing">Could not load the pet:<br>${e.message}</div>`; });
      else if (source === 'gif' && this.cfg.gifFolder) this.mountGif();
      else if (source === 'live2d' && this.cfg.live2dModel) this.mountLive2d().catch((e) => { console.warn('Live2D failed, using built-in character:', e.message); this.el.dataset.live2dError = e.message; this.mountSvg(); });
      else if (source === 'vrm') { this.el.innerHTML = '<div class="char-missing">Loading 3D…</div>'; this.mountVrm().catch((e) => { console.warn('VRM failed:', e.message); this.el.dataset.vrmError = e.message; this.el.innerHTML = `<div class="char-missing">Could not load the 3D model:<br>${String(e.message).replace(/</g, '&lt;')}</div>`; }); }
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
      if (this.mode === 'vrm') return; // the render loop reads this.state every frame
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
    // One promise per script, shared by every caller: a second mount that starts while the
    // first is still downloading must wait for the same load, not see the tag and go on early.
    loadScript(src) {
      const cache = (window.__lyraScripts = window.__lyraScripts || new Map());
      if (!cache.has(src)) {
        cache.set(src, new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { cache.delete(src); s.remove(); rej(new Error('failed to load ' + src)); }; document.head.appendChild(s); }));
      }
      return cache.get(src);
    }
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

    /* --- 3D VRM (three.js + @pixiv/three-vrm, vendored as vendor/three-vrm.min.js) ---
       builtin:lyra is the shipped mascot; any other value is a path to a .vrm file.
       Idle breathing, blinking, glances and spring-bone hair run every frame; the
       states lean, tilt and gesture; lip sync drives the "aa" expression. */
    vrmUrl(p) { if (!p || p === 'builtin:lyra') return 'character/vrm/lyra.vrm'; return this.toFileUrl(p); }
    async mountVrm() {
      const seq = this.mountSeq; this.mode = 'vrm';
      await this.loadScript('vendor/three-vrm.min.js');
      const L = window.LyraVRM; if (!L) throw new Error('three-vrm did not load');
      const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils } = L;
      const loader = new GLTFLoader(); loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(this.vrmUrl(this.cfg.vrmModel));
      if (seq !== this.mountSeq) return;
      const vrm = gltf.userData.vrm; if (!vrm) throw new Error('not a VRM file');
      VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.combineSkeletons(gltf.scene);
      if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse((o) => { o.frustumCulled = false; });

      const W = () => this.el.clientWidth || 236, H = () => this.el.clientHeight || 236;
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W(), H()); renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.className = 'char vrm'; this.el.innerHTML = ''; this.el.appendChild(renderer.domElement);
      const scene = new THREE.Scene(); scene.add(vrm.scene);
      const light = new THREE.DirectionalLight(0xffffff, Math.PI); light.position.set(0.5, 1.5, 1.5); scene.add(light); scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      // Frame the upper body: the head and shoulders fill the stage, like the pixel busts.
      const hum = vrm.humanoid; const pos = (b) => { const n = hum.getNormalizedBoneNode(b); return n ? n.getWorldPosition(new THREE.Vector3()) : null; };
      vrm.scene.updateMatrixWorld(true);
      const chest = pos('upperChest') || pos('chest') || new THREE.Vector3(0, 1.2, 0);
      // Frame from the real top of the model (hair crown, ears) down to the chest, with headroom.
      // The head bone sits at the base of the skull, so it cannot be used for the top.
      const crown = new THREE.Box3().setFromObject(vrm.scene).max.y;
      const top = crown + (crown - chest.y) * 0.08, bottom = chest.y - (crown - chest.y) * 0.18;
      const target = new THREE.Vector3(0, (top + bottom) / 2, 0);
      const fov = 22; const camera = new THREE.PerspectiveCamera(fov, W() / H(), 0.1, 20);
      const dist = ((top - bottom) / 2) / Math.tan((fov / 2) * Math.PI / 180); camera.position.set(0, target.y, dist); camera.lookAt(target);
      const lookTarget = new THREE.Object3D(); camera.add(lookTarget); scene.add(camera); if (vrm.lookAt) vrm.lookAt.target = lookTarget;
      // Relax the T-pose: arms down by the sides.
      const bone = (b) => hum.getNormalizedBoneNode(b);
      const pose = { lUA: bone('leftUpperArm'), rUA: bone('rightUpperArm'), lLA: bone('leftLowerArm'), rLA: bone('rightLowerArm'), spine: bone('spine'), chest: bone('chest'), neck: bone('neck'), head: bone('head'), rHand: bone('rightHand') };
      const ex = vrm.expressionManager;
      const clock = new THREE.Clock(); let t = 0; let nextBlink = 2 + Math.random() * 3; let blinkT = -1; let glance = { x: 0, y: 0, until: 0 };
      const ease = (a, b, k) => a + (b - a) * k;
      const cur = { lean: 0, tilt: 0, nod: 0, wave: 0, happy: 0 };
      const loop = () => {
        if (!this.vrm || this.vrm.vrm !== vrm) return;
        const dt = Math.min(0.05, clock.getDelta()); t += dt;
        const s = this.state; const want = { lean: s === 'thinking' ? 0.06 : s === 'writing' ? 0.1 : 0, tilt: s === 'thinking' ? 0.16 : 0, nod: s === 'writing' ? 0.06 : 0, wave: s === 'speaking' ? 1 : 0, happy: s === 'speaking' ? 0.35 : s === 'idle' ? 0.15 : 0 };
        for (const k of Object.keys(cur)) cur[k] = ease(cur[k], want[k], Math.min(1, dt * 4));
        const br = Math.sin(t * 1.6);
        if (pose.lUA) pose.lUA.rotation.z = 1.22 + br * 0.015; if (pose.rUA) pose.rUA.rotation.z = -1.22 - br * 0.015 - cur.wave * 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
        if (pose.lLA) pose.lLA.rotation.z = 0.12; if (pose.rLA) pose.rLA.rotation.z = -0.12 - cur.wave * 0.25;
        if (pose.spine) { pose.spine.rotation.x = cur.lean + br * 0.012; pose.spine.rotation.y = Math.sin(t * 0.5) * 0.03; }
        if (pose.chest) pose.chest.rotation.x = br * 0.015;
        if (pose.neck) pose.neck.rotation.z = cur.tilt * 0.4;
        if (pose.head) { pose.head.rotation.z = cur.tilt * 0.6 + Math.sin(t * 0.7) * 0.02; pose.head.rotation.x = cur.nod * Math.sin(t * 5) + Math.sin(t * 0.9) * 0.015; pose.head.rotation.y = Math.sin(t * 0.43) * 0.05; }
        // Eyes: wander a little; while thinking look up and aside.
        if (t > glance.until) glance = { x: (Math.random() - 0.5) * 0.25, y: (Math.random() - 0.5) * 0.12, until: t + 1.5 + Math.random() * 2.5 };
        const gx = s === 'thinking' ? 0.35 : glance.x, gy = s === 'thinking' ? 0.3 : s === 'writing' ? -0.25 : glance.y;
        lookTarget.position.set(ease(lookTarget.position.x, gx, dt * 3), ease(lookTarget.position.y, gy, dt * 3), -1);
        if (ex) {
          if (blinkT < 0 && t > nextBlink) blinkT = 0;
          let bl = 0; if (blinkT >= 0) { blinkT += dt; bl = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0; if (blinkT >= 0.16) { blinkT = -1; nextBlink = t + 2.2 + Math.random() * 3.5; } }
          ex.setValue('blink', bl); ex.setValue('happy', cur.happy * (1 - bl));
          if (!this.audio) ex.setValue('aa', s === 'speaking' ? (0.25 + 0.25 * Math.sin(t * 14)) * (Math.sin(t * 3.1) > -0.6 ? 1 : 0) : 0);
        }
        vrm.update(dt);
        renderer.render(scene, camera);
        this.raf3d = requestAnimationFrame(loop);
      };
      const ro = new ResizeObserver(() => { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }); ro.observe(this.el);
      this.vrm = { vrm, renderer, scene, ro };
      this.raf3d = requestAnimationFrame(loop);
    }
    destroyVrm() {
      if (this.raf3d) cancelAnimationFrame(this.raf3d); this.raf3d = null;
      if (!this.vrm) return; const { vrm, renderer, ro } = this.vrm; this.vrm = null;
      try { ro.disconnect(); } catch {}
      try { window.LyraVRM.VRMUtils.deepDispose(vrm.scene); } catch {}
      try { renderer.dispose(); renderer.forceContextLoss(); } catch {}
    }

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
      if (this.mode === 'vrm' && this.vrm) { try { const ex = this.vrm.vrm.expressionManager; if (ex) ex.setValue('aa', Math.min(1, v * 1.3)); } catch {} return; }
      if (this.mode === 'live2d' && this.live2d) { try { this.live2d.model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', v); } catch {} return; }
      if (this.mode !== 'svg') return;
      if (this.cfg.variant === 'pixel') { this.pixelMouth(v > 0.25); return; }
      const m = this.el.querySelector('.c-open'); if (m) { m.style.animation = this.audio ? 'none' : ''; m.style.transform = this.audio ? `scaleY(${0.25 + v * 0.75})` : ''; }
    }
  }
  window.LyraCharacter = Character;
})();
