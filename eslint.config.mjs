import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  globalIgnores([".next/**", "out/**", "nextjs-ui/**", "skills/**", "tool-results/**", "src/components/tracker/**", "scripts/release/minimum-runtime-qa.ts"]),
]);
