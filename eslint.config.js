// Flat config. Type-aware rules are deliberately NOT enabled yet: they need a
// project reference and roughly triple lint time, and this config lands in
// advisory mode where the goal is a readable finding count, not maximum depth.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "*.mcpb"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // The codebase uses `Record<string, unknown>` for puppeteer's untyped
      // options bag on purpose; flagging it adds noise, not safety.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    ...tseslint.configs.disableTypeChecked,
  },
);
