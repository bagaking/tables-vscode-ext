# Tables CSV Editor

![CI](https://github.com/bagaking/tables-vscode-ext/actions/workflows/ci.yml/badge.svg)

Tables CSV Editor is a VS Code custom editor for working with CSV files as a grid while keeping the source CSV as the file of record. It is built for ordinary CSV editing and for `@khgame/tables` sheets that use Mark / Desc header rows, type tokens, enum columns, aliases, and `tid` identifiers.

The extension contributes a `*.csv` custom editor, a raw CSV inspection view, and a command for exporting the active CSV file as a GitHub Flavored Markdown table.

## Install

### From a packaged VSIX

Until a registry release is available, install a locally built VSIX:

```bash
pnpm install --frozen-lockfile
pnpm run package:vsix
code --install-extension "$(ls -t *.vsix | head -n1)"
```

You can also run the repository helper after packaging:

```bash
pnpm run install:local
```

### From Marketplace or Open VSX

The repository includes publish scripts for the VS Code Marketplace and Open VSX, but publishing is gated by the release checks in [Release](#release). Do not assume a registry package exists unless the project has cut one there.

## Use

- Open a `*.csv` file. VS Code loads it with the `Tables CSV Editor` custom editor by default.
- Use the command palette command `Tables: Open CSV in Tables Editor` when you need to reopen a CSV in the grid editor.
- Edit cells in the table view, then use the webview `Save` action to write changes back to the CSV file.
- Switch to the raw view to inspect delimiters, quoted values, numeric fragments, and line endings without leaving the editor.
- Run `Tables: Export CSV as GFM Markdown` to write the current CSV as a GitHub Flavored Markdown table.
- Run `Tables: Run Diagnostics (Tables CSV Editor)` when debugging the active webview state.

## Features

### Grid editing

- AG Grid table editing for CSV rows and columns.
- Row and column context menu actions for adding and removing rows or columns.
- Header and content based auto-width calculation with a fixed row-number column.
- Mark and Desc rows pinned at the top when detected.
- Consecutive `@`, `alias`, and `enum` data columns pinned on the left.
- Bracket-depth coloring for `()[]{}` content.
- Visual treatment for optional / required markers, comment columns, and type columns.

### Raw CSV inspection

- Raw text mode for checking the underlying CSV directly.
- Delimiter coloring for comma, semicolon, and tab-separated content.
- Numeric highlighting for whole-cell numbers and numeric fragments.
- Parsing through `Papa.parse`, preserving the original newline style and final newline behavior.

### Markdown export

- `Tables: Export CSV as GFM Markdown` writes a GitHub Flavored Markdown table.
- The export escapes `|` characters and preserves multiline cell content as `<br/>`.

### `@khgame/tables` assistance

- Detects Mark rows by sampling the first 16 rows for tokens such as `@`, `$ghost`, `$strict`, `enum<...>`, `map`, and `pair`.
- Classifies column types such as `@`, `alias`, `enum`, `tid`, `struct`, `comment`, and `default`.
- Reads enum candidates from `context.*.json` files in the workspace or parent directories, including `context/`, `contexts/`, and `.context/` directories.
- Supports enum fallback values declared in `enum<Name|Fallback1|...>`.
- Shows enum values as labels and edits enum cells with a dropdown while preserving raw values that are not in the candidate set.
- Lets the row-number context menu copy the first detected `tid` column value.

### VS Code integration

- Uses VS Code theme variables inside the webview.
- Runs under a strict webview Content Security Policy with nonce-based scripts.
- Reacts to external file changes, including branch switches.
- Keeps the webview resource surface local to packaged extension assets.

## Known Constraints

- The extension is scoped to CSV files matched by the contributed `*.csv` custom editor.
- Registry availability depends on an explicit Marketplace or Open VSX release; local VSIX installation is the reliable install path before that.
- Enum discovery only covers local `context.*.json` files and common context directories. Reference-style enum data still needs to come from the `@khgame/tables` toolchain.
- The package inspection gate checks publish boundaries, not every runtime behavior of the editor.
- Automated tests cover current parser and utility behavior. UI interaction changes still need manual smoke testing in the Extension Development Host.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm run compile
pnpm test
```

For an interactive development loop:

1. Run `pnpm run watch`.
2. Open this repository in VS Code.
3. Press `F5` to launch the Extension Development Host.
4. Open files from `example/` or another `*.csv` file.
5. Smoke test load, edit, add / remove row, add / remove column, raw view, export, and save round-trip behavior.

Project layout:

- `src/extension.ts` registers the extension commands, custom editor, and webview messaging.
- `src/features/khTables/` contains `@khgame/tables` detection, state, and enum context parsing.
- `media/` contains the webview runtime assets served into VS Code.
- `dist/` is TypeScript compiler output and is packaged with the extension.
- `example/` contains CSV files for manual smoke tests.
- `tests/` contains Node-based parser and utility tests.

## Validate

Run the same core checks used for local release confidence:

```bash
pnpm install --frozen-lockfile
pnpm run ci
pnpm run package:inspect
git diff --check
git diff --cached --check
```

`pnpm run ci` compiles TypeScript, runs the Node test suite, and builds a VSIX package. `pnpm run package:inspect` runs `scripts/check-package-boundary.js`, which executes `vsce ls` and fails if denied files would enter the extension package.

## VSIX Package Boundary

The extension package should contain runtime-ready assets only. The expected package surface is limited to files such as:

- `dist/`
- `media/`
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `package.json`

The package boundary check denies maintainer, source, test, local artifact, lockfile, and secret-shaped paths, including:

- `.github/`, `.vscode/`, `example/`, `scripts/`, `src/`, and `tests/`
- existing `.vsix` archives
- `.env`, `.npmrc`, `.netrc`, key files, token / secret / credential-shaped names
- `AGENTS.md`, `requirements.md`, `tsconfig.json`, and lockfiles

Keep `.vscodeignore` and `scripts/check-package-boundary.js` aligned when changing the package surface.

## Release

Use the full prepublish gate before publishing anywhere:

```bash
pnpm run prepublish:check
```

That command runs compile, tests, VSIX packaging, package listing, and the package boundary denylist check.

After the gate passes:

- VS Code Marketplace: set `VSCE_PAT` or authenticate with `vsce`, then run `pnpm run publish:marketplace`.
- Version bump publish: run `pnpm run publish:marketplace:patch`, `pnpm run publish:marketplace:minor`, or `pnpm run publish:marketplace:major`.
- Open VSX: set `OVSX_TOKEN`, then run `pnpm run publish:openvsx`.

Generated `.vsix` files are local release artifacts. Do not keep historical VSIX archives by nesting them into future extension packages; use GitHub Releases, Marketplace, or Open VSX version records instead.

## Security

- The webview uses `default-src 'none'` and nonce-based scripts.
- Runtime webview resources should be bundled locally under `media/`.
- Do not fetch arbitrary scripts at runtime from the webview.
- Review the CSP in `src/extension.ts` whenever adding new webview assets.

## License

This project is licensed under the [MIT License](LICENSE).
