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
}

export interface ChatSession extends ChatSessionMeta {
    turns: ChatTurn[];
}

const EMPTY_SESSION_LABEL = '(empty session)';

export async function getSessionsMeta(offset: number, limit: number): Promise<ChatSessionMeta[]> {
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(0, limit);
    if (safeLimit === 0) {
        return [];
    }

    const storageFolder = await resolveWorkspaceStorageFolder();
    if (!storageFolder) {
        return [];
    }

    const chatSessionsFolder = path.join(storageFolder, 'chatSessions');
    if (!exists(chatSessionsFolder)) {
        return [];
    }

    const files = await listSessionFiles(chatSessionsFolder);
    if (safeOffset >= files.length) {
        return [];
    }

    const page = files.slice(safeOffset, safeOffset + safeLimit);
    const metas: ChatSessionMeta[] = [];

    for (const filePath of page) {
        const stat = await fs.promises.stat(filePath);
        const light = await getLightweightMeta(filePath);
        const firstUserMessage = clampForMeta(light.firstUserMessage);

        metas.push({
            sessionId: path.basename(filePath, path.extname(filePath)),
            filePath,
            modifiedAt: stat.mtimeMs,
            firstUserMessage,
            turnCount: light.turnCount,
        });
    }

    return metas;
}

export async function parseSession(meta: ChatSessionMeta): Promise<ChatSession> {
    const turns = await parseTurnsFromFile(meta.filePath);
    const firstUser = turns.find((turn) => turn.role === 'user')?.content ?? '';

    return {
        sessionId: meta.sessionId,
        filePath: meta.filePath,
        modifiedAt: meta.modifiedAt,
        firstUserMessage: firstUser ? clampForMeta(firstUser) : EMPTY_SESSION_LABEL,
        turnCount: turns.length,
        turns,
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

function getWorkspaceStorageBase(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Code', 'User', 'workspaceStorage');
    }

    return path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage');
}

async function listSessionFiles(chatSessionsFolder: string): Promise<string[]> {
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
    return withStats.map((entry) => entry.filePath);
}

async function getLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number }> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jsonl') {
        return getJsonlLightweightMeta(filePath);
    }

    return getJsonLightweightMeta(filePath);
}

async function getJsonlLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number }> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let firstUserMessage = '';
    let turnCount = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
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
    };
}

async function getJsonLightweightMeta(filePath: string): Promise<{ firstUserMessage: string; turnCount: number }> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    return {
        firstUserMessage: extractFirstUserForMeta(parsed),
        turnCount: countTurnsForMeta(parsed),
    };
}

async function parseTurnsFromFile(filePath: string): Promise<ChatTurn[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jsonl') {
        return parseJsonlTurns(filePath);
    }

    return parseJsonTurns(filePath);
}

async function parseJsonlTurns(filePath: string): Promise<ChatTurn[]> {
    const turns: ChatTurn[] = [];
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            turns.push(...extractTurns(parsed));
        } catch (error) {
            console.warn(`[crystallize] Skipping malformed JSONL line in ${filePath}:`, error);
        }
    }

    return dedupeAndSanitizeTurns(turns);
}

async function parseJsonTurns(filePath: string): Promise<ChatTurn[]> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const turns = extractTurns(parsed);
    return dedupeAndSanitizeTurns(turns);
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