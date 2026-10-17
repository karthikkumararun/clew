# Contributing to Clew

Thank you for helping. Clew is built spec first: a change starts as a written proposal, and the code follows it.

## Set up

You need Node 20+ (22 is what CI uses), [pnpm](https://pnpm.io), a stable Rust toolchain, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (macOS or Windows; Linux builds but is not a target).

```sh
pnpm install
pnpm tauri dev          # run the app
pnpm test               # frontend tests (Vitest)
pnpm typecheck && pnpm lint
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
```

Database integration tests and the end-to-end suites need Docker: `pnpm qa:up`, `pnpm qa:e2e`, `pnpm qa:down` (see `docs/qa/README.md`).

## The OpenSpec workflow

Specs live in `openspec/`. For anything user-visible:

1. **Propose** with `/opsx:propose <name>` (or write `openspec/changes/<name>/` by hand): `proposal.md` (why), `specs/**/spec.md` (requirements and scenarios, which become tests), `design.md` (how), `tasks.md` (checklist).
2. **Check** with `openspec validate <name> --strict`.
3. **Build** with `/opsx:apply <name>`, ticking tasks as you go. Turn scenarios into tests; every change that has user-visible behaviour ends with an end-to-end journey.
4. **Archive** with `/opsx:archive <name>` once it is merged, so the specs join `openspec/specs/`.

`CLAUDE.md` has the build order and the rules that matter (design tokens only, secrets in the keychain, everything slow is async and cancellable, AI never executes SQL).

## Pull requests

- Branch from `main`; `main` is protected, so changes arrive by pull request.
- Before you push: `pnpm typecheck && pnpm lint && pnpm test`, the Rust checks above, and `openspec validate --all --strict`.
- **Fixing a defect** (branch `fix/<issue>-<slug>`): write the failing test first, at the lowest level that can see the defect (layout and clipping bugs need a real-render test; jsdom cannot see them). In the pull request link the issue, name the spec scenario and the defect class (`docs/qa/defect-classes.md`), and say what guards the whole class.
- UI work uses the tokens in `src/styles/tokens.css` and matches the canvas screens in `design/canvas/`; no hard-coded colours.

## Reporting problems

Use the issue templates. For security issues follow [SECURITY.md](SECURITY.md) instead.

## Conduct

Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the MIT License.
