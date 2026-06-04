# Crystallize

Crystallize turns GitHub Copilot Chat sessions into structured Markdown notes.
You choose a session from a paginated picker, Crystallize summarizes it with the active GitHub Copilot Chat model, and saves a dated Markdown file with summary and optional full transcript.

## Features

- On-demand save command (no background polling)
- Paginated recent-session picker from local `chatSessions` storage
- Prompt templating with runtime variables
- Structured LLM response parsing (`{ filename, summary }`)
- Uses VS Code Language Model API (`vscode.lm`) via GitHub Copilot Chat
- Markdown output with frontmatter + summary + optional transcript

## Commands

- `Crystallize: Save Conversation`

## Settings

- `crystallize.outputFolder`
- `crystallize.maxTokens`
- `crystallize.summaryPrompt`
- `crystallize.includeFullTranscript`
- `crystallize.maxTranscriptChars`
- `crystallize.pickerPageSize`

## Install And Build

```bash
npm install
npm run compile
npm run package
```

This creates `crystallize-0.1.0.vsix` in the project root.

## Development

Open the workspace in VS Code and press `F5` to launch an Extension Development Host.

## Privacy

Crystallize only reads local VS Code chat session files and writes Markdown output to your configured folder (or workspace root fallback). LLM calls are routed through VS Code's Copilot Chat integration.
