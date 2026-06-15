import * as vscode from 'vscode';
import { ChatSession, FileReference } from './sessionReader';

export function renderTranscript(session: ChatSession): string {
    const parts: string[] = [];

    for (const turn of session.turns) {
        const content = sanitizeContent(turn.content);
        if (!content) {
            continue;
        }

        const heading = turn.role === 'user' ? '## User' : '## Assistant';
        parts.push(`${heading}\n${content}`);
    }

    return parts.join('\n\n');
}

export function renderOutputFile(
    filename: string,
    summary: string,
    session: ChatSession,
    linearIssueId: string,
    includeTranscript: boolean,
    githubRepoUrl = '',
    githubBranch = 'main',
): string {
    const today = new Date().toISOString().slice(0, 10);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const frontmatter: string[] = [
        '---',
        'type: GitHub Copilot Chat',
        `date: ${today}`,
        `filename: ${yamlQuote(filename)}`,
        `sessionId: ${yamlQuote(session.sessionId)}`,
        `workspace: ${yamlQuote(workspace)}`,
    ];

    if (linearIssueId.trim()) {
        frontmatter.push(`ticketId: ${yamlQuote(linearIssueId.trim())}`);
    }

    frontmatter.push('---');

    const output: string[] = [
        frontmatter.join('\n'),
        summary.trim(),
    ];

    const fileRefsSection = renderFileReferences(session.fileReferences, workspace, githubRepoUrl, githubBranch);
    if (fileRefsSection) {
        output.push(fileRefsSection);
    }

    if (includeTranscript) {
        output.push('', '---', '', '## Full Transcript', '', renderTranscript(session));
    }

    return output.join('\n');
}

function renderFileReferences(
    refs: FileReference[],
    workspaceRoot: string,
    githubRepoUrl = '',
    githubBranch = 'main',
): string {
    if (refs.length === 0) {
        return '';
    }

    const byPath = new Map<string, number[]>();
    for (const ref of refs) {
        const relativePath = workspaceRoot && ref.path.startsWith(workspaceRoot)
            ? ref.path.slice(workspaceRoot.length).replace(/^[/\\]/, '')
            : ref.path;
        const lines = byPath.get(relativePath) ?? [];
        if (!lines.includes(ref.line)) {
            lines.push(ref.line);
        }
        byPath.set(relativePath, lines);
    }

    const parts = ['## Files investigated', ''];
    for (const [filePath, lineNumbers] of byPath) {
        lineNumbers.sort((a, b) => a - b);

        const lineRefs = lineNumbers.map((l) => {
            if (githubRepoUrl) {
                const url = `${githubRepoUrl}/blob/${githubBranch}/${filePath}#L${l}`;
                return `[L${l}](${url})`;
            }
            return `L${l}`;
        }).join(', ');

        parts.push(`- \`${filePath}\` — ${lineRefs}`);
    }

    return '\n' + parts.join('\n');
}

function sanitizeContent(content: string): string {
    return content.trim().replace(/```/g, '\\`\\`\\`');
}

function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
