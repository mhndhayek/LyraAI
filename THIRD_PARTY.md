# Third-party software

Lyra AI Agent stands on these projects. Each keeps its own license.

| Project | Used for | License |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | the desktop window and runtime | MIT |
| [marked](https://github.com/markedjs/marked) | rendering markdown in chat | MIT |
| [PixiJS](https://pixijs.com/) and [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | Live2D characters | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | the phone pairing code | MIT |
| [KittenTTS](https://github.com/KittenML/KittenTTS) | text to speech in the voice sidecar | Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | speech to text in the voice sidecar | MIT |
| [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans) | the Pixel theme's font | SIL Open Font License 1.1 |
| [Tailscale](https://tailscale.com/) | private network and HTTPS certificate for phone access (installed separately) | BSD-3-Clause client |

Live2D Cubism Core is not included; the Live2D character option needs your own copy under Live2D's terms.
The built-in characters were generated with [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) and the Z-Image-Turbo model, then cut and animated by `scripts/make_character.py`.
