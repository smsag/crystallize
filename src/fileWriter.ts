import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export async function writeOutput(content: string, filenameSlug: string): Promise<string> {
    const outputFolder = await resolveOutputFolder();
    const date = new Date().toISOString().slice(0, 10);
    const safeSlug = filenameSlug || 'conversation-summary';

    let candidate = path.join(outputFolder, `${date}_${safeSlug}.md`);
    let suffix = 2;
    while (exists(candidate)) {
        candidate = path.join(outputFolder, `${date}_${safeSlug}_${suffix}.md`);
        suffix += 1;
    }

    await fs.promises.mkdir(outputFolder, { recursive: true });
    await fs.promises.writeFile(candidate, content, 'utf8');
    vscode.window.showInformationMessage(`Crystallize: Saved → ${candidate}`);
    return candidate;
}

async function resolveOutputFolder(): Promise<string> {
    const config = vscode.workspace.getConfiguration('crystallize');
    const configuredPath = (config.get<string>('outputFolder', '') || '').trim();

    if (configuredPath) {
        if (exists(configuredPath)) {
            return configuredPath;
        }
        vscode.window.showWarningMessage(
            `Crystallize: outputFolder "${configuredPath}" does not exist. Saving to workspace root instead.`
        );
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && exists(workspaceRoot)) {
        return workspaceRoot;
    }

    const message = 'Output folder not set or unreachable. Configure crystallize.outputFolder in settings.';
    vscode.window.showErrorMessage(message);
    throw new Error(message);
}

function exists(targetPath: string): boolean {
    try {
        fs.accessSync(targetPath);
        return true;
    } catch {
        return false;
    }
}
