// Flat config. Type-aware rules are deliberately NOT enabled yet: they need a
// project reference and roughly triple lint time, and this config lands in
// advisory mode where the goal is a readable finding count, not maximum depth.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Declared by hand instead of pulling in the `globals` package, so the lint
// step adds no dependency beyond eslint itself. Limited to the Node globals
// this codebase actually references (confirmed from the real no-undef
// findings), not the full Node global list.
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  fetch: "readonly", // global since Node 18; build-bundle.mjs fetches the locked native tarballs with it
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  // build/** is a second compiled-output directory (gitignored, distinct from
  // dist/**) produced by an older build step; without this it was linted as
  // if it were source, worth ~109 of the original 169 findings.
  // extracted/**, artifact/** and tmp-*/** are what verify-bundle-runtime.mjs
  // leaves behind when run locally with the same arguments CI uses; eslint's
  // flat config does not read .gitignore, so without these the now-blocking
  // lint fails locally on extracted plain-JS server files while CI (which
  // never creates them on the lint leg) stays green.
  { ignores: ["dist/**", "build/**", "node_modules/**", "coverage/**", "*.mcpb", "extracted/**", "artifact/**", "tmp-*/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: nodeGlobals },
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
    // disableTypeChecked ships its own languageOptions (parserOptions only);
    // spreading it after a plain `languageOptions: { globals }` key would
    // silently replace that key instead of merging with it, so the globals
    // are merged in explicitly here.
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: nodeGlobals,
    },
  },
);
