export interface LLMResult {
    filename: string;
    summary: string;
}

type Provider = 'openai' | 'anthropic';

export async function summarize(
    transcript: string,
    renderedPrompt: string,
    provider: Provider,
    model: string,
    apiKey: string,
    maxTokens: number
): Promise<LLMResult> {
    try {
        const response = provider === 'openai'
            ? await callOpenAI(transcript, renderedPrompt, model, apiKey, maxTokens)
            : await callAnthropic(transcript, renderedPrompt, model, apiKey, maxTokens);

        if (response.status === 401) {
            throw new Error("Invalid API key. Run 'Crystallize: Set API Key' to update.");
        }
        if (response.status === 429) {
            throw new Error('Rate limit hit. Try again in a moment.');
        }
        if (response.status >= 500) {
            throw new Error(`LLM provider error (${response.status}). Try again.`);
        }
        if (!response.ok) {
            throw new Error(`LLM provider error (${response.status}). Try again.`);
        }

        const rawText = await extractResponseText(provider, response);
        return parseLLMResult(rawText);
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.startsWith('Invalid API key')
                || error.message.startsWith('Rate limit hit')
                || error.message.startsWith('LLM provider error')
                || error.message.startsWith('LLM response was not valid JSON')
                || error.message.startsWith('LLM returned unexpected response shape')) {
                throw error;
            }
        }

        throw new Error('Could not reach LLM provider. Check your connection.');
    }
}

async function callOpenAI(
    transcript: string,
    renderedPrompt: string,
    model: string,
    apiKey: string,
    maxTokens: number
): Promise<Response> {
    return fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: renderedPrompt },
                { role: 'user', content: transcript },
            ],
        }),
    });
}

async function callAnthropic(
    transcript: string,
    renderedPrompt: string,
    model: string,
    apiKey: string,
    maxTokens: number
): Promise<Response> {
    return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: renderedPrompt,
            messages: [
                { role: 'user', content: transcript },
            ],
        }),
    });
}

async function extractResponseText(provider: Provider, response: Response): Promise<string> {
    const payload = await response.json() as Record<string, unknown>;

    if (provider === 'openai') {
        const choices = payload.choices as Array<Record<string, unknown>> | undefined;
        const message = choices?.[0]?.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            const text = content
                .map((item) => {
                    if (!item || typeof item !== 'object') {
                        return '';
                    }
                    const textPart = (item as Record<string, unknown>).text;
                    return typeof textPart === 'string' ? textPart : '';
                })
                .join('')
                .trim();
            if (text) {
                return text;
            }
        }
    } else {
        const content = payload.content as Array<Record<string, unknown>> | undefined;
        const first = content?.[0];
        const text = first?.text;
        if (typeof text === 'string') {
            return text;
        }
    }

    throw new Error('LLM returned unexpected response shape. Try again.');
}

function parseLLMResult(rawText: string): LLMResult {
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
