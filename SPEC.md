# Crystallize — Implementation Spec

> **One-liner:** Crystallize your Copilot conversations into lasting knowledge — summarized by AI, saved as Markdown.
>
> **Base:** Forked from `dwalter/copilot-chat-saver`. Strip auto-save polling. Keep: storage path resolution, `.json`/`.jsonl` parser, Markdown renderer.

---

## 1. Overview

Crystallize adds a single on-demand command to VS Code. When triggered, it opens a session picker, lets the user select a Copilot chat session, sends the transcript to an LLM, and writes the summary + full transcript as a Markdown file to a user-configured folder. The LLM returns both the summary and a descriptive filename as structured JSON in one call.

**Scope of v1:**
- On-demand command only (no auto-save)
- Session picker: shows 5 most recent sessions by default, paginated in groups of 5
- LLM returns structured JSON: `{ filename, summary }`
- Supports OpenAI and Anthropic as LLM providers
- Configurable output folder, prompt, provider, model, and max tokens
- Prompt supports runtime variables: `{{date}}`, `{{time}}`, `{{sessionId}}`, `{{turnCount}}`, `{{firstMessage}}`, `{{workspaceName}}`, `{{model}}`, `{{linearIssueId}}`
- API keys stored in `vscode.SecretStorage` (never in plaintext settings)

**Out of scope for v1:**
- Streaming LLM responses
- Automatic/scheduled saves
- Local/offline LLM support
- Git commit or Obsidian sync integration

---

## 2. Repository Structure

Start from the forked `copilot-chat-saver`. Delete or gut `src/extension.ts` and rebuild. Keep `package.json` as scaffold — update name, publisher, commands, and configuration schema.

```
crystallize/
├── src/
│   ├── extension.ts          # Entry point: activate(), register commands
│   ├── sessionReader.ts      # Locate + parse chatSessions/ from workspaceStorage
│   ├── sessionPicker.ts      # QuickPick UI: paginated session selector
│   ├── promptRenderer.ts     # Variable substitution in prompt template
│   ├── markdownRenderer.ts   # Convert parsed session → Markdown string
│   ├── llmClient.ts          # OpenAI + Anthropic API calls, structured JSON response
│   ├── fileWriter.ts         # Write output Markdown to configured folder
│   └── secretsManager.ts     # Wrapper around vscode.SecretStorage
├── package.json
├── tsconfig.json
├── .vscodeignore
└── SPEC.md                   # This file
```

---

## 3. package.json — Key Fields

```jsonc
{
  "name": "crystallize",
  "displayName": "Crystallize",
  "description": "Crystallize your Copilot conversations into lasting knowledge — summarized by AI, saved as Markdown.",
  "version": "0.1.0",
  "publisher": "<your-publisher-id>",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onCommand:crystallize.saveConversation"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "crystallize.saveConversation",
        "title": "Crystallize: Save Conversation"
      },
      {
        "command": "crystallize.setApiKey",
        "title": "Crystallize: Set API Key"
      }
    ],
    "configuration": {
      "title": "Crystallize",
      "properties": {
        "crystallize.outputFolder": {
          "type": "string",
          "default": "",
          "description": "Absolute path to the folder where summaries are saved. Leave empty to use the workspace root.",
          "scope": "resource"
        },
        "crystallize.llmProvider": {
          "type": "string",
          "enum": ["openai", "anthropic"],
          "default": "openai",
          "description": "Which LLM provider to use for summarization."
        },
        "crystallize.model": {
          "type": "string",
          "default": "gpt-4o-mini",
          "description": "Model to use. E.g. gpt-4o-mini, gpt-4o, claude-haiku-4-5, claude-sonnet-4-6."
        },
        "crystallize.maxTokens": {
          "type": "number",
          "default": 1500,
          "minimum": 500,
          "maximum": 4000,
          "description": "Maximum tokens for the LLM summary response."
        },
        "crystallize.summaryPrompt": {
          "type": "string",
          "default": "You are summarizing a {{turnCount}}-turn Copilot session from {{date}} in workspace \"{{workspaceName}}\".\nTopic: {{firstMessage}}\n{{linearIssueId}}Linear issue: {{linearIssueId}}\n{{/linearIssueId}}\nRespond ONLY with a valid JSON object — no markdown fences, no preamble:\n{\n  \"filename\": \"short-descriptive-slug\",\n  \"summary\": \"## Problem\\n...\\n## Decisions\\n...\\n## Next Steps\\n...\"\n}\nThe filename must NOT include the date (it will be prepended automatically). Keep it under 60 chars, lowercase, hyphens only.",
          "description": "Prompt template sent to the LLM. Supports variables: {{date}}, {{time}}, {{sessionId}}, {{turnCount}}, {{firstMessage}}, {{workspaceName}}, {{model}}, {{linearIssueId}}.",
          "editPresentation": "multilineText"
        },
        "crystallize.includeFullTranscript": {
          "type": "boolean",
          "default": true,
          "description": "Append the full conversation transcript below the summary in the output file."
        },
        "crystallize.maxTranscriptChars": {
          "type": "number",
          "default": 60000,
          "description": "Maximum characters of transcript sent to the LLM. Truncates from the middle, preserving first and last turns."
        },
        "crystallize.pickerPageSize": {
          "type": "number",
          "default": 5,
          "description": "Number of sessions shown per page in the session picker.",
          "scope": "resource"
        }
      }
    }
  }
}
```

