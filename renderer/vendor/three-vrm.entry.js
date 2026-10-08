// Entry for renderer/vendor/three-vrm.min.js: exposes window.LyraVRM.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
window.LyraVRM = { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils };
