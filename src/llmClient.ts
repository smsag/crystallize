import * as vscode from 'vscode';
import JSON5 from 'json5';

export interface LLMResult {
    filename: string;
    summary: string;
}

export async function summarize(
    transcript: string,
    renderedPrompt: string,
    maxTokens: number,
    token: vscode.CancellationToken,
    onRawResponse?: (rawText: string) => void
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

        try {
            return parseStructuredResponse(rawText);
        } catch (error) {
            onRawResponse?.(rawText);
            throw error;
        }
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
    const parsed = parseJsonObject(rawText) ?? parseKeyValueFallback(rawText);
    if (parsed === undefined) {
        throw new Error('LLM response was not valid JSON. Try again or adjust your prompt.');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('LLM returned unexpected response shape. Try again.');
    }

    const result = Array.isArray(parsed)
        ? parsed.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined
        : parsed as Record<string, unknown>;

    if (!result) {
        throw new Error('LLM returned unexpected response shape. Try again.');
    }

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

function parseJsonObject(rawText: string): unknown {
    const candidates = [
        rawText.trim(),
        stripMarkdownFence(rawText),
        ...extractCodeBlocks(rawText),
    ];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        const parsed = parseJsonCandidate(candidate);
        if (parsed !== undefined) {
            return parsed;
        }
    }

    const extracted = extractFirstJsonObject(stripMarkdownFence(rawText) ?? rawText);
    if (!extracted) {
        return undefined;
    }

    return parseJsonCandidate(extracted);
}

function parseJsonCandidate(value: string): unknown {
    const variants = [
        value,
        normalizeJsonLikeText(value),
    ];

    for (const variant of variants) {
        if (!variant) {
            continue;
        }

        try {
            return JSON.parse(variant);
        } catch {
            try {
                return JSON5.parse(variant);
            } catch {
                // Keep trying with additional variants.
            }
        }
    }

    return undefined;
}

function stripMarkdownFence(rawText: string): string | undefined {
    const match = rawText.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match?.[1]?.trim();
}

function extractCodeBlocks(rawText: string): string[] {
    const matches = rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
    return Array.from(matches)
        .map((match) => match[1]?.trim())
        .filter((value): value is string => Boolean(value));
}

function normalizeJsonLikeText(rawText: string): string {
    return rawText
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .trim();
}

function extractFirstJsonObject(rawText: string): string | undefined {
    let start = -1;
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let index = 0; index < rawText.length; index += 1) {
        const char = rawText[index];

        if (inString) {
            if (isEscaped) {
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                start = index;
            }
            depth += 1;
            continue;
        }

        if (char === '}') {
            if (depth === 0) {
                continue;
            }

            depth -= 1;
            if (depth === 0 && start >= 0) {
                return rawText.slice(start, index + 1);
            }
        }
    }

    return undefined;
}

function parseKeyValueFallback(rawText: string): LLMResult | undefined {
    const cleaned = rawText.trim();
    if (!cleaned) {
        return undefined;
    }

    const filenameLine = cleaned.match(/(?:^|\n)\s*filename\s*:\s*(.+)\s*(?:\n|$)/i);
    const summaryBlock = cleaned.match(/(?:^|\n)\s*summary\s*:\s*([\s\S]+)/i);
    if (!filenameLine || !summaryBlock) {
        return undefined;
    }

    const filename = filenameLine[1]
        .trim()
        .replace(/^['"`]|['"`]$/g, '');
    const summary = summaryBlock[1].trim().replace(/^['"]|['"]$/g, '');

    if (!filename || !summary) {
        return undefined;
    }

    return { filename, summary };
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
