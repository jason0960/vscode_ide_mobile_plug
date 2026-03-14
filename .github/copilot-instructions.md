# Copilot Instructions — Mobile Copilot Remote

This project is a VS Code extension + React Native Expo mobile app that bridges mobile phones to GitHub Copilot Chat via WebSockets. It uses an npm workspaces monorepo with 5 packages.

## Project-Specific Context

- **Monorepo**: npm workspaces — `packages/protocol`, `packages/adapter-core`, `packages/adapter-vscode`, `packages/relay-server`, `packages/mobile-app`
- **Stack**: TypeScript 5.3, VS Code Extension API, React Native (Expo SDK 52), WebSockets (`ws`), Zustand
- **Build**: Extension via esbuild, mobile via Metro/Expo, relay server standalone Node.js
- **Test**: `npm test` at root, individual packages have their own test scripts

## Agent Profiles (ECC)

This workspace includes specialized agent profiles from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code). Use them as domain expertise when the task matches:

### When to Apply Agent Knowledge

| Task | Read Profile | Path |
|------|-------------|------|
| Planning complex features | planner | `.agents-profiles/planner.md` |
| System design / architecture | architect | `.agents-profiles/architect.md` |
| Code review after changes | code-reviewer | `.agents-profiles/code-reviewer.md` |
| Security-sensitive code | security-reviewer | `.agents-profiles/security-reviewer.md` |
| Build/type errors | build-error-resolver | `.agents-profiles/build-error-resolver.md` |
| TDD workflow | tdd-guide | `.agents-profiles/tdd-guide.md` |
| E2E testing | e2e-runner | `.agents-profiles/e2e-runner.md` |
| Dead code cleanup | refactor-cleaner | `.agents-profiles/refactor-cleaner.md` |
| Documentation updates | doc-updater | `.agents-profiles/doc-updater.md` |
| Python code | python-reviewer | `.agents-profiles/python-reviewer.md` |
| Database/SQL work | database-reviewer | `.agents-profiles/database-reviewer.md` |

### Skills Reference

Domain-specific skill instructions are in `.agents-skills/`. Each skill has a `SKILL.md` with detailed patterns:

- **coding-standards** — TypeScript/JS/React conventions
- **backend-patterns** — API design, DB optimization, server-side patterns
- **frontend-patterns** — React, Next.js, state management, UI patterns
- **security-review** — Auth, input validation, secrets, XSS/CSRF/SQLi prevention
- **tdd-workflow** — Test-driven development with 80%+ coverage
- **e2e-testing** — Playwright E2E patterns
- **api-design** — REST API resource naming, status codes, pagination
- **claude-api** — Anthropic Claude API integration patterns

### Rules

Coding rules are in `.agents-rules/`:
- `common/` — Universal rules (coding style, security, testing, git workflow, patterns)
- `typescript/` — TypeScript-specific rules (coding style, patterns, security, testing)

## Core Principles (from ECC)

1. **Test-Driven** — Write tests before implementation, target 80%+ coverage
2. **Security-First** — Never hardcode secrets; validate all inputs; parameterized queries
3. **Immutability** — Create new objects, never mutate existing ones
4. **Plan Before Execute** — Plan complex features before writing code
5. **Small Files** — 200-400 lines typical, 800 max; organize by feature/domain
6. **Error Handling** — Handle errors at every level; never silently swallow

## Git Workflow

- **Commit format**: `<type>: <description>` — Types: feat, fix, refactor, docs, test, chore, perf, ci
- Review code after writing/modifying (apply code-reviewer checklist)
- Run security checks before commits on sensitive code

## Mobile Relay Response (REQUIRED)

As you work, **incrementally write** your response into the workspace file `.copilot-mobile-relay.md`. A file watcher streams updates to a mobile client that cannot see the VS Code chat panel.

**Rules:**
- Write to the relay file **as you go** — do not wait until the end
- After each logical step (explanation, code block, status update), update the file with everything so far
- Always write **complete thoughts and sentences** — never leave a sentence half-finished in the file
- Include all explanations, code blocks, and formatting
- When you are **completely finished** with the entire request, add this marker on its own final line: `<!-- MOBILE_DONE -->`
- Overwrite the file each time (not append) — the watcher tracks what it has already sent
- Do NOT add `<!-- MOBILE_DONE -->` until ALL work is done — the marker signals "request complete"