---

## 4. Module Specs

### 4.1 `sessionReader.ts`

**Responsibility:** Find VS Code's `chatSessions/` directory for the current workspace and return a paginated list of session metadata, plus a function to fully parse a selected session.

```typescript
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface ChatSessionMeta {
  sessionId: string;
  filePath: string;
  modifiedAt: number;         // Unix ms timestamp
  firstUserMessage: string;   // First 80 chars of first user turn — used as picker label
  turnCount: number;          // Total number of turns (user + assistant)
}

export interface ChatSession extends ChatSessionMeta {
  turns: ChatTurn[];
}

// Returns metadata only (cheap — no full parse). Used to populate the picker.
export async function getSessionsMeta(offset: number, limit: number): Promise<ChatSessionMeta[]>

// Fully parses one session by filePath. Called after the user selects one.
export async function parseSession(meta: ChatSessionMeta): Promise<ChatSession>
```

**`getSessionsMeta` implementation notes:**
- Storage base path (macOS): `~/Library/Application Support/Code/User/workspaceStorage/`
- Find the workspace hash by matching `<hash>/meta.json` `"folder"` field to `vscode.workspace.workspaceFolders[0].uri`.
- List all `chatSessions/*.jsonl` and `chatSessions/*.json` files.
- Sort by `fs.statSync(path).mtimeMs` descending (most recent first).
- Apply `offset` and `limit` as a slice: `allFiles.slice(offset, offset + limit)`.
- For each file in the slice: read just enough to extract `firstUserMessage` and `turnCount` — read the first N lines of `.jsonl` (stop at first user turn found), or the first element of a `.json` array. Do not fully parse the file.
- Return `ChatSessionMeta[]`.

**`parseSession` implementation notes:**
- Full parse of the file at `meta.filePath`.
- Parse `.jsonl` line by line; parse `.json` as array.
- Map to `ChatTurn[]`: extract `role`, flatten `content` (string or content-block array — join text blocks).
- Skip empty turns.
- Malformed JSON lines in `.jsonl`: skip + log warning, don't throw.

**Edge cases:**
- `offset` beyond total file count → return empty array (not an error).
- Empty session file → `turnCount: 0`, `firstUserMessage: "(empty session)"`.
- No sessions at all → return empty array.

---

### 4.2 `sessionPicker.ts`

**Responsibility:** Show a VS Code `QuickPick` UI listing recent sessions. Supports pagination: initially shows `pickerPageSize` sessions, with a "Load 5 more…" item at the bottom. Returns the selected `ChatSessionMeta` or `undefined` if the user cancelled.

```typescript
export async function pickSession(): Promise<ChatSessionMeta | undefined>
```

**QuickPick item shape:**

```typescript
interface SessionPickItem extends vscode.QuickPickItem {
  kind: 'session' | 'loadMore' | 'separator';
  meta?: ChatSessionMeta;
}
```

