// Entry for renderer/vendor/three-vrm.min.js: exposes window.LyraVRM.
// Story 09 adds the VRMA (VRM Animation) playback stack: the loader plugin turns a
// .vrma into gltf.userData.vrmAnimations, createVRMAnimationClip retargets it to a
// VRM's humanoid bones into a THREE.AnimationClip, and VRMAnimation plays it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
window.LyraVRM = { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin, createVRMAnimationClip };
