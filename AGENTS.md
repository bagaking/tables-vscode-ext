# Repository Guidelines

## Project Structure & Module Organization
The VS Code extension entrypoint lives in `src/extension.ts`, where `CsvEditorProvider` wires up the custom editor and webview messaging. Browser-side assets sit in `media/main.js` and `media/main.css`; treat `media/` as the only folder served into the webview. Build artifacts are emitted to `dist/` by the TypeScript compiler and should not be edited directly. Sample CSV data such as `AN-12-synergy-cards.csv` is available at the repo root for manual smoke tests.

## Build, Test, and Development Commands
- `pnpm install` (or `npm install`): install extension and webview dependencies.
- `npm run compile`: transpile TypeScript to `dist/extension.js`; run before packaging or publishing.
- `npm run watch`: keep `tsc` running during development for live builds.
- Launch the VS Code Extension Development Host via `F5` (or `code --extensionDevelopmentPath=$(pwd)` ) to load the editor against local changes.

## Coding Style & Naming Conventions
Use TypeScript with two-space indentation, trailing semicolons, and single quotes, matching the existing sources. Prefer `const`/`let` over `var`, camelCase for functions and variables, and PascalCase for classes/types (e.g., `CsvEditorProvider`). Webview scripts rely on JSDoc typings for intellisense; keep `@type` annotations current when adjusting grid options. There is no automated formatter checked in, so run changes through your editor’s TypeScript formatter before committing.

## Testing Guidelines
No automated tests ship yet; rely on regression passes in the Extension Development Host. Use the sample CSV to verify load, edit, add/remove column and row interactions, and the Save button round-trip. When working on parsing, also test files with different newline styles to confirm `Papa.parse` integration. If you introduce automated tests, colocate them under `src/` and update `package.json` scripts accordingly.

## Commit & Pull Request Guidelines
The repository is at its initial commit; adopt concise, present-tense messages and prefer Conventional Commit prefixes (`feat:`, `fix:`, `chore:`) to keep the future history searchable. Reference related issues in the commit body when applicable. Pull requests should link issues (if any), describe UI-visible changes, and include screenshots or GIFs when modifying the grid experience. Highlight manual test coverage and note any follow-up work needed.

## Security & Configuration Tips
Keep the content security policy in `CsvEditorProvider.getHtmlForWebview` aligned with new resources; add local resource roots when bundling extra scripts. Avoid importing arbitrary node modules into the webview—bundle vetted assets into `media/` or the extension package instead of fetching at runtime.
## Future Enhancements
- Add mark-row templates and snippets for `@khgame/tables` decorators to reduce manual token editing.
- Highlight type tokens and validate inputs using the library parser to surface enum and `$ghost` issues inline.
- Expose CLI shortcuts for exporting JSON/TS and previewing outputs directly within the extension.
- Provide cross-sheet navigation and structured tree views to help inspect nested configurations.