**UI layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ Crystallize: Select a conversation                              │
├─────────────────────────────────────────────────────────────┤
│ $(clock) fix entity editor crash in prod         2 hrs ago  │
│   14 turns · 2026-06-04                                     │
│                                                             │
│ $(clock) refactor settings tab layout            yesterday  │
│   8 turns · 2026-06-03                                      │
│                                                             │
│ $(clock) deploy troubleshooting on staging       Mon        │
│   22 turns · 2026-06-02                                     │
│                                                             │
│ $(clock) add pagination to session reader        Mon        │
│   6 turns · 2026-06-02                                      │
│                                                             │
│ $(clock) initial linear webhook setup            Sun        │
│   31 turns · 2026-06-01                                     │
│ ─────────────────────────────────────────────────────────── │
│ $(chevron-down) Load 5 more…                                │
└─────────────────────────────────────────────────────────────┘
```

**Item fields:**
- `label`: `firstUserMessage` truncated to 60 chars with `…` if longer
- `description`: relative time from `modifiedAt` (see rules below)
- `detail`: `"${turnCount} turns · ${YYYY-MM-DD}"`

**Relative time formatting:**
- < 1 hour ago → `"X mins ago"`
- 1–23 hours ago → `"X hrs ago"`
- Yesterday (calendar day -1) → `"yesterday"`
- 2–6 days ago → weekday name (`"Mon"`, `"Tue"`, …)
- Older → `"YYYY-MM-DD"`

**Pagination logic:**

```
offset = 0
PAGE_SIZE = config: crystallize.pickerPageSize (default 5)

On open:
  items = await getSessionsMeta(0, PAGE_SIZE)
  if items.length === 0: showErrorMessage("No Copilot chat sessions found.") → return undefined
  render as session items
  if items.length === PAGE_SIZE: append separator + "Load N more…" item

On user selects "Load N more…":
  offset += PAGE_SIZE
  newItems = await getSessionsMeta(offset, PAGE_SIZE)
  replace separator + "Load N more…" with newItems
  if newItems.length === PAGE_SIZE: append new separator + "Load N more…"
  keep QuickPick open, do NOT reset scroll position

On user selects a session item:
  QuickPick closes → return item.meta

On Escape / cancel:
  return undefined (silent — no error message)
```

**Implementation notes:**
- Use `vscode.window.createQuickPick<SessionPickItem>()` — not `showQuickPick`. Required for in-place item mutation.
- `quickPick.title = 'Crystallize: Select a conversation'`
- `quickPick.placeholder = 'Choose a session to summarize'`
- `quickPick.busy = true` while loading, then `false`.
- Separator uses `vscode.QuickPickItemKind.Separator` (VS Code 1.74+).
- "Load N more…": `label: '$(chevron-down) Load N more…'`, `alwaysShow: true`.

---

### 4.3 `promptRenderer.ts`

**Responsibility:** Resolve all `{{variable}}` placeholders in the user's prompt template before it is sent to the LLM.

```typescript
export interface PromptContext {
  date: string;           // YYYY-MM-DD
  time: string;           // HH:MM (24h, local)
  sessionId: string;      // Full session ID
  turnCount: string;      // e.g. "14"
  firstMessage: string;   // First 100 chars of first user turn
  workspaceName: string;  // Last segment of workspace folder path
  model: string;          // From settings: crystallize.model
  linearIssueId: string;  // From user input, or "" if not provided
}

export function renderPrompt(template: string, context: PromptContext): string
```

**Variable substitution rules:**
- Simple replace: `{{date}}` → `context.date`, etc. for all variables above.
- If a variable is empty string (e.g. `linearIssueId` not provided), replace `{{linearIssueId}}` with `""` — the surrounding sentence in the default prompt is written to read gracefully when empty.
- Unrecognised `{{foo}}` tokens are left as-is (do not throw).

**Supported variables table:**

| Variable | Resolves to | Example |
|---|---|---|
| `{{date}}` | Current date | `2026-06-04` |
| `{{time}}` | Current time (24h local) | `14:32` |
| `{{sessionId}}` | Full session ID | `a1b2c3d4...` |
| `{{turnCount}}` | Number of turns | `14` |
| `{{firstMessage}}` | First 100 chars of first user turn | `"fix the entity editor crash..."` |
| `{{workspaceName}}` | Workspace folder name | `crystallize` |
| `{{model}}` | Configured LLM model | `gpt-4o-mini` |
| `{{linearIssueId}}` | Linear issue ID (user-entered) | `PROP-1234` or `""` |

---

### 4.4 `markdownRenderer.ts`

**Responsibility:** Convert a `ChatSession` into a clean Markdown string for LLM input, and render the final output file from the LLM's structured response.

```typescript
export function renderTranscript(session: ChatSession): string

