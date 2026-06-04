# Crystallize - Implementation Spec

One-liner: Crystallize your Copilot conversations into lasting knowledge - summarized by AI, saved as Markdown.

## 1. Overview

Crystallize adds one on-demand command in VS Code. When invoked, it:
1. Opens a paginated picker of local Copilot chat sessions.
2. Parses the selected session.
3. Optionally captures a Linear issue ID (prefilled from current git branch when available).
4. Renders a prompt template with runtime variables.
5. Sends prompt + transcript to the VS Code Language Model API (vscode.lm) through GitHub Copilot Chat.
6. Expects a structured JSON response: { filename, summary }.
7. Writes a Markdown file with frontmatter, summary, and optional full transcript.

Current scope:
- On-demand command only: Crystallize: Save Conversation
- Session picker pagination from local chatSessions storage
- Structured JSON response parsing
- File output with collision-safe naming
- No direct provider API integrations or key management

Out of scope:
- Background/automatic saves
- Streaming UI for model output
- Direct HTTP calls to OpenAI or Anthropic
- API key storage and management

## 2. Architecture

Repository modules:
- src/extension.ts: command activation and end-to-end orchestration
- src/sessionReader.ts: workspace storage resolution and session parsing
- src/sessionPicker.ts: paginated QuickPick experience
- src/promptRenderer.ts: variable substitution and conditional blocks
- src/markdownRenderer.ts: transcript and output rendering
- src/llmClient.ts: vscode.lm model selection, request, and JSON parsing
- src/fileWriter.ts: output folder resolution and write/collision handling

No secretsManager module is part of this architecture.

## 3. Package Manifest Contract

Key manifest behavior:
- Command contributed: crystallize.saveConversation
- Activation event: onCommand:crystallize.saveConversation
- Extension dependency: github.copilot-chat
- Minimum engine: vscode ^1.85.0

Supported configuration keys:
- crystallize.outputFolder (resource)
- crystallize.maxTokens
- crystallize.summaryPrompt
- crystallize.includeFullTranscript
- crystallize.maxTranscriptChars
- crystallize.pickerPageSize (resource)

Unsupported/removed configuration keys:
- crystallize.llmProvider
- crystallize.model

## 4. Functional Flow

Save Conversation command flow:
1. pickSession() returns selected metadata or undefined if cancelled.
2. parseSession(meta) returns full turn list.
3. Prompt for optional Linear issue ID; prefill from branch match ([A-Z]+-\d+).
4. Build PromptContext and renderPrompt(summaryPrompt, context).
5. Render transcript and truncate when exceeding maxTranscriptChars.
6. Call summarize(transcript, renderedPrompt, maxTokens, cancellationToken).
7. Parse and sanitize model JSON output.
8. Render final markdown.
9. Write output file and show success notification.

Cancellation and failures:
- Cancelled picker exits silently.
- Parse/read/model failures surface as user-facing error messages.

## 5. Module Contracts

### 5.1 sessionReader.ts

Exports:
- getSessionsMeta(offset, limit): Promise<ChatSessionMeta[]>
- parseSession(meta): Promise<ChatSession>

Responsibilities:
- Resolve workspace storage by matching descriptor folder to active workspace.
- Support descriptor files: workspace.json and meta.json.
- Read chatSessions files in .json and .jsonl formats.
- Sort by modified time descending.
- Return lightweight metadata for list views.
- Parse full turns when a session is chosen.
- Tolerate malformed JSONL lines during parse (skip + warn).

### 5.2 sessionPicker.ts

Exports:
- pickSession(): Promise<ChatSessionMeta | undefined>

Responsibilities:
- Use createQuickPick for in-place item updates.
- Show first page using crystallize.pickerPageSize (default 5).
- Append a load-more action when additional sessions exist.
- Keep picker open while loading more pages.
- Return undefined on cancel.

### 5.3 promptRenderer.ts

Exports:
- renderPrompt(template, context): string
- PromptContext interface with:
  - date
  - time
  - sessionId
  - turnCount
  - firstMessage
  - workspaceName
  - model
  - linearIssueId

Rules:
- Supports variable tokens: {{name}}.
- Supports conditional blocks: {{name}}...{{/name}}.
- Unknown tokens are preserved as-is.

### 5.4 markdownRenderer.ts

Exports:
- renderTranscript(session): string
- renderOutputFile(filename, summary, session, linearIssueId, includeTranscript): string

Output includes:
- YAML frontmatter with sessionId, date, model, source, and optional linearIssueId.
- Summary section.
- Optional full transcript section.

Notes:
- Transcript escapes triple backticks inside turn content.

### 5.5 llmClient.ts

Exports:
- summarize(transcript, renderedPrompt, maxTokens, token): Promise<LLMResult>

Responsibilities:
- Select a chat model using vscode.lm.selectChatModels({ vendor: 'copilot' }).
- Send a single user message containing prompt and transcript.
- Stream text chunks and concatenate raw response text.
- Parse JSON response and validate filename/summary shape.
- Sanitize filename to a safe slug.

Error behavior:
- Missing model: actionable Copilot availability message.
- Invalid JSON: explicit parse guidance.
- Unexpected shape: explicit response-shape error.
- Cancellation: cancellation message.
- Other model errors: generic Copilot availability error.

### 5.6 fileWriter.ts

Exports:
- writeOutput(content, filenameSlug): Promise<string>

Responsibilities:
- Resolve output folder from setting or workspace fallback.
- Ensure directory exists.
- Write using YYYY-MM-DD_<slug>.md pattern.
- Add _2, _3, ... suffix on name collisions.
- Show success notification with full output path.

## 6. Prompt Variables

Supported variables:
- {{date}}
- {{time}}
- {{sessionId}}
- {{turnCount}}
- {{firstMessage}}
- {{workspaceName}}
- {{model}}
- {{linearIssueId}}

Conditional block example:
{{linearIssueId}}Linear issue: {{linearIssueId}}{{/linearIssueId}}

## 7. Acceptance Criteria

Commands and config:
- Command palette shows Crystallize: Save Conversation.
- No Set API Key command is contributed.
- package.json contains no provider/model settings for direct APIs.

Session picker:
- Opens promptly and lists recent sessions.
- Shows label, relative time, and turn/date detail.
- Supports in-place Load N more behavior.
- Cancel exits without error toast.

Prompt rendering:
- Token substitution works for all listed variables.
- Conditional blocks are included only for truthy values.
- Unknown tokens remain untouched.

LM integration:
- Summarization uses vscode.lm via Copilot vendor selection.
- Structured JSON parsing returns filename + summary.
- Fenced JSON responses are accepted.
- Invalid JSON or shape produces readable errors.

Output:
- File name format is date-prefixed slug markdown.
- Output folder resolves by setting, else workspace root.
- Frontmatter includes sessionId/date/source and optional linearIssueId.
- Transcript section obeys includeFullTranscript.

## 8. Non-Functional Requirements

- Security: No API key collection, storage, or direct secret handling.
- Reliability: Malformed local session lines do not crash entire flow.
- Performance: Picker metadata loading remains lightweight.
- User feedback: Errors and success are surfaced via VS Code notifications.
- Runtime dependencies: VS Code API + Node stdlib only.

## 9. Development Checklist

- npm run compile passes.
- npm run package produces installable VSIX.
- Session picker validated against real local chatSessions data.
- End-to-end run validated in Extension Development Host.
- README and CHANGELOG stay consistent with this spec.
