import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { ClaudeSnapshot, sessionNames } from './claudeActivity';
import { formatTokens } from './claudeUsage';

/** A short system sound; silently does nothing where no player is found. */
function playSound() {
    const cmd = process.platform === 'darwin' ? ['afplay', ['/System/Library/Sounds/Sosumi.aiff']] :
        process.platform === 'linux' ? ['paplay', ['/usr/share/sounds/freedesktop/stereo/dialog-warning.oga']] :
        process.platform === 'win32' ? ['powershell', ['-NoProfile', '-Command', '[console]::beep(880,300);[console]::beep(660,300)']] : null;
    if (cmd) {
        execFile(cmd[0] as string, cmd[1] as string[], { timeout: 5000, windowsHide: true }, () => { /* no sound is fine */ });
    }
}

/**
 * Context, loop and spend warnings, each shown once: per chat for context and per-chat limits, per day for the
 * daily limits. Limit warnings come with a sound unless nanometrics.claudeAlertSound is off.
 */
export class ClaudeAlerts implements vscode.Disposable {
    private readonly warnedContext = new Set<string>();
    private readonly warnedLoop = new Set<string>();
    private readonly warnedLimit = new Set<string>();
    private readonly sub: vscode.Disposable;

    constructor(onClaude: vscode.Event<ClaudeSnapshot>, private readonly openClaude: () => Thenable<void> | void) {
        this.sub = onClaude(s => this.check(s));
    }

    private async ask(message: string, warn: boolean, sound = false) {
        if (sound && vscode.workspace.getConfiguration('nanometrics').get('claudeAlertSound', true)) {
            playSound();
        }
        const open = 'Open Claude tab';
        const choice = await (warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message, open, 'Settings');
        if (choice === open) {
            await this.openClaude();
        } else if (choice === 'Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'nanometrics.claude');
        }
    }

    /** Warns once per key when value passes a positive limit. */
    private limit(key: string, value: number, limit: number, message: () => string) {
        if (limit > 0 && value > limit && !this.warnedLimit.has(key)) {
            this.warnedLimit.add(key);
            this.ask(message(), true, true);
        }
    }

    check(s: ClaudeSnapshot) {
        const config = vscode.workspace.getConfiguration('nanometrics');
        const ctxLimit = config.get('claudeContextWarning', 80);
        if (ctxLimit > 0) {
            for (const c of s.sessions) {
                if (c.context && c.context.percent >= ctxLimit && !this.warnedContext.has(c.id)) {
                    this.warnedContext.add(c.id);
                    this.ask(`"${c.title}" is at ${Math.round(c.context.percent)}% context (${c.context.text}). ` +
                        'Run /compact or start a fresh chat to keep it fast and cheap.', false);
                }
            }
        }
        if (config.get('claudeLoopWarning', true)) {
            for (const c of s.sessions) {
                const key = c.loop && `${c.id}:${c.loop.key}`;
                if (c.loop && key && !this.warnedLoop.has(key)) {
                    this.warnedLoop.add(key);
                    this.ask(`Claude Code looks stuck in "${c.title}": ${c.loop.text}. ` +
                        'Consider stepping in with a hint, or press Esc in Claude Code to stop it.', true, true);
                }
            }
        }
        const day = new Date().toDateString();
        const costLimit = config.get('claudeDailyBudget', 0);
        const tokenLimit = config.get('claudeDailyTokenLimit', 0);
        this.limit(`cost:${day}`, s.today.costUsd, costLimit, () =>
            `Cost limit reached: Claude Code spend today is ${s.today.cost}, over your $${costLimit.toFixed(2)} limit (estimated at API prices).`);
        this.limit(`tokens:${day}`, s.today.tokenCount, tokenLimit, () =>
            `Token limit reached: Claude Code used ${s.today.tokens} tokens today, over your ${formatTokens(tokenLimit)} limit.`);
        const chatCost = config.get('claudeSessionCostLimit', 0);
        const chatTokens = config.get('claudeSessionTokenLimit', 0);
        for (const c of s.sessions) {
            this.limit(`ccost:${c.id}`, c.costUsd ?? 0, chatCost, () =>
                `Cost limit reached: "${c.title}" has spent ${c.cost}, over your $${chatCost.toFixed(2)} per-chat limit.`);
            this.limit(`ctok:${c.id}`, c.tokenCount, chatTokens, () =>
                `Token limit reached: "${c.title}" used ${c.tokens} tokens, over your ${formatTokens(chatTokens)} per-chat limit.`);
        }
    }

    dispose() {
        this.sub.dispose();
    }
}

const MUTED_KEY = 'nanometrics.claudeNotifyMuted';
const POLL_MS = 5000;

/**
 * Lets the user know Nano Metrics can follow a Claude Code chat the moment one starts in this workspace.
 * Shown at most once per window, never while the Claude tab is open, and never again after "Don't show again".
 */
export class ClaudeSessionNotifier implements vscode.Disposable {
    private known?: Set<string>;
    private shown = false;
    private timer?: NodeJS.Timeout;
    private busy = false;
    private folderSub?: vscode.Disposable;

    constructor(
        private readonly state: vscode.Memento,
        private readonly isWatching: () => boolean,
        private readonly openClaude: () => Thenable<void> | void
    ) {
        if (!state.get(MUTED_KEY, false)) {
            this.timer = setInterval(() => this.check(), POLL_MS);
            this.check();
            // A newly added folder brings its own old chats; take a fresh baseline instead of calling them new.
            this.folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => { this.known = undefined; });
        }
    }

    private folders() {
        return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    }

    private async check() {
        if (this.busy || this.shown) {
            return;
        }
        this.busy = true;
        try {
            const names = new Set((await Promise.all(this.folders().map(sessionNames))).flat());
            // The first scan is the baseline: chats that existed before this window opened aren't new.
            const fresh = this.known ? [...names].some(n => !this.known!.has(n)) : false;
            this.known = names;
            if (!fresh || this.isWatching() || !vscode.workspace.getConfiguration('nanometrics').get('notifyClaudeSession', true)) {
                return;
            }
            this.shown = true;
            this.stop();
            const open = 'Open Claude tab';
            const mute = "Don't show again";
            const choice = await vscode.window.showInformationMessage(
                'New Claude Code chat started. Nano Metrics can track its tool calls, context, tokens and cost live.',
                open,
                mute
            );
            if (choice === open) {
                await this.openClaude();
            } else if (choice === mute) {
                await this.state.update(MUTED_KEY, true);
            }
        } catch {
            // Notifications are a nicety; never let them surface errors.
        } finally {
            this.busy = false;
        }
    }

    private stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    dispose() {
        this.stop();
        this.folderSub?.dispose();
    }
}
