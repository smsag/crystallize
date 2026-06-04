import * as vscode from 'vscode';

type Provider = 'openai' | 'anthropic';

export async function getApiKey(
    context: vscode.ExtensionContext,
    provider: Provider
): Promise<string | undefined> {
    return context.secrets.get(storageKey(provider));
}

export async function setApiKey(
    context: vscode.ExtensionContext,
    provider: Provider,
    key: string
): Promise<void> {
    await context.secrets.store(storageKey(provider), key);
}

export async function promptAndStoreApiKey(context: vscode.ExtensionContext): Promise<void> {
    const providerChoice = await vscode.window.showQuickPick(['openai', 'anthropic'], {
        title: 'Crystallize: Set API Key',
        placeHolder: 'Choose LLM provider',
    });

    if (!providerChoice) {
        return;
    }

    const provider = providerChoice as Provider;

    const key = await vscode.window.showInputBox({
        title: 'Crystallize: Set API Key',
        prompt: 'Enter your API key',
        placeHolder: provider === 'openai' ? 'sk-...' : 'sk-ant-...',
        password: true,
        ignoreFocusOut: true,
    });

    if (!key?.trim()) {
        return;
    }

    await setApiKey(context, provider, key.trim());
    vscode.window.showInformationMessage(`Crystallize: ${provider} API key saved.`);
}

function storageKey(provider: Provider): string {
    return `crystallize.apiKey.${provider}`;
}
