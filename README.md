# Crystallize

Crystallize turns GitHub Copilot Chat sessions into structured Markdown notes.
You choose a session from a paginated picker, Crystallize summarizes it with your configured LLM provider, and saves a dated Markdown file with summary and optional full transcript.

## Features

- On-demand save command (no background polling)
- Paginated recent-session picker from local `chatSessions` storage
- Prompt templating with runtime variables
- Structured LLM response parsing (`{ filename, summary }`)
- OpenAI and Anthropic provider support
- API keys stored in VS Code SecretStorage
- Markdown output with frontmatter + summary + optional transcript

## Commands

- `Crystallize: Save Conversation`
- `Crystallize: Set API Key`

## Settings

- `crystallize.outputFolder`
- `crystallize.llmProvider`
- `crystallize.model`
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

Crystallize only reads local VS Code chat session files and writes Markdown output to your configured folder (or workspace root fallback). Network calls are only made to the configured LLM provider.
