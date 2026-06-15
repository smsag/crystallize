import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { summarize } from './llmClient';
import { renderOutputFile, renderTranscript } from './markdownRenderer';
import { PromptContext, renderPrompt } from './promptRenderer';
import { parseSession } from './sessionReader';
import { pickSession } from './sessionPicker';
import { writeOutput } from './fileWriter';

export function activate(context: vscode.ExtensionContext): void {
    const debugOutputChannel = vscode.window.createOutputChannel('Crystallize Debug');

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'crystallize.configureGitHub';
    updateStatusBar(statusBarItem, context);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        debugOutputChannel,
        vscode.commands.registerCommand('crystallize.saveConversation', async () => {
            await saveConversation(context, statusBarItem, debugOutputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('crystallize.configureGitHub', async () => {
            await context.workspaceState.update('githubRepoUrl', undefined);
            await context.workspaceState.update('githubBranch', undefined);
            await resolveGitHubConfig(context, true);
            updateStatusBar(statusBarItem, context);
        })
    );
}

export function deactivate(): void {}

async function saveConversation(context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem, debugOutputChannel: vscode.OutputChannel): Promise<void> {
    const selectedMeta = await pickSession();
    if (!selectedMeta) {
        return;
    }

    let session;
    try {
        session = await parseSession(selectedMeta);
    } catch {
        vscode.window.showErrorMessage('Could not parse the selected session. Try another conversation.');
        return;
    }

    const config = vscode.workspace.getConfiguration('crystallize');
    const model = '';
    const maxTokens = config.get<number>('maxTokens', 1500);
    const maxTranscriptChars = config.get<number>('maxTranscriptChars', 60000);
    const includeFullTranscript = config.get<boolean>('includeFullTranscript', true);
    const logRawLlmResponse = config.get<boolean>('logRawLlmResponse', true);
    const promptTemplate = config.get<string>('summaryPrompt', '');

    const detectedLinearIssueId = detectLinearIssueId();
    const linearIssueInput = await vscode.window.showInputBox({
        prompt: 'Linear issue ID (optional)',
        placeHolder: 'PROP-1234',
        value: detectedLinearIssueId ?? '',
        ignoreFocusOut: true,
    });
    const ticketId = (linearIssueInput ?? '').trim();

    const { githubRepoUrl, githubBranch } = await resolveGitHubConfig(context, session.fileReferences.length > 0);
    updateStatusBar(statusBarItem, context);

    const firstMessage = session.turns.find((turn) => turn.role === 'user')?.content ?? '';
    const promptContext: PromptContext = {
        date: formatDate(new Date()),
        time: formatTime(new Date()),
        sessionId: session.sessionId,
        turnCount: String(session.turnCount),
        firstMessage: firstMessage.slice(0, 100),
        workspaceName: path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''),
        model,
        ticketId,
    };

    const renderedPrompt = renderPrompt(promptTemplate, promptContext);
    const transcript = truncateTranscript(renderTranscript(session), maxTranscriptChars);

    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Crystallize: Summarizing...',
                cancellable: true,
            },
            async (_progress, token) => summarize(
                transcript,
                renderedPrompt,
                maxTokens,
                token,
                logRawLlmResponse
                    ? (rawText) => {
                        debugOutputChannel.clear();
                        debugOutputChannel.appendLine('Crystallize raw Copilot response');
                        debugOutputChannel.appendLine('--- BEGIN RAW RESPONSE ---');
                        debugOutputChannel.appendLine(rawText);
                        debugOutputChannel.appendLine('--- END RAW RESPONSE ---');
                        debugOutputChannel.show(true);
                    }
                    : undefined
            )
        );

        const markdown = renderOutputFile(
            result.filename,
            result.summary,
            session,
            ticketId,
            includeFullTranscript,
            githubRepoUrl,
            githubBranch
        );

        await writeOutput(markdown, result.filename);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error while summarizing.';
        vscode.window.showErrorMessage(message);
    }
}

async function resolveGitHubConfig(
    context: vscode.ExtensionContext,
    hasFileRefs: boolean
): Promise<{ githubRepoUrl: string; githubBranch: string }> {
    const storedUrl = context.workspaceState.get<string>('githubRepoUrl');
    const storedBranch = context.workspaceState.get<string>('githubBranch');

    if (storedUrl !== undefined) {
        return { githubRepoUrl: storedUrl, githubBranch: storedBranch ?? 'main' };
    }

    if (!hasFileRefs) {
        return { githubRepoUrl: '', githubBranch: 'main' };
    }

    const urlInput = await vscode.window.showInputBox({
        prompt: 'GitHub repository URL for this workspace (optional — used to link investigated files)',
        placeHolder: 'https://github.com/org/repo',
        ignoreFocusOut: true,
    });

    if (urlInput === undefined) {
        return { githubRepoUrl: '', githubBranch: 'main' };
    }

    const repoUrl = urlInput.trim().replace(/\/$/, '');
    await context.workspaceState.update('githubRepoUrl', repoUrl);

    if (!repoUrl) {
        return { githubRepoUrl: '', githubBranch: 'main' };
    }

    const branchInput = await vscode.window.showInputBox({
        prompt: 'Branch to link against',
        placeHolder: 'main',
        value: 'main',
        ignoreFocusOut: true,
    });

    const branch = (branchInput ?? 'main').trim() || 'main';
    await context.workspaceState.update('githubBranch', branch);

    return { githubRepoUrl: repoUrl, githubBranch: branch };
}

function updateStatusBar(item: vscode.StatusBarItem, context: vscode.ExtensionContext): void {
    const repoUrl = context.workspaceState.get<string>('githubRepoUrl');
    const branch = context.workspaceState.get<string>('githubBranch') ?? 'main';

    if (repoUrl) {
        const shortName = githubShortName(repoUrl);
        item.text = `$(github) ${shortName}`;
        item.tooltip = `Crystallize · ${repoUrl} (${branch}) — click to reconfigure`;
    } else {
        item.text = '$(github) Crystallize';
        item.tooltip = 'Crystallize · no GitHub repo configured — click to set one';
    }
}

function githubShortName(url: string): string {
    const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
    return match ? match[1] : url;
}

function detectLinearIssueId(): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return undefined;
    }

    try {
        const branchName = cp.execSync('git branch --show-current', {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        const match = branchName.match(/([A-Z]+-\d+)/i);
        return match ? match[1].toUpperCase() : undefined;
    } catch {
        return undefined;
    }
}

function truncateTranscript(transcript: string, maxTranscriptChars: number): string {
    if (transcript.length <= maxTranscriptChars) {
        return transcript;
    }

    const quarter = Math.floor(maxTranscriptChars * 0.25);
    const start = transcript.slice(0, quarter);
    const end = transcript.slice(-quarter);
    return `${start}\n\n[... truncated ...]\n\n${end}`;
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function formatTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}
