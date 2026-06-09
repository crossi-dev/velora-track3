import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Allow unused vars that start with _ (intentional ignores)
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Allow empty catch blocks (common in your codebase)
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Block explicit any — enforce at error level to prevent regressions
      "@typescript-eslint/no-explicit-any": "error",
      // Not critical — we'll add error causes later
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      // React hooks rules — plugin now installed (eslint-plugin-react-hooks@7)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // ── Code size contract (warn-level) ────────────────────────────────────
  // Hard ceiling enforced at build time by scripts/check-file-size.mjs.
  // ESLint warnings here exist so the violation surfaces in editor LSP
  // before the developer pushes.
  //
  // Limit raised from 50 → 150: the 50-line rule produced 200+ warnings on
  // legitimate code (PDF renderers, validators, parsers) and obscured real
  // issues. 150 is a meaningful signal — functions that exceed it genuinely
  // need review.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/generated/**"],
    rules: {
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  // ── Route handlers: limit off ──────────────────────────────────────────
  // Next.js App Router enforces one handler per file (POST, GET, etc.).
  // Each file is already single-responsibility by definition — the function
  // length limit adds no signal here and only produces noise.
  {
    files: ["src/app/api/**/*.ts"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
  // ── React hooks: limit off ─────────────────────────────────────────────
  // Custom hooks are composition roots: they wire together multiple
  // sub-hooks, state declarations, effects, and callbacks that must live
  // in the same scope to share refs and closures. Extracting sub-functions
  // purely to satisfy a line count creates artificial seams and breaks the
  // mental model. File-level ceiling (400 lines, enforced by check:file-size)
  // remains the meaningful constraint for hooks.
  {
    files: ["src/app/dashboard/lib/hooks/**/*.ts", "src/app/dashboard/lib/hooks/**/*.tsx"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
  {
    ignores: ["src/generated/**", "node_modules/**", ".next/**", "tests/**", "scripts/**"],
  }
);
