# Changelog

All notable changes to the **Crystallize** extension will be documented
in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-06-04

### Added

- Command: `Crystallize: Save Conversation`
- Session reader for VS Code `chatSessions` with `.json` and `.jsonl` support
- Paginated session picker with relative timestamps and load-more action
- Prompt renderer with `{{variable}}` substitution
- LLM client using VS Code Language Model API (`vscode.lm`) with structured JSON parsing
- Markdown renderer for summary and optional full transcript output
- Output writer with dated slug filenames and collision suffix handling
- VSIX packaging configuration aligned with Crystallize artifact contents
