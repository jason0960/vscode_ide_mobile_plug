# Mobile Copilot Remote — Agent Instructions

A VS Code extension + React Native Expo mobile app that bridges phones to GitHub Copilot Chat via WebSockets.

## Architecture

This repo contains the VS Code extension. Relay and mobile app are in separate repos.

```
packages/
  protocol/        — Shared types & JSON-RPC handler (portable, no IDE deps)
  adapter-core/    — Base server with auth, RPC, session management
  adapter-vscode/  — VS Code extension: Copilot bridge, relay client, tunnel

# Separate repos:
# gopilot-relay   — Standalone WebSocket relay hub (room-based, 6-char codes)
# gopilot-mobile  — React Native Expo app (Zustand, WebSocket, RPC client)
```

## Build & Run

```bash
npm install                              # Install all workspaces
npm run build                            # Build extension
# Relay: cd ../gopilot-relay && npm start
# Mobile: cd ../gopilot-mobile && npx expo start --web --clear
```

## Agent Profiles

Specialized agent profiles live in `.agents-profiles/`. Read the relevant profile before performing domain tasks:

- **planner** — Complex feature planning
- **architect** — System design decisions
- **code-reviewer** — Post-change code review (CRITICAL/HIGH/MEDIUM/LOW)
- **security-reviewer** — Vulnerability detection
- **build-error-resolver** — Fix build/type errors with minimal diffs
- **tdd-guide** — Test-driven development workflow
- **refactor-cleaner** — Dead code removal

## Skills & Rules

- `.agents-skills/` — Domain skills with `SKILL.md` files (coding-standards, backend-patterns, security-review, tdd-workflow, etc.)
- `.agents-rules/common/` — Universal coding rules
- `.agents-rules/typescript/` — TypeScript-specific rules

## Key Conventions

- **TypeScript strict mode** everywhere
- **Immutable patterns** — never mutate, always return new objects
- **Error handling** — handle at every level, never swallow silently
- **Small files** — 200-400 lines typical, 800 max
- **Commit format** — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **Security** — no hardcoded secrets, validate all inputs, parameterize queries
