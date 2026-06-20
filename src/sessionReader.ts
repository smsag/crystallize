import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
}

export interface ChatSessionMeta {
    sessionId: string;
    filePath: string;
    modifiedAt: number;
    firstUserMessage: string;
    turnCount: number;
    customTitle: string;
    source: 'copilot' | 'claude-code';
}

export interface FileReference {
    path: string;
    line: number;
}

export interface ChatSession extends ChatSessionMeta {
    turns: ChatTurn[];
    fileReferences: FileReference[];
}

const EMPTY_SESSION_LABEL = '(empty session)';

interface SessionFileEntry {
    filePath: string;
    modifiedAt: number;
    source: 'copilot' | 'claude-code';
}

export async function getSessionsMeta(offset: number, limit: number): Promise<ChatSessionMeta[]> {
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(0, limit);
    if (safeLimit === 0) {
        return [];
    }

    const [copilotEntries, claudeEntries] = await Promise.all([
        listCopilotSessionFiles(),
        listClaudeCodeSessionFiles(),
    ]);

    const allEntries = mergeSortedDesc(copilotEntries, claudeEntries);
    if (safeOffset >= allEntries.length) {
        return [];
    }

    const page = allEntries.slice(safeOffset, safeOffset + safeLimit);
    const metas: ChatSessionMeta[] = [];

    for (const entry of page) {
        try {
            const light = entry.source === 'claude-code'
                ? await getClaudeCodeLightweightMeta(entry.filePath)
                : await getLightweightMeta(entry.filePath);

            metas.push({
                sessionId: path.basename(entry.filePath, path.extname(entry.filePath)),
                filePath: entry.filePath,
                modifiedAt: entry.modifiedAt,
                firstUserMessage: clampForMeta(light.firstUserMessage),
                turnCount: light.turnCount,
                customTitle: light.customTitle,
                source: entry.source,
            });
        } catch {
            // Skip unreadable or malformed session files.
        }
    }

    return metas;
}

async function listCopilotSessionFiles(): Promise<SessionFileEntry[]> {
    const storageFolder = await resolveWorkspaceStorageFolder();
    if (!storageFolder) {
        return [];
    }

    const chatSessionsFolder = path.join(storageFolder, 'chatSessions');
    if (!exists(chatSessionsFolder)) {
        return [];
    }

    const files = await listSessionFiles(chatSessionsFolder);
    return files.map((f) => ({ ...f, source: 'copilot' as const }));
}

async function listClaudeCodeSessionFiles(): Promise<SessionFileEntry[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return [];
    }

    const projectDir = resolveClaudeCodeProjectDir(workspaceFolder.uri.fsPath);
    if (!exists(projectDir)) {
        return [];
    }

    try {
        const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
        const filePaths = entries
            .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
            .map((e) => path.join(projectDir, e.name));

        const withStats = await Promise.all(
            filePaths.map(async (filePath) => {
                const stat = await fs.promises.stat(filePath);
                return { filePath, modifiedAt: stat.mtimeMs, source: 'claude-code' as const };
            })
        );

        withStats.sort((a, b) => b.modifiedAt - a.modifiedAt);
        return withStats;
    } catch {
        return [];
    }
}

function resolveClaudeCodeProjectDir(fsPath: string): string {
    const slug = fsPath.replace(/[/\\]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', slug);
}

function mergeSortedDesc(a: SessionFileEntry[], b: SessionFileEntry[]): SessionFileEntry[] {
    const result: SessionFileEntry[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i].modifiedAt >= b[j].modifiedAt) {
            result.push(a[i++]);
        } else {
            result.push(b[j++]);
        }
    }
    while (i < a.length) { result.push(a[i++]); }
    while (j < b.length) { result.push(b[j++]); }
    return result;
}

export async function parseSession(meta: ChatSessionMeta): Promise<ChatSession> {
    const { turns, fileReferences } = meta.source === 'claude-code'
        ? await parseClaudeCodeTurns(meta.filePath)
        : await parseTurnsFromFile(meta.filePath);
    const firstUser = turns.find((turn) => turn.role === 'user')?.content ?? '';

    return {
        sessionId: meta.sessionId,
        filePath: meta.filePath,
        modifiedAt: meta.modifiedAt,
        firstUserMessage: firstUser ? clampForMeta(firstUser) : EMPTY_SESSION_LABEL,
        turnCount: turns.length,
        customTitle: meta.customTitle,
        source: meta.source,
        turns,
        fileReferences,
    };
}

