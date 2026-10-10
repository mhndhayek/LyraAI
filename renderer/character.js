// The live character: a VRM model in 3D.
(function () {
  const STATES = ['idle', 'thinking', 'writing', 'speaking'];

  class Character {
    constructor(el) { this.el = el; this.state = 'idle'; this.cfg = { source: 'vrm', vrmModel: 'builtin:lyra' }; this.timers = []; this.audio = null; this.vrm = null; this.mount(); }
    dispose() { this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyVrm(); this.detachAudio(); this.el.innerHTML = ''; }
    clearTimers() { this.timers.forEach(clearInterval); this.timers = []; if (this.raf) cancelAnimationFrame(this.raf); }
    configure(cfg) { const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg); this.cfg = { ...this.cfg, ...cfg }; if (changed) this.mount(); }
    setState(state) { if (!STATES.includes(state)) state = 'idle'; if (state !== 'idle') this.idleVariant = null; this.state = state; this.el.dataset.state = state; this.render(); if (this.anim) this.anim.setState(state); }

    mount() {
      this.mountSeq = (this.mountSeq || 0) + 1; this.clearTimers(); this.destroyVrm(); this.el.innerHTML = ''; delete this.el.dataset.vrmError;
      this.el.innerHTML = '<div class="char-missing">Loading 3D…</div>'; this.mountVrm().catch((e) => { console.warn('VRM failed:', e.message); this.el.dataset.vrmError = e.message; this.el.innerHTML = `<div class="char-missing">Could not load the 3D model:<br>${String(e.message).replace(/</g, '&lt;')}</div>`; });
    }
    render() {
      if (this.mode !== 'vrm') return; // the render loop reads this.state every frame
    }

    /* --- script loading (the 3D bundle is loaded on first use) --- */
    // One promise per script, shared by every caller: a second mount that starts while the
    // first is still downloading must wait for the same load, not see the tag and go on early.
    loadScript(src) {
      const cache = (window.__lyraScripts = window.__lyraScripts || new Map());
      if (!cache.has(src)) {
        cache.set(src, new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { cache.delete(src); s.remove(); rej(new Error('failed to load ' + src)); }; document.head.appendChild(s); }));
      }
      return cache.get(src);
    }

    /* --- 3D VRM (three.js + @pixiv/three-vrm, vendored as vendor/three-vrm.min.js) ---
       builtin:lyra is the shipped mascot; any other value is a path to a .vrm file.
       Idle breathing, blinking, glances and spring-bone hair run every frame; the
       states lean, tilt and gesture; lip sync drives the "aa" expression. */
    toFileUrl(p) { return p.startsWith('file://') ? p : 'file://' + encodeURI(p); }
    vrmUrl(p) { if (!p || p === 'builtin:lyra') return 'character/vrm/lyra.vrm'; return this.toFileUrl(p); }
    // Base URL for the story-09 animation assets (.vrma clips + anims.json).
    animUrl(p) { return 'character/anims/' + p; }
    async mountVrm() {
      const seq = this.mountSeq; this.mode = 'vrm';
      await this.loadScript('vendor/three-vrm.min.js');
      const L = window.LyraVRM; if (!L) throw new Error('three-vrm did not load');
      const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin, createVRMAnimationClip } = L;
      const loader = new GLTFLoader(); loader.register((parser) => new VRMLoaderPlugin(parser)); loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
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
      // Frame the upper body: the head and shoulders fill the stage, like the pixel busts.
      const hum = vrm.humanoid; const pos = (b) => { const n = hum.getNormalizedBoneNode(b); return n ? n.getWorldPosition(new THREE.Vector3()) : null; };
      vrm.scene.updateMatrixWorld(true);
      // Story 08: key light about 45° to the side, a weak fill from the other side
      // and a soft rim from behind, with a lower ambient, so the face has real
      // modelling instead of a flat frontal wash.
      const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.4, 1.5, 1.2); scene.add(key);
      const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35); fill.position.set(-1.5, 0.8, 1.0); scene.add(fill);
      const rim = new THREE.DirectionalLight(0xbfd4ff, 0.5); rim.position.set(0, 1.2, -1.5); scene.add(rim);
      scene.add(new THREE.AmbientLight(0xffffff, 0.35));
      // Shadows should read as warm skin, not grey: the MToon shade colour of the
      // skin materials is a warm tone (the story asks for the skin _ShadeColor,
      // so hair, eyes and outfit keep their own). `o.material` can be an array
      // on multi-material meshes, so walk it.
      const SHADE = new THREE.Color('#c99a86');
      // The VRoid material names end in the part they dress: ..._SKIN for the
      // face and body, ..._HAIR, ..._CLOTH, ..._EYE, ..._FACE for the painted
      // overlays. Only the _SKIN ones get the warm shade.
      const matIsSkin = (m) => m && m.name && /_SKIN/i.test(m.name);
      vrm.scene.traverse((o) => { o.frustumCulled = false; if (!o.isMesh) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; for (const m of mats) { if (!m) continue; if (matIsSkin(m) && m.shadeColor) { m.shadeColor.copy(SHADE); m.needsUpdate = true; } } });
      // Blush: a cheek overlay per side whose opacity follows the 'happy'
      // expression at runtime, on top of the subtle base blush painted into the
      // face texture. Full happy reaches about 3x the base.
      const BLUSH_COLOR = 0xff7d9c;
      const BLUSH_MAX = 0.45;
      // Pure so a test can assert the mapping directly: 0 at rest, BLUSH_MAX at
      // full happy, clamped for out-of-range expressions.
      const blushOpacity = (happy) => Math.min(1, Math.max(0, happy)) * BLUSH_MAX;
      const blushMats = [];
      {
        const head = hum.getNormalizedBoneNode('head');
        const headSize = new THREE.Box3().setFromObject(head).getSize(new THREE.Vector3()).y || 0.22;
        for (const side of [1, -1]) {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
          const ctx = canvas.getContext('2d');
          const grd = ctx.createRadialGradient(64, 64, 8, 64, 64, 60);
          grd.addColorStop(0, 'rgba(255,125,156,0.9)'); grd.addColorStop(0.65, 'rgba(255,125,156,0.45)'); grd.addColorStop(1, 'rgba(255,125,156,0)');
          ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
          const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshBasicMaterial({ map: tex, color: BLUSH_COLOR, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(headSize * 0.55, headSize * 0.4), mat);
          plane.position.set(side * headSize * 0.34, -headSize * 0.16, headSize * 0.30);
          plane.rotation.y = side * 0.5;
          head.add(plane); blushMats.push(mat);
        }
      }
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
      const cur = { happy: 0 };
      // Story 09: the animation state machine owns the body. A THREE.AnimationMixer
      // drives the active .vrma clip (breathing / think / lean-type / talk),
      // crossfading between them as the state changes. Everything procedural below
      // is a thin *additive* overlay on top of the mixer so the model still feels
      // alive without fighting the clip: the arms-down rest correction (the clips
      // are authored in a T-pose, so without this Lyra's arms stay up), a subtle
      // chest-breath, the look-target wander, blinks, blush and lip-sync.
      const anim = (window.LyraAnimation && window.LyraAnimation.AnimationState) ? new window.LyraAnimation.AnimationState({ THREE, loader, vrm, baseClipFactory: createVRMAnimationClip }, null, this.animUrl('')) : null;
      if (anim) this.anim = anim;
      if (anim) anim.manifest = await (await fetch(this.animUrl('anims.json'))).json();
      // Arms-down rest correction, applied as a local-frame rotation ON TOP of the
      // mixer pose each frame (multiply, not assign) so a clip's arm motion survives
      // the correction. Matches the pre-story-09 look: left +1.22 / right -1.22.
      const AD = { lUA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.22)), rUA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.22)), lLA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.12)), rLA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.12)) };
      // Where the mixer left the arm bones this frame, so the correction can be
      // undone after render (see the restore at the bottom of the loop).
      const AD_BASE = { lUA: new THREE.Quaternion(), rUA: new THREE.Quaternion(), lLA: new THREE.Quaternion(), rLA: new THREE.Quaternion() };
      if (anim) { await anim.loadAll(); anim.setState(this.state); if (anim.currentAction) console.log(`[char] 3D animation active: ${anim.current} (${anim.currentAction.isRunning() ? 'playing' : 'ready'})`); }
      const loop = () => {
        if (!this.vrm || this.vrm.vrm !== vrm) return;
        const dt = Math.min(0.05, clock.getDelta()); t += dt;
        const s = this.state;
        // 1) Mixer drives the whole body from the active clip (crossfades handled inside).
        if (anim) anim.update(dt);
        // 2) Additive overlay on top of the mixer pose.
        const br = Math.sin(t * 1.6);
        // The correction must be UNDO before the next frame: three's mixer only
        // writes a track when its value changed, so a clip that keeps the arms
        // constant would compound the multiply every frame (70° → 140° → …) and
        // her arms would spin in writing/speaking. Snapshot the mixer pose, apply
        // the correction for this frame's render, then restore it (step 5).
        if (pose.lUA) { AD_BASE.lUA.copy(pose.lUA.quaternion); pose.lUA.quaternion.multiply(AD.lUA); }
        if (pose.rUA) { AD_BASE.rUA.copy(pose.rUA.quaternion); pose.rUA.quaternion.multiply(AD.rUA); }
        if (pose.lLA) { AD_BASE.lLA.copy(pose.lLA.quaternion); pose.lLA.quaternion.multiply(AD.lLA); }
        if (pose.rLA) { AD_BASE.rLA.copy(pose.rLA.quaternion); pose.rLA.quaternion.multiply(AD.rLA); }
        const breath = 1 + br * 0.006;
        if (pose.chest) pose.chest.scale.set(breath, 1, breath);
        // 3) Eyes wander a little; while thinking look up and aside.
        if (t > glance.until) glance = { x: (Math.random() - 0.5) * 0.25, y: (Math.random() - 0.5) * 0.12, until: t + 1.5 + Math.random() * 2.5 };
        const gx = s === 'thinking' ? 0.35 : glance.x, gy = s === 'thinking' ? 0.3 : s === 'writing' ? -0.25 : glance.y;
        lookTarget.position.set(ease(lookTarget.position.x, gx, dt * 3), ease(lookTarget.position.y, gy, dt * 3), -1);
        // 4) Expressions: blink, happy→blush, lip-sync.
        cur.happy = ease(cur.happy, s === 'speaking' ? 0.35 : s === 'idle' ? 0.15 : 0, Math.min(1, dt * 4));
        if (ex) {
          if (blinkT < 0 && t > nextBlink) blinkT = 0;
          let bl = 0; if (blinkT >= 0) { blinkT += dt; bl = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0; if (blinkT >= 0.16) { blinkT = -1; nextBlink = t + 2.2 + Math.random() * 3.5; } }
          ex.setValue('blink', bl); ex.setValue('happy', cur.happy * (1 - bl));
          const blushA = blushOpacity(ex.getValue('happy'));
          for (const bm of blushMats) bm.opacity = blushA;
          if (!this.audio) ex.setValue('aa', s === 'speaking' ? (0.25 + 0.25 * Math.sin(t * 14)) * (Math.sin(t * 3.1) > -0.6 ? 1 : 0) : 0);
        }
        vrm.update(dt);
        renderer.render(scene, camera);
        // 5) Undo this frame's arms-down correction so the next frame's mixer
        //    writes onto the clip's own pose, not the corrected one. (The mixer
        //    skips writing unchanged tracks — see step 2 — so without this the
        //    correction compounds on clips that hold the arms still.)
        if (pose.lUA) pose.lUA.quaternion.copy(AD_BASE.lUA);
        if (pose.rUA) pose.rUA.quaternion.copy(AD_BASE.rUA);
        if (pose.lLA) pose.lLA.quaternion.copy(AD_BASE.lLA);
        if (pose.rLA) pose.rLA.quaternion.copy(AD_BASE.rLA);
        this.raf3d = requestAnimationFrame(loop);
      };
      const ro = new ResizeObserver(() => { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }); ro.observe(this.el);
      this.vrm = { vrm, renderer, scene, ro };
      this.raf3d = requestAnimationFrame(loop);
    }
    destroyVrm() {
      if (this.raf3d) cancelAnimationFrame(this.raf3d); this.raf3d = null;
      if (this.anim) { try { this.anim.dispose(); } catch {} this.anim = null; }
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
      if (this.mode === 'vrm' && this.vrm) { try { const ex = this.vrm.vrm.expressionManager; if (ex) ex.setValue('aa', Math.min(1, v * 1.3)); } catch {} }
    }
  }
  window.LyraCharacter = Character;
})();
