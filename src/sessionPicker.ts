import * as vscode from 'vscode';
import { ChatSessionMeta, getSessionsMeta } from './sessionReader';

interface SessionPickItem extends vscode.QuickPickItem {
    itemType: 'session' | 'loadMore' | 'separator';
    meta?: ChatSessionMeta;
}

export async function pickSession(): Promise<ChatSessionMeta | undefined> {
    const config = vscode.workspace.getConfiguration('crystallize');
    const pageSize = Math.max(1, config.get<number>('pickerPageSize', 5));

    const quickPick = vscode.window.createQuickPick<SessionPickItem>();
    quickPick.title = 'Crystallize: Select a conversation';
    quickPick.placeholder = 'Choose a session to summarize';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    const sessionItems: SessionPickItem[] = [];
    let offset = 0;
    let loading = false;

    const renderItems = (hasLoadMore: boolean): void => {
        const items: SessionPickItem[] = [...sessionItems];
        if (hasLoadMore) {
            items.push({
                label: 'More Sessions',
                kind: vscode.QuickPickItemKind.Separator,
                itemType: 'separator',
            });
            items.push({
                label: `$(chevron-down) Load ${pageSize} more…`,
                detail: 'Fetch older sessions',
                alwaysShow: true,
                itemType: 'loadMore',
            });
        }
        quickPick.items = items;
    };

    const loadPage = async (): Promise<boolean> => {
        if (loading) {
            return false;
        }

        loading = true;
        quickPick.busy = true;
        try {
            const page = await getSessionsMeta(offset, pageSize);
            if (offset === 0 && page.length === 0) {
                vscode.window.showErrorMessage('No Copilot chat sessions found.');
                return false;
            }

            sessionItems.push(...page.map(toSessionItem));
            offset += page.length;
            renderItems(page.length === pageSize);
            return true;
        } finally {
            quickPick.busy = false;
            loading = false;
        }
    };

    return await new Promise<ChatSessionMeta | undefined>((resolve) => {
        let resolved = false;
        let ignoreNextHide = false;

        const safeResolve = (value: ChatSessionMeta | undefined): void => {
            if (resolved) {
                return;
            }
            resolved = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };

        const handleSelection = async (selected: SessionPickItem | undefined): Promise<void> => {
            if (!selected) {
                return;
            }

            if (selected.itemType === 'session' && selected.meta) {
                safeResolve(selected.meta);
                return;
            }

            if (selected.itemType === 'loadMore') {
                ignoreNextHide = true;
                await loadPage();
                // If onDidHide fired during the load it reset ignoreNextHide to false,
                // meaning the user dismissed the picker — resolve and stop.
                if (!ignoreNextHide) {
                    safeResolve(undefined);
                    return;
                }
                ignoreNextHide = false;
                quickPick.activeItems = [];
                quickPick.show();
            }
        };

        quickPick.onDidAccept(() => {
            void handleSelection(quickPick.selectedItems[0]);
        });

        quickPick.onDidHide(() => {
            if (ignoreNextHide) {
                ignoreNextHide = false;
                return;
            }
            safeResolve(undefined);
        });

        void (async () => {
            const loaded = await loadPage();
            if (!loaded) {
                safeResolve(undefined);
                return;
            }
            quickPick.show();
        })();
    });
}

function toSessionItem(meta: ChatSessionMeta): SessionPickItem {
    const modifiedDate = new Date(meta.modifiedAt);
    const dateString = modifiedDate.toISOString().slice(0, 10);

    return {
        label: `$(clock) ${truncate(meta.firstUserMessage, 60)}`,
        description: formatRelativeTime(meta.modifiedAt),
        detail: `${meta.turnCount} turns · ${dateString}`,
        itemType: 'session',
        meta,
    };
}

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
}

function formatRelativeTime(timestamp: number): string {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();

    if (diffMs < 60 * 60 * 1000) {
        const mins = Math.max(1, Math.floor(diffMs / (60 * 1000)));
        return `${mins} mins ago`;
    }

    if (diffMs < 24 * 60 * 60 * 1000) {
        const hours = Math.floor(diffMs / (60 * 60 * 1000));
        return `${hours} hrs ago`;
    }

    const startNow = startOfDay(now).getTime();
    const startThen = startOfDay(then).getTime();
    const dayDiff = Math.floor((startNow - startThen) / (24 * 60 * 60 * 1000));

    if (dayDiff === 1) {
        return 'yesterday';
    }

    if (dayDiff >= 2 && dayDiff <= 6) {
        return then.toLocaleDateString('en-US', { weekday: 'short' });
    }

    return then.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