export function renderOutputFile(
  filename: string,
  summary: string,
  session: ChatSession,
  linearIssueId: string,
  includeTranscript: boolean
): string
```

**`renderTranscript` output format:**
```markdown
## User
<content>

## Assistant
<content>
```

**`renderOutputFile` output format:**
```markdown
---
sessionId: <id>
date: <YYYY-MM-DD>
model: <model from settings>
linearIssueId: <value or blank>
source: GitHub Copilot Chat
---

# Summary

<llm summary here>

---

# Full Transcript

<renderTranscript output>
```

**Notes:**
- Escape triple backticks inside content blocks to avoid breaking Markdown code fences.
- Strip empty turns (role present, content empty string).
- If `linearIssueId` is empty string, omit the `linearIssueId` frontmatter line entirely.

---

### 4.5 `llmClient.ts`

**Responsibility:** Send transcript + rendered prompt to configured LLM. Parse and return structured JSON response `{ filename, summary }`.

```typescript
export interface LLMResult {
  filename: string;   // Slug only — no date, no extension
  summary: string;    // Markdown string
}

export async function summarize(
  transcript: string,
  renderedPrompt: string,
  provider: 'openai' | 'anthropic',
  model: string,
  apiKey: string,
  maxTokens: number
): Promise<LLMResult>
```

**OpenAI call:**
```
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <apiKey>
Body: {
  model: <model>,
  max_tokens: <maxTokens>,
  messages: [
    { role: "system", content: <renderedPrompt> },
    { role: "user", content: <transcript> }
  ]
}
```
Raw response text: `response.choices[0].message.content`

**Anthropic call:**
```
POST https://api.anthropic.com/v1/messages
x-api-key: <apiKey>
anthropic-version: 2023-06-01
Body: {
  model: <model>,
  max_tokens: <maxTokens>,
  system: <renderedPrompt>,
  messages: [{ role: "user", content: <transcript> }]
}
```
Raw response text: `response.content[0].text`

**JSON parsing (both providers):**
```typescript
// Strip markdown fences if model wraps response despite instructions
const clean = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
const parsed = JSON.parse(clean);

// Validate shape
if (typeof parsed.filename !== 'string' || typeof parsed.summary !== 'string') {
  throw new Error('LLM returned unexpected response shape. Try again.');
}

// Sanitise filename: strip date prefix if model included one, strip extension
parsed.filename = parsed.filename
  .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')  // remove leading date
  .replace(/\.md$/, '')                      // remove extension
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')              // normalise to slug
  .replace(/-+/g, '-')                       // collapse double hyphens
  .slice(0, 80);                             // max 80 chars
```

**Error handling:**
- HTTP 401 → `"Invalid API key. Run 'Crystallize: Set API Key' to update."`
- HTTP 429 → `"Rate limit hit. Try again in a moment."`
- HTTP 5xx → `"LLM provider error (${status}). Try again."`
- `JSON.parse` fails → `"LLM response was not valid JSON. Try again or adjust your prompt."`
- Network error → `"Could not reach LLM provider. Check your connection."`

**Transcript truncation** (before calling):
- If `transcript.length > maxTranscriptChars`: keep first 25% + `\n\n[... truncated ...]\n\n` + last 25%.

---

### 4.6 `fileWriter.ts`

**Responsibility:** Write the output Markdown file to the configured folder using the LLM-provided filename slug.

```typescript
export async function writeOutput(
  content: string,
  filenameSlug: string   // From LLMResult.filename — already sanitised
): Promise<string>       // Returns absolute path of written file
```

**Filename assembly:**
```
YYYY-MM-DD_<filenameSlug>.md
```
Example: `2026-06-04_fix-entity-editor-crash-in-prod.md`

Date is always today's date at time of invocation (not session `modifiedAt`).

**Folder resolution:**
1. Read `crystallize.outputFolder` from config.
2. If set and path exists → use it.
3. If empty or path does not exist → fall back to workspace root.
4. If workspace root also unavailable → `showErrorMessage("Output folder not set or unreachable. Configure crystallize.outputFolder in settings.")` and throw.

**Collision handling:** if a file with the same name already exists, append `_2`, `_3`, etc. before the extension.

**After writing:** `vscode.window.showInformationMessage("Crystallize: Saved → <path>")`.
No "Open File" button. File is silently saved to the configured output folder.

---

### 4.7 `secretsManager.ts`

**Responsibility:** Store and retrieve API keys using `vscode.SecretStorage`. Never read/write API keys from `workspace.getConfiguration()`.

```typescript
export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: 'openai' | 'anthropic'
): Promise<string | undefined>

