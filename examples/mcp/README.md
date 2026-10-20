# MCP server for coding agents

`litert-ocr mcp` is an MCP server over stdio. Its tools read PDFs and images on this machine; nothing is sent anywhere.

| Tool | Arguments | Returns |
|---|---|---|
| `convert_to_markdown` | `uri` (`file:`, `data:`, or a path; `http(s):` only with `--allow-http`) | Markdown (the same name and contract as MarkItDown's MCP tool) |
| `convert` | `uri`, `to` (`md` / `json` / `text`), `options` (`pages`, `engine`, `layout`, `password`) | the document as Markdown, JSON (pages with status, blocks, tables) or text |
| `ocr_image` | `uri`, `lang` (tesseract code, default `eng`) | `{ text, lines: [{ text, bbox }] }` |
| `list_input_formats` | none | the formats and URI schemes the tools read |

All four are marked read-only (`readOnlyHint`).

## Claude Code

```sh
claude mcp add litert-ocr -- npx -y litert-ocr mcp
```

or put [`mcp.json`](mcp.json) in your project as `.mcp.json`.

## Claude Desktop

Add the `mcpServers` entry of [`mcp.json`](mcp.json) to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart Claude Desktop.

## From a checkout (before the package is published)

`npm install && npm run build` in the repository, then use [`mcp-local-checkout.json`](mcp-local-checkout.json): `node /path/to/litert-ocr/dist/cli.js mcp`. `--layout-model-base` points at the layout model files while they are not published (without it, pages are laid out by geometry). Flags: `--allow-http` (let tools fetch http(s) URIs), `--model-base DIR` (OCR model files from a directory).
