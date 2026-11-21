# Contributing

Delve is developed in the open. Please discuss substantial changes in an issue before investing in an implementation. Small fixes and documentation improvements are welcome as pull requests.

Use Node.js 24 and npm. Run `npm ci`, then `npm run dev` to start the desktop app. Before submitting, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:smoke` with a display available (on Linux, `xvfb-run --auto-servernum -- npm run test:smoke`). Include tests for changed behavior and update documentation where needed. Commit the lockfile with dependency changes.

Do not include credentials, private repository content, generated build output, or user data in a contribution. Report security issues privately as described in [SECURITY.md](SECURITY.md). Contributions are licensed under the [MIT license](LICENSE).
