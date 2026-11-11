// The shared Vitest config discovers TypeScript tests only; import the existing
// JavaScript Playwright Page suite so its cases run in the normal CI test command.
import "../../../visual/wordpress-credentials-smoke.test.mjs";