export async function setApiKey(
  context: vscode.ExtensionContext,
  provider: 'openai' | 'anthropic',
  key: string
): Promise<void>
```

- Storage keys: `crystallize.apiKey.openai` / `crystallize.apiKey.anthropic`
- `setApiKey` is invoked by the `crystallize.setApiKey` command:
  1. Ask which provider: `showQuickPick(['openai', 'anthropic'])`
  2. Ask for key: `showInputBox({ password: true, prompt: 'Enter your API key', placeHolder: 'sk-...' })`
  3. Store via `context.secrets.store()`

---

### 4.8 `extension.ts`

**Responsibility:** Activate extension, register commands, orchestrate the full flow.

```typescript
export function activate(context: vscode.ExtensionContext) {
  // Register: crystallize.saveConversation
  // Register: crystallize.setApiKey
}

export function deactivate() {}
```

**`crystallize.saveConversation` full flow:**

```
1. sessionPicker.pickSession()
   → opens QuickPick with paginated sessions
   → if undefined (Escape): return silently
   → if no sessions: error shown inside pickSession, return

2. sessionReader.parseSession(selectedMeta)
   → full parse of selected session file

3. Detect Linear issue ID
   a. Read current Git branch name via:
      child_process.execSync('git branch --show-current', { cwd: workspaceRoot })
   b. Match regex /([A-Z]+-\d+)/i against branch name
   c. showInputBox({
        prompt: 'Linear issue ID (optional)',
        placeHolder: 'PROP-1234',
        value: detectedId ?? ''   // pre-fill if found
      })
   d. linearIssueId = user input (trimmed) or "" if cancelled/empty

4. Build PromptContext from session + config + linearIssueId
   promptRenderer.renderPrompt(config.summaryPrompt, context)

5. secretsManager.getApiKey(context, provider)
   → if undefined: showErrorMessage("No API key set. Run 'Crystallize: Set API Key'.") and return

6. markdownRenderer.renderTranscript(session)
   → truncate if > maxTranscriptChars

7. Show progress: "Crystallize: Summarizing…"
   llmClient.summarize(transcript, renderedPrompt, provider, model, apiKey, maxTokens)
   → on error: showErrorMessage(error.message) and return

8. markdownRenderer.renderOutputFile(
     result.filename, result.summary, session,
     linearIssueId, config.includeFullTranscript
   )

9. fileWriter.writeOutput(markdownContent, result.filename)

