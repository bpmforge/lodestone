import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Extends vitest's defaults (node_modules, dist, …) rather than replacing
    // them — dropping the spread would silently re-enable scanning node_modules.
    //
    // `.claude/**` holds per-agent git worktrees. A worktree is a SECOND FULL
    // CHECKOUT of this repo, so without this exclusion `vitest run` collects the
    // other checkout's test files too: an 27-file / 228-test suite reported as
    // 81 files / 703 tests, with "failures" that belong to another agent's
    // in-progress branch rather than to this tree.
    //
    // Gitignoring `.claude/` does NOT fix this — vitest resolves test files by
    // glob and does not consult `.gitignore`. The sibling Shipwright repo hit
    // the identical problem in its ESLint root for the same reason.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