async function resolveWorkspaceStorageFolder(): Promise<string | undefined> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return undefined;
    }

    const storageBase = getWorkspaceStorageBase();
    if (!exists(storageBase)) {
        return undefined;
    }

    const targetUriString = trimTrailingSlash(workspaceFolder.uri.toString());
    const targetFsPath = trimTrailingSlash(workspaceFolder.uri.fsPath);
    const directories = await fs.promises.readdir(storageBase, { withFileTypes: true });

    for (const entry of directories) {
        if (!entry.isDirectory()) {
            continue;
        }

        const folderPath = path.join(storageBase, entry.name);
        const descriptorPath = await findWorkspaceDescriptor(folderPath);
        if (!descriptorPath) {
            continue;
        }

        try {
            const descriptorRaw = await fs.promises.readFile(descriptorPath, 'utf8');
            const descriptor = JSON.parse(descriptorRaw) as { folder?: unknown };
            if (typeof descriptor.folder !== 'string') {
                continue;
            }

            if (matchesWorkspace(descriptor.folder, targetUriString, targetFsPath)) {
                return folderPath;
            }
        } catch {
            // Ignore malformed workspace descriptor entries.
        }
    }

    return undefined;
}

function matchesWorkspace(candidate: string, targetUri: string, targetFsPath: string): boolean {
    const trimmedCandidate = trimTrailingSlash(candidate);
    if (trimmedCandidate === targetUri || trimmedCandidate === targetFsPath) {
        return true;
    }

    if (trimmedCandidate.startsWith('file://')) {
        try {
            const uri = vscode.Uri.parse(trimmedCandidate);
            const decodedFsPath = trimTrailingSlash(uri.fsPath);
            const encodedUri = trimTrailingSlash(uri.toString());
            if (decodedFsPath === targetFsPath || encodedUri === targetUri) {
                return true;
            }
        } catch {
            return false;
        }
    }

    return false;
}

async function findWorkspaceDescriptor(storageFolder: string): Promise<string | undefined> {
    const workspaceJson = path.join(storageFolder, 'workspace.json');
    if (exists(workspaceJson)) {
        return workspaceJson;
    }

    const metaJson = path.join(storageFolder, 'meta.json');
    if (exists(metaJson)) {
        return metaJson;
    }

    return undefined;
}

const VSCODE_VARIANTS = ['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium'];

function getWorkspaceStorageBase(): string {
    if (process.platform === 'darwin') {
        const base = path.join(os.homedir(), 'Library', 'Application Support');
        return findFirstExisting(VSCODE_VARIANTS.map((v) => path.join(base, v, 'User', 'workspaceStorage')))
            ?? path.join(base, 'Code', 'User', 'workspaceStorage');
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return findFirstExisting(VSCODE_VARIANTS.map((v) => path.join(appData, v, 'User', 'workspaceStorage')))
            ?? path.join(appData, 'Code', 'User', 'workspaceStorage');
    }

    const configBase = path.join(os.homedir(), '.config');
    return findFirstExisting(VSCODE_VARIANTS.map((v) => path.join(configBase, v, 'User', 'workspaceStorage')))
        ?? path.join(configBase, 'Code', 'User', 'workspaceStorage');
}

function findFirstExisting(candidates: string[]): string | undefined {
    return candidates.find((c) => exists(c));
}

async function listSessionFiles(chatSessionsFolder: string): Promise<{ filePath: string; modifiedAt: number }[]> {
    const entries = await fs.promises.readdir(chatSessionsFolder, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')))
        .map((entry) => path.join(chatSessionsFolder, entry.name));

    const withStats = await Promise.all(
        files.map(async (filePath) => {
            const stat = await fs.promises.stat(filePath);
            return { filePath, modifiedAt: stat.mtimeMs };
        })
    );

    withStats.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return withStats;
}

async function getLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number; customTitle: string }> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jsonl') {
        return getJsonlLightweightMeta(filePath);
    }

    return getJsonLightweightMeta(filePath);
}