10. showInformationMessage("Crystallize: Saved → <outputFolder>/<filename>")
```

---

## 5. Settings Reference

| Setting | Type | Default | Scope | Description |
|---|---|---|---|---|
| `crystallize.outputFolder` | string | `""` | resource | Absolute path to output folder. Empty = workspace root. |
| `crystallize.llmProvider` | enum | `openai` | user | `openai` or `anthropic` |
| `crystallize.model` | string | `gpt-4o-mini` | user | Model name, free-form |
| `crystallize.maxTokens` | number | `1500` | user | Summary token budget. Min 500, max 4000. |
| `crystallize.summaryPrompt` | string | (see §3) | user | Prompt template. Supports `{{variables}}`. |
| `crystallize.includeFullTranscript` | boolean | `true` | user | Append transcript to output file |
| `crystallize.maxTranscriptChars` | number | `60000` | user | Truncation threshold for transcript sent to LLM |
| `crystallize.pickerPageSize` | number | `5` | resource | Sessions per page in picker |
| API key | — | — | SecretStorage | Set via `Crystallize: Set API Key` command. Never in settings.json. |

---

## 6. Prompt Variables Reference

| Variable | Resolves to | Example |
|---|---|---|
| `{{date}}` | Current date | `2026-06-04` |
| `{{time}}` | Current time (24h local) | `14:32` |
| `{{sessionId}}` | Full session ID | `a1b2c3d4...` |
| `{{turnCount}}` | Number of turns in session | `14` |
| `{{firstMessage}}` | First 100 chars of first user turn | `"fix the entity editor..."` |
| `{{workspaceName}}` | Workspace folder name | `crystallize` |
| `{{model}}` | Configured model name | `gpt-4o-mini` |
| `{{linearIssueId}}` | Linear issue ID (user-entered or detected from branch) | `PROP-1234` or `""` |

**Detection logic for `{{linearIssueId}}`:** reads current Git branch name, matches `/([A-Z]+-\d+)/i`. Pre-fills the input box if found. User can confirm, edit, or clear. If left empty, variable resolves to `""`.

---

## 7. Acceptance Criteria

### Command registration
- [ ] `cmd+shift+p` → "Crystallize: Save Conversation" is listed
- [ ] `cmd+shift+p` → "Crystallize: Set API Key" is listed

### Session picker
- [ ] QuickPick opens immediately on `crystallize.saveConversation`
- [ ] Shows `pickerPageSize` sessions on first open (default 5)
- [ ] Each item shows: truncated first message (label), relative time (description), turn count + date (detail)
- [ ] "Load N more…" appears at bottom when more sessions exist
- [ ] Selecting "Load N more…" appends next page without closing or resetting scroll
- [ ] "Load N more…" disappears when all sessions are exhausted
- [ ] Escape cancels silently — no error message
- [ ] Empty session list shows error message and exits

### Linear issue ID
- [ ] Input box appears after session selection
- [ ] If current branch matches `[A-Z]+-\d+`, it is pre-filled in the input box
- [ ] User can clear the field — leaving it empty is valid
- [ ] `{{linearIssueId}}` in prompt resolves to entered value or `""`
- [ ] Non-empty `linearIssueId` appears in output file YAML frontmatter
- [ ] Empty `linearIssueId` omits the frontmatter line entirely

### Prompt variables
- [ ] All 8 variables resolve correctly in the rendered prompt
- [ ] Unrecognised `{{tokens}}` are left as-is, no error thrown
- [ ] Changing `summaryPrompt` in settings takes effect on next run (no restart)

### LLM call
- [ ] OpenAI: valid key returns `{ filename, summary }` JSON
- [ ] Anthropic: valid key returns `{ filename, summary }` JSON
- [ ] Markdown fences around JSON response are stripped before parsing
- [ ] LLM-provided filename is sanitised: lowercased, hyphens only, no date prefix, max 80 chars
- [ ] Invalid API key → human-readable error message
- [ ] Rate limit → human-readable error message
- [ ] Transcript > `maxTranscriptChars` is truncated (first 25% + last 25%)

### File output
- [ ] Filename format: `YYYY-MM-DD_<llm-slug>.md`
- [ ] File written to `crystallize.outputFolder`; falls back to workspace root if unset
- [ ] File contains: YAML frontmatter, summary section, optional full transcript
- [ ] Collision: existing filename gets `_2` suffix
- [ ] Success notification shows the full output path
- [ ] No "Open File" button — file is saved silently to configured folder

### API key management
- [ ] `Set API Key` prompts for provider, then masked key input
- [ ] Key survives VS Code restarts
- [ ] Key is NOT visible in `settings.json`
- [ ] Missing key at run time shows actionable error

### Settings
- [ ] `includeFullTranscript: false` omits transcript section from output
- [ ] `maxTokens` setting is passed to LLM call
- [ ] `pickerPageSize` changes page size (workspace-overridable)

---

## 8. Non-Functional Requirements

| Concern | Requirement |
|---|---|
| **Security** | API keys exclusively via `vscode.SecretStorage`. Never log keys. |
| **Performance** | All async operations use progress indicator. UI never blocks. |
| **Error surface** | All errors surface as `showErrorMessage` with actionable copy. No silent failures, no raw stack traces. |
| **No telemetry** | Zero network calls except to the configured LLM provider. |
| **No runtime deps** | Node.js stdlib + `vscode` API only. No `node_modules` at runtime (except bundled via esbuild if needed). |
| **VS Code version** | Minimum `1.85.0` (SecretStorage stable, QuickPickItemKind.Separator stable). |

---

## 9. Development Checklist

- [ ] Fork cloned locally, `npm install` runs clean
- [ ] `package.json` updated: name, displayName, publisher, commands, configuration
- [ ] Old `copilot-chat-saver` auto-save logic removed from `extension.ts`
- [ ] `sessionReader.ts` tested against own `chatSessions/` folder before wiring up
- [ ] `sessionPicker.ts` tested with 0, <5, exactly 5, and >5 sessions
- [ ] `promptRenderer.ts` unit-tested: all 8 variables, unknown token passthrough, empty `linearIssueId`
- [ ] `llmClient.ts` tested standalone: valid response, fenced JSON response, malformed JSON
- [ ] Git branch detection tested: matching branch, non-matching branch, no git repo
- [ ] `F5` launch in Extension Development Host works end-to-end
- [ ] `.vscodeignore` excludes `src/`, `*.ts`, test files from packaged `.vsix`
- [ ] `vsce package` produces installable `.vsix`

---

## 10. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| 2 | Should the output file open automatically, or only on "Open File" click? | Resolved — no, just save silently to the path in settings. Notification shows full path. | Closed |
| 5 | Should `pickerPageSize` be workspace-overridable? | Resolved — yes, `"scope": "resource"` in package.json | Closed |

---

## 11. Implementation Prompt

> Paste this into GitHub Copilot Chat (or Claude Code) at the repo root after cloning the fork.

---

You are implementing a VS Code extension called **Crystallize** based on the specification in `SPEC.md`. The repository is a fork of `dwalter/copilot-chat-saver`. Your job is to implement the extension from scratch, replacing the existing auto-save logic entirely.

**Work in this exact order. Complete and verify each step before moving to the next.**

---

### Step 1 — Scaffold

1. Update `package.json`:
   - Set `name`, `displayName`, `description`, `publisher` per §3
   - Replace all commands and configuration contributions per §3
   - Set `activationEvents: ["onCommand:crystallize.saveConversation"]`
   - Set `engines.vscode: "^1.85.0"`

2. Update `tsconfig.json` if needed — ensure `outDir` is `./out`, `strict: true`.

3. Delete or clear the body of `src/extension.ts`. Keep the file.

4. Create empty files: `src/sessionReader.ts`, `src/sessionPicker.ts`, `src/promptRenderer.ts`, `src/markdownRenderer.ts`, `src/llmClient.ts`, `src/fileWriter.ts`, `src/secretsManager.ts`.

5. Run `npm install` and confirm it compiles clean with `npm run compile`.

---

### Step 2 — `sessionReader.ts`

Implement `getSessionsMeta(offset, limit)` and `parseSession(meta)` per §4.1.

- Export `ChatTurn`, `ChatSessionMeta`, `ChatSession` interfaces
- `getSessionsMeta`: resolve workspace storage path, find correct workspace hash via `meta.json`, list + sort session files by mtime descending, slice by offset/limit, return lightweight metadata (do NOT fully parse files here)
- `parseSession`: full parse of `.jsonl` (line by line) or `.json` (array), map to `ChatTurn[]`, skip empty turns, skip malformed lines with `console.warn`

**Test before continuing:** write a temporary `console.log` in `extension.ts` activate() that calls `getSessionsMeta(0, 5)` and logs results. Run with F5 and verify it finds your real local sessions.

---

### Step 3 — `sessionPicker.ts`

Implement `pickSession()` per §4.2.

- Use `vscode.window.createQuickPick<SessionPickItem>()` — not `showQuickPick`
- Show `crystallize.pickerPageSize` sessions (read from config) on first open
- Each item: label = `firstUserMessage` (60 char truncation), description = relative time, detail = `"N turns · YYYY-MM-DD"`
- Implement relative time formatting per the rules in §4.2
- Append a `vscode.QuickPickItemKind.Separator` + "Load N more…" item when more pages exist
- On "Load N more…" selection: append next page in-place, keep picker open
- Return `undefined` on Escape (silent)
- Return `ChatSessionMeta` on selection

---

### Step 4 — `promptRenderer.ts`

Implement `renderPrompt(template, context)` per §4.3.

- Accept a `PromptContext` object with all 8 fields
- Simple string replace for all `{{variable}}` tokens
- Unknown tokens pass through unchanged
- Export the `PromptContext` interface

---

### Step 5 — `markdownRenderer.ts`

Implement `renderTranscript(session)` and `renderOutputFile(...)` per §4.4.

- `renderTranscript`: format turns as `## User` / `## Assistant` blocks, escape triple backticks, strip empty turns
- `renderOutputFile`: produce YAML frontmatter + `# Summary` + optional `# Full Transcript`; omit `linearIssueId` frontmatter line if empty string

