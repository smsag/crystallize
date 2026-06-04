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
    linearIssueId: string,
    includeTranscript: boolean
): string {
    void filename;

    const model = vscode.workspace.getConfiguration('crystallize').get<string>('model', '');
    const today = new Date().toISOString().slice(0, 10);
    const frontmatter: string[] = [
        '---',
        `sessionId: ${session.sessionId}`,
        `date: ${today}`,
        `model: ${model}`,
    ];

    if (linearIssueId.trim()) {
        frontmatter.push(`linearIssueId: ${linearIssueId.trim()}`);
    }

    frontmatter.push('type: GitHub Copilot Chat', '---');

    const output: string[] = [
        frontmatter.join('\n'),
        '',
        '## What this is about',
        '',
        summary.trim(),
    ];

    if (includeTranscript) {
        output.push('', '---', '', '# Full Transcript', '', renderTranscript(session));
    }

    return output.join('\n');
}

function sanitizeContent(content: string): string {
    return content.trim().replace(/```/g, '\\`\\`\\`');
}
