# Contributing

Thanks for helping make Coreflux easier to use from Cursor. This guide covers how the repository
is laid out, how to run the checks CI runs, and how changes get released.

## Ground rules

- **The broker parser is the source of truth.** Every LoT snippet in a skill, rule, command or
  test must deploy on a current Coreflux broker. If the docs and the parser disagree, fix the docs.
- **LoT is the only configuration language** for actions, models, routes, rules, panels and
  themes. Do not introduce JSON/YAML alternatives.
- **No npm dependencies** in the plugin. The MCP server and hooks must keep running with a bare
  Node.js ≥ 20 install, because they execute on every contributor's machine.
- **Never weaken the safety hooks** (`plugins/coreflux/scripts/hooks/`). Adding a new destructive
  broker verb means adding it to `lib/destructive.mjs` *and* a test.
- Secrets never appear in examples. Use `GET ENV` / `GET SECRET` and name the `-setSecret` key.

## Repository layout

```
.cursor-plugin/marketplace.json     marketplace manifest (lists the plugins in this repo)
plugins/coreflux/                   the plugin
  .cursor-plugin/plugin.json        plugin manifest + user variables
  mcp.json                          MCP servers (docs + broker)
  scripts/mcp/                      the coreflux-broker MCP server and its libraries
  scripts/hooks/                    Cursor hooks (session context, destructive-command guards)
  skills/  rules/  agents/  commands/
  test/                             node:test suites (offline, with an in-process fake broker)
scripts/                            repo tooling: validate, check, package, release gates
.github/workflows/                  CI, release, PR title, labeler
```

## Running the checks

```bash
npm run validate   # plugin structure + frontmatter
npm run check      # versions in sync, hooks/mcp wiring, docs mention real tools, LF endings
npm test           # unit + offline end-to-end tests (fake MQTT broker, spawned MCP server)
npm run ci         # all of the above
```

Against a real broker (the CI integration job uses `coreflux/coreflux-mqtt-broker:latest`):

```bash
docker run --rm -p 1883:1883 -p 9100:9100 coreflux/coreflux-mqtt-broker:latest
export COREFLUX_MQTT_URL=mqtt://127.0.0.1:1883 COREFLUX_MQTT_USERNAME=root COREFLUX_MQTT_PASSWORD=coreflux
npm run smoke      # read-only
npm run e2e        # deploys throw-away entities, drives them, removes them
```

## Making a change

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Add or update tests in `plugins/coreflux/test/`. Linter rules need both a passing and a
   failing case; new MCP tools need a fake-broker test; new hook behaviour needs a hook test.
3. Update the relevant skill/rule text and `CHANGELOG.md` under **Unreleased**.
4. Run `npm run ci`.
5. Open a pull request with a [Conventional Commits](https://www.conventionalcommits.org/) title
   (`feat: …`, `fix: …`, `docs: …`, `ci: …`, `chore: …`). CI must be green; PRs are squash-merged
   and the title becomes the commit message.

### Writing skills and rules

- Keep examples copy-pastable. Prefer realistic names (`PackagingLine`, `PLC_Modbus`) over
  `foo`/`test`.
- Action, model, route and rule names are bare identifiers; panel and theme names are quoted.
- Cite [docs.coreflux.org](https://docs.coreflux.org) pages for route settings rather than
  duplicating them.
- Every MCP tool you mention must exist in `coreflux-mqtt-mcp.mjs` (`npm run check` enforces it).

## Releasing (maintainers)

1. `node scripts/bump-version.mjs X.Y.Z` — updates `package.json`, `plugin.json`,
   `marketplace.json`, the MCP server version and opens a `CHANGELOG.md` section.
2. Move the **Unreleased** entries into the new section, review, commit `chore: release vX.Y.Z`.
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. The **Release** workflow re-runs every check plus the broker e2e, packages
   `coreflux-plugin-X.Y.Z.zip` (+ SHA-256) and publishes a GitHub release with the changelog
   section as its notes. Pre-release versions (`1.0.0-rc.1`) are marked as such.

## Reporting problems

Use the issue templates. For security issues follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
