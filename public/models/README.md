# Portrait cutout model

`modnet-portrait-q8.onnx` is a quantized ONNX conversion of MODNet, a
trimap-free portrait matting model. It is generated during `postinstall` and
`prebuild`, verified before every build, and intentionally excluded from Git
history.

- Original project: https://github.com/ZHKKKe/MODNet
- Browser-ready conversion: https://huggingface.co/Xenova/modnet
- Model licence: Apache License 2.0
- Runtime: ONNX Runtime Web, MIT License
- SHA-256: `92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a`

The application self-hosts the model and runtime. A user's source image and
computed matte remain inside their browser.
