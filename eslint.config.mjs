import { builtinModules } from "node:module";
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
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "temp/**",
    "temp-shadowdark/**",
    "src/tests/**",
    "scripts/**",
    "src/scripts/**",
    // External module repos — linted by their own configs, excluded from platform tsconfig
    "data/**"
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-require-imports": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "prefer-const": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  {
    files: [
      "src/client/ui/components/Dice/**/*.{ts,tsx}",
      "src/client/ui/components/Settings/**/*.{ts,tsx}",
      "src/client/ui/context/chatToast.ts",
      "src/client/ui/context/liveChatInbox.ts",
      "src/client/ui/context/DicePresentationContext.tsx"
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "error",
      "no-restricted-globals": ["error", "process", "Buffer", "__dirname", "__filename", "module", "require"],
      "no-restricted-imports": ["error", {
        paths: builtinModules.filter(name => !name.startsWith("node:")).map(name => ({
          name,
          message: "Dice presentation must remain browser-only."
        })),
        patterns: [{
          group: ["node:*", "@server", "@server/**", "@core", "@core/**", "**/server/**", "**/scripts/**", "@sheet-delver/sdk/server"],
          message: "Dice presentation consumes client contexts, never server services or Node APIs."
        }]
      }],
      "no-restricted-syntax": ["error", {
        selector: "ImportExpression[source.value!= '@3d-dice/dice-box-threejs']",
        message: "The dice UI only dynamically loads its pinned browser renderer."
      }]
    }
  }
]);

export default eslintConfig;