---

### Step 6 — `llmClient.ts`

Implement `summarize(...)` per §4.5.

- Export `LLMResult { filename: string, summary: string }`
- OpenAI: POST to `/v1/chat/completions`, system = renderedPrompt, user = transcript
- Anthropic: POST to `/v1/messages`, system = renderedPrompt, user = transcript
- Parse response: strip markdown fences, `JSON.parse`, validate `{ filename, summary }` shape
- Sanitise filename slug: strip leading date, strip `.md`, lowercase, hyphens only, max 80 chars
- Implement all error cases per §4.5 (401, 429, 5xx, JSON parse failure, network error)
- Apply transcript truncation before calling: if `transcript.length > maxTranscriptChars`, keep first 25% + `[... truncated ...]` + last 25%

---

### Step 7 — `fileWriter.ts`

Implement `writeOutput(content, filenameSlug)` per §4.6.

- Assemble final filename: `YYYY-MM-DD_<filenameSlug>.md` using today's date
- Resolve output folder from `crystallize.outputFolder` config; fall back to workspace root
- Handle filename collisions with `_2`, `_3` suffix
- Write file with `fs.promises.writeFile`
- Show `vscode.window.showInformationMessage("Crystallize: Saved → <fullPath>")` — no action button

---

### Step 8 — `secretsManager.ts`