async function getJsonlLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number; customTitle: string }> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let firstUserMessage = '';
    let turnCount = 0;
    let customTitle = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const record = parsed as Record<string, unknown>;
                if (
                    record.kind === 1 &&
                    Array.isArray(record.k) &&
                    record.k.length === 1 &&
                    record.k[0] === 'customTitle' &&
                    typeof record.v === 'string' &&
                    record.v.trim()
                ) {
                    customTitle = record.v.trim();
                }
            }
            turnCount += countTurnsForMeta(parsed);
            if (!firstUserMessage) {
                firstUserMessage = extractFirstUserForMeta(parsed);
            }
        } catch {
            // Metadata read should tolerate malformed lines and continue.
        }
    }

    return {
        firstUserMessage,
        turnCount,
        customTitle,
    };
}

async function getJsonLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number; customTitle: string }> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
        const parsed = JSON.parse(raw) as unknown;
        return {
            firstUserMessage: extractFirstUserForMeta(parsed),
            turnCount: countTurnsForMeta(parsed),
            customTitle: '',
        };
    } catch {
        return { firstUserMessage: '', turnCount: 0, customTitle: '' };
    }
}

interface ParseResult {
    turns: ChatTurn[];
    fileReferences: FileReference[];
}

async function parseTurnsFromFile(filePath: string): Promise<ParseResult> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jsonl') {
        return parseJsonlTurns(filePath);
    }

    return parseJsonTurns(filePath);
}

async function parseJsonlTurns(filePath: string): Promise<ParseResult> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    // Replay the patch log into a final requests list before extracting turns.
    // The JSONL uses two relevant kind=2 shapes:
    //   k=['requests']            v=[...newRequests]   — appends new requests
    //   k=['requests', N, 'response']  v=[...items]    — patches request N's response
    // Processing each line independently misses the response patches, so we build
    // final state first and extract turns once at the end.
    const requests: Array<Record<string, unknown>> = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                continue;
            }

            const record = parsed as Record<string, unknown>;
            if (record.kind !== 2 || !Array.isArray(record.k) || !Array.isArray(record.v)) {
                continue;
            }

            const k = record.k as unknown[];

            if (k.length === 1 && k[0] === 'requests') {
                for (const req of record.v) {
                    if (req && typeof req === 'object' && !Array.isArray(req)) {
                        requests.push(req as Record<string, unknown>);
                    }
                }
            } else if (
                k.length === 3 &&
                k[0] === 'requests' &&
                typeof k[1] === 'number' &&
                k[2] === 'response'
            ) {
                const idx = k[1] as number;
                if (idx >= 0 && idx < requests.length) {
                    requests[idx] = { ...requests[idx], response: record.v };
                }
            }
        } catch (error) {
            console.warn(`[crystallize] Skipping malformed JSONL line in ${filePath}:`, error);
        }
    }

    const turns: ChatTurn[] = [];
    for (const req of requests) {
        turns.push(...extractTurnsFromRequest(req));
    }

    return {
        turns: dedupeAndSanitizeTurns(turns),
        fileReferences: extractFileRefsFromRequests(requests),
    };
}

async function parseJsonTurns(filePath: string): Promise<ParseResult> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
        const parsed = JSON.parse(raw) as unknown;
        const turns = extractTurns(parsed);
        return { turns: dedupeAndSanitizeTurns(turns), fileReferences: [] };
    } catch (error) {
        console.warn(`[crystallize] Skipping malformed JSON session file ${filePath}:`, error);
        return { turns: [], fileReferences: [] };
    }
}

function extractFileRefsFromRequests(requests: Array<Record<string, unknown>>): FileReference[] {
    const seen = new Set<string>();
    const refs: FileReference[] = [];

    for (const req of requests) {
        const response = req.response;
        if (!Array.isArray(response)) {
            continue;
        }

        for (const item of response) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                continue;
            }

            const r = item as Record<string, unknown>;
            if (r.kind !== 'inlineReference') {
                continue;
            }

            const ref = r.inlineReference;
            if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
                continue;
            }

            const refObj = ref as Record<string, unknown>;
            let filePath = '';
            let line = 0;

            if (refObj.location && typeof refObj.location === 'object' && !Array.isArray(refObj.location)) {
                // Shape A: symbol reference — location.uri + location.range
                const loc = refObj.location as Record<string, unknown>;
                const uri = loc.uri as Record<string, unknown> | undefined;
                const range = loc.range as Record<string, unknown> | undefined;
                filePath = String(uri?.path || uri?.fsPath || '');
                line = typeof range?.startLineNumber === 'number' ? range.startLineNumber : 0;
            } else if (refObj.uri && typeof refObj.uri === 'object' && !Array.isArray(refObj.uri)) {
                // Shape B: direct file reference — uri + range on inlineReference
                const uri = refObj.uri as Record<string, unknown>;
                const range = refObj.range as Record<string, unknown> | undefined;
                filePath = String(uri.path || uri.fsPath || '');
                line = typeof range?.startLineNumber === 'number' ? range.startLineNumber : 0;
            }

            if (!filePath || !line) {
                continue;
            }

            const key = `${filePath}:${line}`;
            if (!seen.has(key)) {
                seen.add(key);
                refs.push({ path: filePath, line });
            }
        }
    }

    return refs;
}

