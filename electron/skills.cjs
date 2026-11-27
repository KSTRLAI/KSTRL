// Skills: reusable instructions Kestrel loads when a task calls for them (built-in + the user's own).
const BUILTIN = [
  {
    id: 'frontend-design', name: 'Frontend Design', description: 'Polished, modern UI: layout, spacing, typography, color and responsive design.',
    instructions: `When building or restyling UI:
- Start from a clear layout grid and a spacing scale (4/8px steps). Align everything to it.
- Use at most 2 font sizes per component and a clear type hierarchy (title, body, muted).
- Define colors as CSS variables; keep contrast at WCAG AA or better; support dark mode if the app has it.
- Make it responsive: test mentally at 375px, 768px and 1280px. No horizontal scroll on phones.
- Add hover, focus-visible and disabled states to every interactive element.
- Prefer subtle borders and shadows over heavy ones; round corners consistently.
- Reuse existing components and styles in the project before adding new ones.`,
  },
  {
    id: 'write-tests', name: 'Write Tests', description: 'Add or improve automated tests using the project\'s existing test framework.',
    instructions: `When asked to write tests:
1. Find the test setup first (package.json scripts, pytest.ini, existing *_test / *.spec files) and follow its style.
2. Cover the happy path, edge cases (empty, null, large, unicode) and error paths.
3. One behavior per test, with a descriptive name. Avoid testing implementation details.
4. Mock only external boundaries (network, time, filesystem) — not the code under test.
5. Run the tests and make sure they pass; if a test reveals a real bug, report it rather than weakening the test.`,
  },
  {
    id: 'debugging', name: 'Debugging', description: 'Find the root cause of a bug methodically before changing code.',
    instructions: `When fixing a bug:
1. Reproduce it: find the exact input, command or steps. Read the full error and stack trace.
2. Form a hypothesis, then confirm it by reading the code path (and adding a temporary log or test if needed).
3. Fix the root cause, not the symptom. Keep the fix minimal.
4. Add a regression test when the project has tests.
5. Explain the cause and the fix in one or two sentences.`,
  },
  {
    id: 'code-review', name: 'Code Review', description: 'Review changes for bugs, security issues and maintainability.',
    instructions: `When reviewing code:
- Look first for correctness bugs: wrong conditions, off-by-one, null handling, race conditions, error handling.
- Then security: injection, unsafe input handling, secrets in code, missing auth checks.
- Then maintainability: naming, duplication, overly complex functions.
- Report findings ordered by severity, each with file:line, the problem, and a concrete fix.
- Don't nitpick formatting that a formatter would handle.`,
  },
  {
    id: 'refactor', name: 'Refactor', description: 'Restructure code without changing its behavior.',
    instructions: `When refactoring:
- Keep behavior identical. Run the tests before and after.
- Work in small steps: extract functions, rename for clarity, remove duplication, simplify conditionals.
- Don't mix refactoring with new features or bug fixes.
- Update imports and call sites everywhere; search the project for every usage.`,
  },
  {
    id: 'docs', name: 'Documentation', description: 'Write clear READMEs, docstrings and usage guides.',
    instructions: `When writing documentation:
- Lead with what the thing does and how to run it (install, configure, run) in copy-pasteable commands.
- Use short sections with headings; examples beat descriptions.
- Document every config option and environment variable with its default.
- Keep docstrings to what a caller needs: purpose, parameters, return value, errors.`,
  },
  {
    id: 'security', name: 'Security Review', description: 'Check code for common vulnerabilities and unsafe patterns.',
    instructions: `When checking security:
- Inputs: validate and sanitize everything from users, files and the network. Look for SQL/command/path injection and XSS.
- Auth: every sensitive route checks the user; no trust in client-side checks.
- Secrets: none in source, logs or client bundles; use environment variables.
- Dependencies: flag outdated packages with known issues.
- Report each issue with severity, location and a fix.`,
  },
  {
    id: 'game-dev', name: 'Game Development', description: 'Build browser games: game loop, input, collisions, assets and polish.',
    instructions: `When building a game:
- Use a fixed-timestep game loop (requestAnimationFrame + delta time) and keep update and render separate.
- Handle keyboard, mouse and touch input; make controls configurable.
- Start with a playable core loop, then add score, levels, sound and juice (screen shake, particles, easing).
- Keep assets in an assets/ folder and preload them before the game starts.
- For 3D, use three.js with a single renderer, proper lighting and resize handling.`,
  },
];

const clean = (s) => ({ id: String(s.id), name: String(s.name || 'Untitled skill').slice(0, 80), description: String(s.description || '').slice(0, 300), instructions: String(s.instructions || '').slice(0, 20000) });

// All skills with their on/off state. Custom skills live in settings.skills; built-in ones can be switched off.
function all(settings) {
  const off = new Set(settings.skillsOff || []);
  const custom = (settings.skills || []).map((s) => ({ ...clean(s), custom: true, enabled: !off.has(s.id) }));
  return [...BUILTIN.map((s) => ({ ...s, builtin: true, enabled: !off.has(s.id) })), ...custom];
}

const enabled = (settings) => all(settings).filter((s) => s.enabled);

function find(settings, name) {
  const q = String(name || '').trim().toLowerCase();
  return enabled(settings).find((s) => s.id === q || s.name.toLowerCase() === q);
}

module.exports = { BUILTIN, all, enabled, find };
