import * as vscode from 'vscode';

export interface LLMResult {
    filename: string;
    summary: string;
}

export async function summarize(
    transcript: string,
    renderedPrompt: string,
    maxTokens: number,
    token: vscode.CancellationToken
): Promise<LLMResult> {
    void maxTokens;

    try {
        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!model) {
            throw new Error('No Copilot model available. Make sure GitHub Copilot Chat is installed and signed in.');
        }

        const messages = [
            vscode.LanguageModelChatMessage.User(`${renderedPrompt}\n\n${transcript}`),
        ];

        const response = await model.sendRequest(
            messages,
            { justification: 'Crystallize: summarizing Copilot session' },
            token
        );

        let rawText = '';
        for await (const chunk of response.text) {
            rawText += chunk;
        }

        return parseStructuredResponse(rawText);
    } catch (error) {
        if (token.isCancellationRequested) {
            throw new Error('Summarization was cancelled.');
        }

        if (error instanceof Error) {
            if (error.message.startsWith('No Copilot model available')
                || error.message.startsWith('LLM response was not valid JSON')
                || error.message.startsWith('LLM returned unexpected response shape')
                || error.message.startsWith('Summarization was cancelled')) {
                throw error;
            }
        }

        throw new Error('Could not get a response from Copilot Chat. Check that Copilot Chat is available and try again.');
    }
}

function parseStructuredResponse(rawText: string): LLMResult {
    const clean = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(clean);
    } catch {
        throw new Error('LLM response was not valid JSON. Try again or adjust your prompt.');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('LLM returned unexpected response shape. Try again.');
    }

    const result = parsed as Record<string, unknown>;
    if (typeof result.filename !== 'string' || typeof result.summary !== 'string') {
        throw new Error('LLM returned unexpected response shape. Try again.');
    }

    const filename = sanitizeFilename(result.filename);
    if (!filename) {
        throw new Error('LLM returned unexpected response shape. Try again.');
    }

    return {
        filename,
        summary: result.summary,
    };
}

function sanitizeFilename(value: string): string {
    return value
        .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')
        .replace(/\.md$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}