Implement `getApiKey` and `setApiKey` per §4.7.

- Storage keys: `crystallize.apiKey.openai` / `crystallize.apiKey.anthropic`
- Use `context.secrets.store()` and `context.secrets.get()`
- `distill.setApiKey` command: prompt provider via `showQuickPick`, then masked key via `showInputBox({ password: true })`

---

### Step 9 — `extension.ts`

Wire everything together per §4.8.

Implement `activate(context)`:

1. Register `crystallize.saveConversation`:
   - Call `sessionPicker.pickSession()` → return if undefined
   - Call `sessionReader.parseSession(selectedMeta)`
   - Detect Linear issue ID: run `git branch --show-current`, match `/([A-Z]+-\d+)/i`, pre-fill `showInputBox`
   - Build `PromptContext` from session + config + linearIssueId
   - Call `promptRenderer.renderPrompt(config.summaryPrompt, promptContext)`
   - Call `secretsManager.getApiKey(context, provider)` → show error and return if undefined
   - Call `markdownRenderer.renderTranscript(session)` → truncate if needed
   - Show progress: `vscode.window.withProgress(...)` wrapping the LLM call
   - Call `llmClient.summarize(...)`
   - Call `markdownRenderer.renderOutputFile(...)`
   - Call `fileWriter.writeOutput(...)`

2. Register `crystallize.setApiKey`:
   - Call `secretsManager.setApiKey(context, provider, key)`

---

### Step 10 — End-to-end test

Run with F5 in Extension Development Host:
- Trigger `Crystallize: Save Conversation`
- Verify picker opens with your real sessions
- Select a session, enter or skip a Linear issue ID
- Confirm LLM is called and returns JSON
- Confirm file is written to the configured output folder
- Confirm notification shows the full path

Fix any issues, then run `vsce package` to produce a `.vsix`.

---

**Constraints to respect throughout:**
- Never store API keys in `settings.json` — always `vscode.SecretStorage`
- No external npm dependencies at runtime
- All async operations must be non-blocking with appropriate progress indicators
- All error states must surface as `showErrorMessage` with human-readable copy — no raw stack traces to the user
