import { initSentry } from "./src/utils/sentry"

// Medusa runs this before it loads anything else, so Sentry sees every request.
export function register() {
  initSentry()
}
