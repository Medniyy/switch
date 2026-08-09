# General-subject cutout model

`u2netp-general.onnx` is the compact U²-Netp salient-object model. It is
generated during `prebuild`, verified before every build, and intentionally
excluded from Git history.

- Original project: https://github.com/xuebinqin/U-2-Net
- ONNX distribution: https://github.com/danielgatis/rembg/releases/tag/v0.0.0
- Model licence: Apache License 2.0
- Runtime: ONNX Runtime Web, MIT License
- SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`

The application self-hosts the model and runtime. A user's source image and
computed matte remain inside their browser.