function extractTurns(value: unknown): ChatTurn[] {
    if (!value || typeof value !== 'object') {
        return [];
    }

    const record = value as Record<string, unknown>;

    // New VS Code chatSessions JSONL event shape uses kind=2 with k=['requests'] and v=[request].
    if (record.kind === 2 && isRequestsKey(record.k) && Array.isArray(record.v)) {
        const turns: ChatTurn[] = [];
        for (const requestLike of record.v) {
            turns.push(...extractTurnsFromRequest(requestLike));
        }
        return turns;
    }

    if (Array.isArray(record.requests)) {
        const turns: ChatTurn[] = [];
        for (const requestLike of record.requests) {
            turns.push(...extractTurnsFromRequest(requestLike));
        }
        return turns;
    }

    if (Array.isArray(value)) {
        const turns: ChatTurn[] = [];
        for (const item of value) {
            turns.push(...extractTurns(item));
        }
        return turns;
    }

    return extractTurnsFromRequest(record);
}

function countTurnsForMeta(value: unknown): number {
    if (!value) {
        return 0;
    }

    if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + countTurnsForMeta(item), 0);
    }

    if (typeof value !== 'object') {
        return 0;
    }

    const record = value as Record<string, unknown>;

    if (record.kind === 2 && isRequestsKey(record.k) && Array.isArray(record.v)) {
        return record.v.reduce((sum, requestLike) => sum + countTurnsFromRequestForMeta(requestLike), 0);
    }

    if (Array.isArray(record.requests)) {
        return record.requests.reduce((sum, requestLike) => sum + countTurnsFromRequestForMeta(requestLike), 0);
    }

    return countTurnsFromRequestForMeta(record);
}

function countTurnsFromRequestForMeta(requestLike: unknown): number {
    if (!requestLike || typeof requestLike !== 'object') {
        return 0;
    }

    const request = requestLike as Record<string, unknown>;
    let count = 0;
    if (extractText(request.message)) {
        count += 1;
    }
    if (extractAssistantText(request.response)) {
        count += 1;
    }
    return count;
}

function extractFirstUserForMeta(value: unknown): string {
    if (!value) {
        return '';
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const user = extractFirstUserForMeta(item);
            if (user) {
                return user;
            }
        }
        return '';
    }

    if (typeof value !== 'object') {
        return '';
    }

    const record = value as Record<string, unknown>;

    if (record.kind === 2 && isRequestsKey(record.k) && Array.isArray(record.v)) {
        for (const requestLike of record.v) {
            if (!requestLike || typeof requestLike !== 'object') {
                continue;
            }
            const message = extractText((requestLike as Record<string, unknown>).message);
            if (message) {
                return message;
            }
        }
    }

    if (Array.isArray(record.requests)) {
        for (const requestLike of record.requests) {
            if (!requestLike || typeof requestLike !== 'object') {
                continue;
            }
            const message = extractText((requestLike as Record<string, unknown>).message);
            if (message) {
                return message;
            }
        }
    }

    return extractText(record.message);
}

function extractTurnsFromRequest(requestLike: unknown): ChatTurn[] {
    if (!requestLike || typeof requestLike !== 'object') {
        return [];
    }

    const request = requestLike as Record<string, unknown>;
    const turns: ChatTurn[] = [];

    const userText = extractText(request.message);
    const timestamp = toNumber(request.timestamp);
    if (userText) {
        turns.push({ role: 'user', content: userText, timestamp });
    }

    const assistantText = extractAssistantText(request.response);
    if (assistantText) {
        turns.push({ role: 'assistant', content: assistantText, timestamp });
    }

    return turns;
}

