import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { ClaudeSnapshot, sessionNames } from './claudeActivity';

/** A short system sound; silently does nothing where no player is found. */
function playSound() {
    const cmd = process.platform === 'darwin' ? ['afplay', ['/System/Library/Sounds/Glass.aiff']] :
        process.platform === 'linux' ? ['paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga']] : null;
    if (cmd) {
        execFile(cmd[0] as string, cmd[1] as string[], { timeout: 5000 }, () => { /* no sound is fine */ });
    }
}

/** Context and spend warnings, each shown once: per chat for context, per day for the budget. */
export class ClaudeAlerts implements vscode.Disposable {
    private readonly warnedContext = new Set<string>();
    private readonly warnedLoop = new Set<string>();
    // Last state seen per session, to catch the moment a working session stops.
    private readonly lastState = new Map<string, string>();

    /** "Your turn" ping when a session goes from working to waiting on you, or on an approval. */
    private turnPings(s: ClaudeSnapshot, config: vscode.WorkspaceConfiguration) {
        const mode = config.get<string>('claudeTurnNotify', 'unfocused');
        for (const c of s.sessions) {
            const was = this.lastState.get(c.id);
            this.lastState.set(c.id, c.state);
            if (was !== 'working' || c.state !== 'waiting' || mode === 'off' || (mode === 'unfocused' && vscode.window.state.focused)) {
                continue;
            }
            const message = c.waitingOn === 'you'
                ? `Claude finished "${c.title}" and is waiting for your next prompt.`
                : `Claude needs you in "${c.title}": waiting on ${c.waitingOn} (approval or a long run).`;
            if (config.get('claudeTurnSound', false)) {
                playSound();
            }
            this.ask(message, false);
        }
    }
    private budgetDay = '';
    private readonly sub: vscode.Disposable;

    constructor(onClaude: vscode.Event<ClaudeSnapshot>, private readonly openClaude: () => Thenable<void> | void) {
        this.sub = onClaude(s => this.check(s));
    }

    private async ask(message: string, warn: boolean) {
        const open = 'Open Claude tab';
        const choice = await (warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message, open, 'Settings');
        if (choice === open) {
            await this.openClaude();
        } else if (choice === 'Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'nanometrics.claude');
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
                        'Consider stepping in with a hint, or press Esc in Claude Code to stop it.', true);
                }
            }
        }
        this.turnPings(s, config);
        const budget = config.get('claudeDailyBudget', 0);
        const today = new Date().toDateString();
        if (budget > 0 && s.today.costUsd > budget && this.budgetDay !== today) {
            this.budgetDay = today;
            this.ask(`Claude Code spend today is ${s.today.cost}, over your $${budget.toFixed(2)} budget (estimated at API prices).`, true);
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
