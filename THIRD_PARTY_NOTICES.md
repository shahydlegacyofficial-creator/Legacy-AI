# Third-party components

The code's MIT license applies to Legacy AI's original code. Dependencies,
vendored libraries, runtimes and model weights retain their original licenses.

The Windows installer includes package license files inside `node_modules`,
Node.js's license inside `runtime`, and these project notices inside `Licenses`.

| Component | License or terms | Upstream |
| --- | --- | --- |
| Node.js | MIT and bundled component notices | [nodejs/node](https://github.com/nodejs/node) |
| Kokoro JS and Kokoro default model | Apache-2.0 | [Kokoro](https://github.com/hexgrad/kokoro), [ONNX model](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| Transformers.js | Apache-2.0 | [huggingface/transformers.js](https://github.com/huggingface/transformers.js) |
| ONNX Runtime | MIT | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| agent-browser | Apache-2.0 | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| TensorFlow.js and COCO-SSD model | Apache-2.0 | [tensorflow/tfjs](https://github.com/tensorflow/tfjs), [tensorflow/tfjs-models](https://github.com/tensorflow/tfjs-models) |
| face-api.js and its model files | MIT | [justadudewhohacks/face-api.js](https://github.com/justadudewhohacks/face-api.js) |
| Anime.js | MIT | [juliangarnier/anime](https://github.com/juliangarnier/anime) |
| QRCode.js | MIT | [davidshimjs/qrcodejs](https://github.com/davidshimjs/qrcodejs) |
| Microsoft Visual C++ Redistributable | Microsoft redistribution terms | [Microsoft](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) |

Copies of the browser-library notices are in `legacy/public/vendor/licenses`.
Additional package identities and exact versions are recorded in
`legacy/package-lock.json`.

Optional external applications and account services have their own terms.
MuScriptor is optional and disabled by default. Check its model's
noncommercial restrictions before enabling it.
