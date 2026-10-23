# harness-coding-lab

To install the locked dependencies:

```bash
bun install --frozen-lockfile
```

Commit `bun.lock` together with `package.json` when adding or updating dependencies.
The project-level `bunfig.toml` uses the public npm registry so user-level registry
settings do not rewrite the lockfile's download URLs. Keep personal registry
credentials in your user-level configuration.

To add a dependency and update the lockfile:

```bash
bun add <package>
```

To run:

```bash
bun run dev
```

To run the quality gate:

```bash
bun run check
```

This project was created using `bun init` in bun v1.4.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
