// Flat config without type-aware rules, which need a project reference and slow linting.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Node globals this codebase uses, declared by hand to avoid the `globals` package.
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  fetch: "readonly", // global since Node 18; used by build-bundle.mjs
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  // Generated output: build/ staging, plus extracted/, artifact/ and tmp-*/ from bundle verification.
  { ignores: ["dist/**", "build/**", "node_modules/**", "coverage/**", "*.mcpb", "extracted/**", "artifact/**", "tmp-*/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: nodeGlobals },
    rules: {
      // Warn only: puppeteer's untyped options bag is typed loosely.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    ...tseslint.configs.disableTypeChecked,
    // Merge globals into disableTypeChecked's languageOptions instead of replacing them.
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: nodeGlobals,
    },
  },
);