function extractAssistantText(response: unknown): string {
    if (typeof response === 'string') {
        return response.trim();
    }

    if (!Array.isArray(response)) {
        return extractText(response);
    }

    const chunks: string[] = [];

    for (const item of response) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const responseItem = item as Record<string, unknown>;
        const kind = typeof responseItem.kind === 'string' ? responseItem.kind : '';
        if (kind === 'thinking' || kind === 'toolInvocationSerialized' || kind === 'inlineReference') {
            continue;
        }

        const text = extractText(responseItem.content)
            || extractText(responseItem.value)
            || extractText(responseItem.text)
            || extractText(responseItem.markdown)
            || extractText(responseItem.invocationMessage);

        if (text) {
            chunks.push(text);
        }
    }

    return chunks.join('\n').trim();
}

function extractText(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        const pieces = value
            .map((part) => extractText(part))
            .filter((part) => part.length > 0);
        return pieces.join('\n').trim();
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    const obj = value as Record<string, unknown>;

    if (typeof obj.text === 'string' && obj.text.trim()) {
        return obj.text.trim();
    }

    if (typeof obj.value === 'string' && obj.value.trim()) {
        return obj.value.trim();
    }

    if (obj.value) {
        const nestedValue = extractText(obj.value);
        if (nestedValue) {
            return nestedValue;
        }
    }

    if (obj.content) {
        const nestedContent = extractText(obj.content);
        if (nestedContent) {
            return nestedContent;
        }
    }

    if (Array.isArray(obj.parts)) {
        const partsText = obj.parts
            .map((part) => extractText(part))
            .filter((part) => part.length > 0)
            .join('\n')
            .trim();
        if (partsText) {
            return partsText;
        }
    }

    if (typeof obj.markdown === 'string' && obj.markdown.trim()) {
        return obj.markdown.trim();
    }

    return '';
}

function dedupeAndSanitizeTurns(turns: ChatTurn[]): ChatTurn[] {
    const cleaned: ChatTurn[] = [];
    for (const turn of turns) {
        const content = turn.content.trim();
        if (!content) {
            continue;
        }

        const previous = cleaned[cleaned.length - 1];
        if (previous && previous.role === turn.role && previous.content === content) {
            continue;
        }

        cleaned.push({
            role: turn.role,
            content,
            timestamp: turn.timestamp,
        });
    }
    return cleaned;
}

function isRequestsKey(value: unknown): boolean {
    return Array.isArray(value) && value.length === 1 && value[0] === 'requests';
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

function clampForMeta(message: string): string {
    const trimmed = message.trim();
    if (!trimmed) {
        return EMPTY_SESSION_LABEL;
    }

    return trimmed.length > 80 ? `${trimmed.slice(0, 80).trimEnd()}...` : trimmed;
}

async function getClaudeCodeLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number; customTitle: string }> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let firstUserMessage = '';
    let turnCount = 0;
    let customTitle = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const record = JSON.parse(trimmed) as Record<string, unknown>;
            if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
                customTitle = record.aiTitle;
            } else if (record.type === 'user' || record.type === 'assistant') {
                const text = extractClaudeCodeMessageText(record.message);
                if (text) {
                    turnCount++;
                    if (!firstUserMessage && record.type === 'user') {
                        firstUserMessage = text;
                    }
                }
            }
        } catch {
            // Skip malformed lines.
        }
    }

    return { firstUserMessage, turnCount, customTitle };
}

async function parseClaudeCodeTurns(filePath: string): Promise<ParseResult> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const turns: ChatTurn[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const record = JSON.parse(trimmed) as Record<string, unknown>;
            if (record.type !== 'user' && record.type !== 'assistant') {
                continue;
            }

            const text = extractClaudeCodeMessageText(record.message);
            if (!text) {
                continue;
            }

            const role: 'user' | 'assistant' = record.type === 'user' ? 'user' : 'assistant';
            const timestamp = typeof record.timestamp === 'string'
                ? new Date(record.timestamp).getTime()
                : undefined;

            turns.push({ role, content: text, timestamp });
        } catch {
            // Skip malformed lines.
        }
    }

    return { turns: dedupeAndSanitizeTurns(turns), fileReferences: [] };
}

function extractClaudeCodeMessageText(message: unknown): string {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return '';
    }

    const msg = message as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) {
        return '';
    }

    const chunks: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        const block = item as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            chunks.push(block.text.trim());
        }
    }

    return chunks.join('\n').trim();
}

function trimTrailingSlash(value: string): string {
    return value.replace(/[\\/]+$/, '');
}

function exists(filePath: string): boolean {
    try {
        fs.accessSync(filePath);
        return true;
    } catch {
        return false;
    }
}