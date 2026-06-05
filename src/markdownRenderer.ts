import * as vscode from 'vscode';
import { ChatSession } from './sessionReader';

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
    ticketId: string,
    includeTranscript: boolean
): string {
    void filename;

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const today = new Date().toISOString().slice(0, 10);
    const frontmatter: string[] = [
        '---',
        'type: GitHub Copilot Chat',
        `date: ${today}`,
        `sessionId: ${session.sessionId}`,
        `workspace: ${workspace}`,
        `ticketId: ${ticketId.trim()}`,
        '---',
    ];

    const output: string[] = [
        frontmatter.join('\n'),
        '',
        summary.trim(),
    ];

    if (includeTranscript) {
        output.push('', '---', '', '## Full Transcript', '', renderTranscript(session));
    }

    return output.join('\n');
}

function sanitizeContent(content: string): string {
    return content.trim().replace(/```/g, '\\`\\`\\`');
}
