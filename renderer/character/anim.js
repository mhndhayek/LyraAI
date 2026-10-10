// Story 09 — the 3D animation state machine.
//
// Sits on top of the live VRM: a THREE.AnimationMixer drives one of the bundled
// .vrma clips at a time, crossfading between them as the character's state
// changes (idle / thinking / writing / speaking). The procedural layer in
// character.js (breathing, blink, glance, blush, lip-sync) stays as an additive
// overlay on top of whatever the mixer is playing, so the model still feels alive.
//
// The module is written to run in both the browser (where it pulls THREE,
// GLTFLoader, the VRM animation plugin and createVRMAnimationClip off
// window.LyraVRM) and plain Node (for tests), so it takes everything it needs as
// constructor arguments instead of importing it.
(function (global) {
  const DEFAULT_CROSSFADE = 0.35;

  // Map a character state to a clip it should play. A state with no entry falls
  // back to idle so an unknown state never leaves the model frozen. When a state
  // has several clips (idle alternates between two breathing clips) one is chosen
  // at random so the loop doesn't read as a metronome.
  function clipForState(manifest, state, rng) {
    const states = (manifest && manifest.states) || {};
    const pick = (list) => (list && list.length ? list[Math.floor((rng || Math.random)() * list.length)] : null);
    const entry = states[state];
    return pick(entry && entry.clips) || pick(states.idle && states.idle.clips) || null;
  }

  class AnimationState {
    /**
     * @param {object} env  { THREE, loader, vrm, baseClipFactory }
     *   loader           — a configured GLTFLoader (already registered with the
     *                      VRM + VRMA plugins) used to fetch the .vrma files.
     *   vrm              — the loaded VRM instance.
     *   baseClipFactory  — (vrmAnimations, vrm) => THREE.AnimationClip, i.e.
     *                      createVRMAnimationClip bound to the right signature.
     * @param {object} manifest  the anims.json shape: { states, clips, crossfade }
     * @param {string} animDir   base URL for the .vrma files (e.g. 'character/anims/')
     */
    constructor(env, manifest, animDir) {
      this.env = env;
      this.THREE = env.THREE;
      this.manifest = manifest || {};
      this.animDir = animDir || '';
      this.crossfade = (this.manifest && this.manifest.crossfade) || DEFAULT_CROSSFADE;
      this.mixer = new this.THREE.AnimationMixer(env.vrm.scene);
      this.actions = new Map();   // clipName -> THREE.AnimationAction
      this.current = null;        // clipName currently playing
      this.currentAction = null;
      this.oneShotReturn = null;  // clipName to ease back to when a one-shot ends
      this.ready = false;
      this.mixer.addEventListener('finished', this._onFinished);
    }

    // Fetch + retarget every clip in the manifest and build its AnimationAction.
    // Uses allSettled so one clip that fails to load (a 404, a bad file) only drops
    // that one action — the state that needs it falls back to procedural — instead
    // of rejecting the whole VRM mount. Resolves when every clip has been attempted.
    async loadAll() {
      const names = Object.keys((this.manifest.clips || {}));
      const results = await Promise.allSettled(names.map((n) => this._loadClip(n)));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.actions.delete(names[i]);
          if (typeof console !== 'undefined' && console.warn) console.warn(`animation clip ${names[i]} failed to load; that state will use the procedural pose`, r.reason);
        }
      });
      this.ready = true;
      return this;
    }

    async _loadClip(name) {
      const meta = this.manifest.clips[name];
      if (!meta) return;
      const url = this.animDir + meta.file;
      const gltf = await this.env.loader.loadAsync(url);
      const vrmAnimations = (gltf.userData && gltf.userData.vrmAnimations) || [];
      if (!vrmAnimations.length) throw new Error(`no VRMA in ${url}`);
      const clip = this.env.baseClipFactory(vrmAnimations[0], this.env.vrm);
      const action = this.mixer.clipAction(clip);
      action.setLoop(meta.loop === false ? this.THREE.LoopOnce : this.THREE.LoopRepeat, meta.loop === false ? 1 : Infinity);
      this.actions.set(name, action);
      return action;
    }

    // Switch to the clip for `state`, crossfading from whatever is playing.
    // Idle alternates between its breathing clips so the loop doesn't loop.
    setState(state) {
      const target = clipForState(this.manifest, state) || (this.manifest.clips && Object.keys(this.manifest.clips)[0]);
      return this.playClip(target);
    }

    // Play a named clip, crossfading in from the current one. Returns the action.
    // Idempotent: re-playing a clip that is already the current one is a no-op, so
    // callers can fire setState every time the app state ticks without restarting.
    playClip(name) {
      const action = this.actions.get(name);
      if (!action) return action;
      if (action === this.currentAction && action.isRunning()) {
        // Already playing this exact clip — leave the crossfade clock alone.
        return action;
      }
      if (this.currentAction && this.currentAction !== action) {
        this.currentAction.crossFadeTo(action, this.crossfade, false);
        // crossFadeTo fades the target in and the source out; make sure the source
        // is scheduled to stop so it doesn't keep fighting the fade.
        this.currentAction.fadeOut(this.crossfade);
      }
      action.reset().play();
      action.setEffectiveTimeScale(1);
      this.current = name;
      this.currentAction = action;
      this.oneShotReturn = null;
      return action;
    }

    // Play a one-shot clip (a nod, a wave, a bounce), then ease back to `returnTo`
    // when it finishes. Non-blocking: returns immediately with the action.
    playOnce(name, returnTo) {
      const action = this.playClip(name);
      if (action) {
        this.oneShotReturn = returnTo || clipForState(this.manifest, 'idle');
        // Hold the last pose instead of snapping to the rest pose while the return
        // clip crossfades in — otherwise the body jumps the moment the one-shot
        // ends and before the fade is even visible.
        if (action.clampWhenFinished !== undefined) action.clampWhenFinished = true;
      }
      return action;
    }

    _onFinished = (e) => {
      // A one-shot just ended — ease back to its return state. The return clip has
      // to go through playClip: a bare crossFadeTo fades it IN but never plays it,
      // so on the real mixer every action ends up at weight 0 and the body freezes
      // (and the additive overlay in character.js has nothing to ride on). playClip
      // also refreshes current/currentAction so the next setState crossfades from
      // the clip that is actually playing.
      if (this.oneShotReturn && e.action && e.action === this.currentAction) {
        const backName = this.oneShotReturn;
        this.oneShotReturn = null;
        this.playClip(backName);
      }
    };

    // Advance the mixer. Called once per frame by character.js BEFORE its own
    // procedural overlay and before vrm.update(dt).
    update(dt) { this.mixer.update(dt); }

    dispose() {
      try { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.env.vrm.scene); } catch {}
      this.actions.clear();
      this.currentAction = null;
      this.current = null;
      this.ready = false;
    }
  }

  global.LyraAnimation = { AnimationState, clipForState, DEFAULT_CROSSFADE };
})(typeof window !== 'undefined' ? window : globalThis);
