import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored static assets (MediaPipe WASM glue) and one-off node scripts.
    "public/**",
    "scripts/**",
  ]),
  {
    // This app is built around synchronizing React with external browser media
    // APIs (camera, image decode, MediaRecorder, debounced search). Setting
    // loading/status state inside those effects is the intended pattern, so
    // surface it as advisory rather than a hard error.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
