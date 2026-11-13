# Privacy Policy

**Nano Metrics does not collect, receive, store or send your data. Nothing leaves your machine.**

Everything the extension shows is read from files and processes on your own computer and displayed in your own VS Code window. There is no server, no account, no telemetry, no analytics and no tracking. The extension makes **no network requests**.

## What it reads (locally, read only)

- System stats (CPU, memory, disks, network, battery, GPU) from your operating system
- Running processes, their working directories and listening ports (`ps`, `lsof` on macOS, `/proc` on Linux)
- Your workspace's `package.json` scripts and current git branch
- Claude Code session transcripts in `~/.claude/projects`, to show tool calls, tokens, cost and context
- The plan limits Claude Code last saved for `/usage` in `~/.claude.json`. Your login token is never read
- Codex CLI chats in `~/.codex/sessions` and Gemini CLI chats in `~/.gemini/tmp`, to show tokens and cost

## What it writes

Nothing in your project or in any AI tool's files. The only thing it saves is its own small UI state (selected tab, a "don't show again" flag) in VS Code's storage. The undo feature restores files only when you click it and confirm.

## What it runs on your machine

Standard system commands to read process information (`ps`, `lsof`) and, for the optional warning sound, your system's own audio player (`afplay`, `paplay` or PowerShell). Nothing is downloaded or installed.

## What it never does

- Send transcripts, prompts, code, file names, costs or any other data anywhere
- Ask Anthropic, OpenAI, Google or anyone else for anything
- Require an account or login

Links open in your browser only when you click them (localhost ports, GitHub, the claude.ai usage page).

## Open source, so you can check

Every line of code is public at **https://github.com/nuhmanpk/nanometrics** under the MIT License. Read it, or build the extension from source.

## Contact

Questions or concerns: open an issue at https://github.com/nuhmanpk/nanometrics/issues
