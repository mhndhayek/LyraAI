# Third-party software

Lyra AI Agent stands on these projects. Each keeps its own license.

| Project | Used for | License |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | the desktop window and runtime | MIT |
| [electron-builder](https://www.electron.build/) | compiling the installers | MIT |
| [ESLint](https://eslint.org/) | linting in the quality gate (development only) | MIT |
| [marked](https://github.com/markedjs/marked) | rendering markdown in chat | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | the phone pairing code | MIT |
| [KittenTTS](https://github.com/KittenML/KittenTTS) | text to speech in the voice sidecar | Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | speech to text in the voice sidecar | MIT |
| [three.js](https://threejs.org/) | 3D rendering for the VRM character (bundled in `renderer/vendor/three-vrm.min.js`) | MIT |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | loads and animates VRM avatars (same bundle) | MIT |
| [@pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm-animation) | retargets VRMA clips onto the VRM humanoid rig (same bundle) | MIT |
| [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans) | the Pixel theme's font | SIL Open Font License 1.1 |
| [Tailscale](https://tailscale.com/) | private network and HTTPS certificate for phone access (installed separately) | BSD-3-Clause client |

The runtime logos in `renderer/icons.js` (`window.BRANDS`) are the projects' own marks, shown only to say which server Lyra is connected to. They are trademarks of their owners and are not licensed under this repository's license:

| Logo | Source | Note |
| --- | --- | --- |
| llama.cpp | [ggml-org/llama.cpp `media/llama1-icon-transparent.svg`](https://github.com/ggml-org/llama.cpp/tree/master/media) | from the MIT-licensed repository |
| LM Studio | [files.lmstudio.ai/lmstudio_icon2.svg](https://files.lmstudio.ai/lmstudio_icon2.svg), path as packaged by [Simple Icons](https://simpleicons.org/) 16.34.0 | trademark of Element Labs |
| Ollama | [ollama/ollama](https://github.com/ollama/ollama), path as packaged by Simple Icons 16.34.0 | trademark of Ollama |
| vLLM | [vllm-project/media-kit](https://github.com/vllm-project/media-kit), path as packaged by Simple Icons 16.34.0 | trademark of the vLLM project |

The generic "OpenAI-compatible" plug is drawn for Lyra and is not anyone's mark.

The two built-in characters were generated with [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) and the Z-Image-Turbo model, then cut and animated by `scripts/make_character.py`.
Lyra's 3D model (`renderer/character/vrm/lyra.vrm`) is a recolour of AvatarSample_B by the [VRoid Project](https://vroid.com/) (pixiv), used under its VRoid Hub conditions, which allow modification, redistribution and commercial use without credit. The conditions stay embedded in the file and apply to it rather than this repository's license.

The ten animation clips in `renderer/character/anims/` are each documented in `renderer/character/anims/README.md`: the five from [vrm-viewer](https://github.com/tk256ailab/vrm-viewer) under the MIT terms the **author** grants in [vrm-viewer#11](https://github.com/tk256ailab/vrm-viewer/issues/11) (the repo's own README disclaims its animations, so its code licence does not cover them), and the five authored in Blender under this repository's own MIT licence.
