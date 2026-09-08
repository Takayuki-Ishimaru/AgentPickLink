import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "scripts/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "error"
    }
  },
  {
    // The VS Code webview panel script (see docs/architecture.md's "VS Code extension" section):
    // framework-free browser JS, not bundled or type-checked, so it gets its own lint coverage
    // rather than the TS project's. The file already declares its browser globals itself via a
    // `/* global acquireVsCodeApi, document, window, setTimeout */` comment, which ESLint's
    // no-undef honors natively -- declaring the same names again here would make no-redeclare
    // flag that comment as redundant, so only `clearTimeout` (not currently used, but named in
    // the same family of DOM timer globals) is added here instead of in the file itself.
    files: ["media/**/*.js"],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: 2020,
      globals: {
        clearTimeout: "readonly"
      }
    },
    rules: {
      "no-console": "error",
      "no-undef": "error"
    }
  }
);
