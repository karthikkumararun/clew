/** End-to-end builds only (`VITE_CLEW_E2E=1`); the bundler drops it from every other build. */
export const MIRROR_ENABLED = import.meta.env.VITE_CLEW_E2E === "1";
