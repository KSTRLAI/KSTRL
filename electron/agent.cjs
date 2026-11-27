// Kestrel agent: a streaming tool-use loop over either
//  • an Unsloth server (OpenAI-compatible /v1/chat/completions), or
//  • the Anthropic Messages API.
// Every file/command action is confined to the open workspace.
const Anthropic = require('@anthropic-ai/sdk').default;
const os = require('node:os');
const ws = require('./workspace.cjs');
const settings = require('./settings.cjs');
const { EFFORTS, MODES } = require('./models.cjs');
const oai = require('./providers/openai-compat.cjs');
const codeindex = require('./codeindex.cjs');
const web = require('./web.cjs');
const skills = require('./skills.cjs');
const compactor = require('./compactor.cjs');
const fs = require('node:fs');

// Anthropic backends that accept the server-side refusal fallback parameter.
const FALLBACK_OK = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const READ_TOOLS = [
  {
    name: 'list_files',
    description: 'List files in the workspace (recursively, skipping node_modules/.git/build output). Use to orient yourself in the project.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to ".".' } }, required: [] },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace. Returns the file with line numbers. Optionally restrict to a line range for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        start_line: { type: 'integer', description: '1-based first line (optional).' },
        end_line: { type: 'integer', description: '1-based last line, inclusive (optional).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Search file contents across the workspace. Returns matching lines as path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
        glob: { type: 'string', description: 'Optional filename filter such as *.ts' },
      },
      required: ['query'],
    },
  },
];

READ_TOOLS.push({
  name: 'codebase_search',
  description: 'Find the code most relevant to a description, ranked by relevance (e.g. "where is the user logged in", "payment webhook handler"). Returns the best-matching code snippets with line numbers. Use it to orient yourself before reading files; use search for exact text.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What you are looking for, in words or identifiers.' }, limit: { type: 'integer', description: 'How many snippets (default 8, max 15).' } }, required: ['query'] },
});

READ_TOOLS.push({
  name: 'use_skill',
  description: 'Load the full instructions of one of the skills listed in your instructions. Call it before starting a task that matches a skill.',
  input_schema: { type: 'object', properties: { name: { type: 'string', description: 'The skill name or id.' } }, required: ['name'] },
});

const WEB_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, links and snippets. Use for documentation, error messages and library versions.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'fetch_url',
    description: 'Read a public web page (documentation, a GitHub issue, an API reference) as plain text.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'An http(s) URL.' } }, required: ['url'] },
  },
];

const WRITE_TOOLS = [
  {
    name: 'write_file',
    description: 'Create a file or overwrite it entirely with new contents. Prefer edit_file for changes to existing files.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the workspace root.' }, contents: { type: 'string', description: 'The complete new file contents.' } },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact occurrence of old_string with new_string in a file. old_string must match the file exactly (including whitespace) and be unique; include surrounding lines to make it unique.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string', description: 'Exact text to replace.' }, new_string: { type: 'string', description: 'Replacement text.' } },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace root (PowerShell on Windows, bash elsewhere) and return its combined output and exit code. Use for builds, tests, installs, git. Do not start long-running servers or interactive programs; they are stopped after 2 minutes.',
    input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command line to run.' } }, required: ['command'] },
  },
];

const toOpenAITools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

function validate(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input is not an object';
  for (const key of tool.input_schema.required) if (!(key in input)) return `missing required field "${key}"`;
  for (const [key, spec] of Object.entries(tool.input_schema.properties)) {
    if (!(key in input) || input[key] == null) continue;
    const v = input[key];
    if (spec.type === 'string' && typeof v !== 'string') return `"${key}" must be a string`;
    if (spec.type === 'integer' && !Number.isInteger(v)) return `"${key}" must be an integer`;
    if (spec.type === 'boolean' && typeof v !== 'boolean') return `"${key}" must be a boolean`;
  }
  return null;
}

const EFFORT_HINT = {
  low: 'Effort: Flash. Answer quickly and concisely; keep exploration to the minimum needed.',
  medium: 'Effort: Normal. Balance speed and thoroughness.',
  high: 'Effort: High. Take the time to investigate carefully and verify your work.',
  max: 'Effort: Max. Be exhaustive: investigate deeply, consider edge cases and verify thoroughly.',
};

function systemPrompt(model, mode, effort, provider) {
  const s = settings.load();
  const root = ws.getRoot();
  const shell = process.platform === 'win32' ? 'PowerShell' : require('node:path').basename(process.env.SHELL || 'bash');
  return [
    `You are Kestrel, the AI coding agent built into KSTRL, an AI-native code editor. You are running the ${model.name} model. If the user asks which model you are, say you are ${model.name} by KSTRL.`,
    root
      ? `The user's project is open at: ${root}\nAll tool paths are relative to that folder. The OS is ${os.type()} ${os.release()} and commands run in ${shell}.`
      : 'No project folder is open yet. You can still answer questions; ask the user to open or create a project folder before working with files.',
    {
      build: 'You are in Build mode: you can read, create and edit files and run commands to complete the task end to end. Look at the relevant code before changing it, make focused edits with edit_file, and verify your work (build, tests, or re-reading the file) when it is practical. When you finish, give a short summary of what changed and anything the user should do next.',
      plan: 'You are in Plan mode: help the user plan and brainstorm before any code is written. You can read and search the project but not change it. Explore the relevant code, ask clarifying questions when the goal is ambiguous, weigh options briefly with a recommendation, and end with a concrete, numbered implementation plan (files to touch, steps, risks). Do not write the full implementation. When the plan is ready, tell the user they can switch to Build mode to have it built.',
      ask: 'You are in Ask mode: you can read and search the project but not change it. Answer the question, quoting the relevant code and pointing to files with path:line references. If a change is needed, show it as a code block and suggest switching to Build mode to apply it.',
    }[mode],
    'Format replies in Markdown. Use fenced code blocks with a language tag. Keep explanations tight and practical.',
    provider === 'unsloth' ? EFFORT_HINT[effort] : '',
    s.customInstructions ? `User's custom instructions:\n${s.customInstructions}` : '',
    projectRules(),
    skillList(s),
  ].filter(Boolean).join('\n\n');
}

function LIMIT_MSG(short) {
  const u = settings.usageView();
  const t = new Date(u.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (short) return `Usage resets at ${t}.`;
  return u.plan === 'max'
    ? `You've used all of today's KSTRL MAX usage. It resets at ${t}.`
    : `You've used all of today's free usage. It resets at ${t} — or upgrade to KSTRL MAX for 20× more.`;
}

// Rebuild a conversation from saved turns (after a restart the model context is gone).
// Per-project rules: .kstrl/rules.md in the project (like Cursor rules), always followed.
function projectRules() {
  if (!ws.getRoot()) return '';
  for (const p of ['.kstrl/rules.md', 'KSTRL.md']) {
    try {
      const t = fs.readFileSync(ws.resolveInside(p), 'utf8').trim();
      if (t) return `Project rules from ${p} (always follow these):\n${t.slice(0, 20000)}`;
    } catch {}
  }
  return '';
}

function skillList(s) {
  const list = skills.enabled(s);
  if (!list.length) return '';
  return 'Skills you can load with the use_skill tool when a task matches (load the skill before starting that work):\n' + list.map((k) => `- ${k.name}: ${k.description}`).join('\n');
}

function seedMessages(history) {
  const msgs = [];
  for (const h of Array.isArray(history) ? history.slice(-40) : []) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant') || typeof h.text !== 'string') continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === h.role) last.content += '\n\n' + h.text;
    else msgs.push({ role: h.role, content: h.text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.push({ role: 'assistant', content: '(no reply)' });
  return msgs;
}

function cleanMsg(e) { return String(e && e.message ? e.message : e); }

function describeError(err) {
  if (err instanceof oai.ProviderError) {
    if (err.status === 0) return err.message;
    if (err.status === 429 && /usage_limit|usage limit|quota/i.test(err.message)) return LIMIT_MSG();
    if (err.status === 401 || err.status === 403) return 'Your login has expired or the API key was rejected. Click Log in to sign in again.';
    if (err.status === 404) return `The Unsloth server could not find that model or endpoint. Check the model selection in Settings → Model Server. (${err.message})`;
    return `Unsloth server error (${err.status}): ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to the selected model. Try another Colossus model or change its backend in Settings.';
  if (err instanceof Anthropic.NotFoundError) return 'The backend model for this Colossus model was not found. Check Settings → Model Server.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited — wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the model service. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Model service error (${err.status ?? 'unknown'}): ${err.message}`;
  return cleanMsg(err);
}

class AgentManager {
  constructor(send) {
    this.send = send;
    this.chats = new Map(); // chatId -> { provider, messages, controller }
    this.approvals = new Map();
    this.checkpoints = new Map();
    this.defaultModelCache = new Map(); // server url -> first model id
    this.completions = new Map(); // autocomplete id -> AbortController
  }

  recordUsage(ctx, tokens) {
    settings.recordUsage(ctx.model.id, tokens, ctx.mode);
    this.send('settings:changed', settings.publicView());
  }

  emit(chatId, event) { this.send('agent:event', { chatId, ...event }); }

  resolveApproval(id, approved) {
    const r = this.approvals.get(id);
    if (r) { this.approvals.delete(id); r(approved); }
  }

  reset(chatId) { this.stop(chatId); this.chats.delete(chatId); }

  stop(chatId) {
    const c = this.chats.get(chatId);
    if (c && c.controller) c.controller.abort();
    for (const [id, r] of this.approvals) if (id.startsWith(chatId + ':')) { this.approvals.delete(id); r(false); }
  }

  async revert(runId) {
    const cp = this.checkpoints.get(runId);
    if (!cp) return { reverted: 0 };
    let n = 0;
    for (const [p, original] of cp) {
      try {
        if (original === null) await ws.deletePath(p);
        else await ws.writeFile(p, original);
        this.send('fs:changed', { path: p });
        n++;
      } catch {}
    }
    this.checkpoints.delete(runId);
    return { reverted: n, paths: [...cp.keys()] };
  }

  async snapshot(runId, p) {
    if (!this.checkpoints.has(runId)) this.checkpoints.set(runId, new Map());
    const cp = this.checkpoints.get(runId);
    if (cp.has(p)) return;
    cp.set(p, (await ws.fileExists(p)) ? await ws.readFile(p) : null);
  }

  async askApproval(chatId, toolId, command, kind = 'command') {
    const id = `${chatId}:${toolId}`;
    this.emit(chatId, { type: 'approval', id, toolId, command, kind });
    return new Promise((resolve) => this.approvals.set(id, resolve));
  }

  async execTool(chatId, runId, name, input, toolId, signal) {
    switch (name) {
      case 'list_files': {
        const files = await ws.walk(input.path || '.', 1500);
        return { text: files.length ? files.join('\n') : '(empty)', summary: `${files.length} files` };
      }
      case 'read_file': {
        const text = await ws.readFile(input.path);
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, input.start_line || 1);
        const end = Math.min(lines.length, input.end_line || lines.length);
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
        return { text: body || '(empty file)', summary: `${end - start + 1} lines` };
      }
      case 'use_skill': {
        const k = skills.find(settings.load(), input.name);
        if (!k) return { text: `No enabled skill called "${input.name}". Available: ${skills.enabled(settings.load()).map((x) => x.name).join(', ') || 'none'}.`, summary: 'not found' };
        return { text: `# Skill: ${k.name}\n\n${k.instructions}`, summary: k.name };
      }
      case 'codebase_search': {
        const hits = await codeindex.search(input.query, Math.max(1, Math.min(15, input.limit || 8)));
        if (!hits.length) return { text: 'Nothing relevant found. Try other words, or use search for exact text.', summary: '0 results' };
        const text = hits.map((h) => `${h.path}:${h.start}-${h.end}\n` + h.text.split('\n').map((l, i) => `${String(h.start + i).padStart(5)}  ${l}`).join('\n')).join('\n\n');
        return { text: text.slice(0, 40000), summary: `${hits.length} results` };
      }
      case 'web_search':
      case 'fetch_url': {
        const access = settings.load().webAccess || 'ask';
        if (access === 'off') return { text: 'Web access is turned off in Settings.', summary: 'off', declined: true };
        if (access === 'ask') {
          const ok = await this.askApproval(chatId, toolId, name === 'web_search' ? `Search the web for “${input.query}”` : `Open ${input.url}`, 'web');
          if (!ok) return { text: 'The user declined web access for this request.', summary: 'declined', declined: true };
        }
        if (name === 'web_search') {
          const results = await web.search(input.query);
          return { text: results.length ? results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n') : 'No results.', summary: `${results.length} results` };
        }
        const page = await web.fetchUrl(input.url);
        return { text: `${page.title ? page.title + '\n' : ''}${page.url}\n\n${page.text}`, summary: page.title || 'fetched' };
      }
      case 'search': {
        const hits = await ws.search(input.query, { regex: !!input.regex, glob: input.glob || '' }, 200);
        return { text: hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.', summary: `${hits.length} matches` };
      }
      case 'write_file': {
        await this.snapshot(runId, input.path);
        const before = (await ws.fileExists(input.path)) ? await ws.readFile(input.path) : null;
        await ws.writeFile(input.path, input.contents);
        this.send('fs:changed', { path: input.path });
        return { text: `Wrote ${input.path} (${input.contents.split('\n').length} lines).`, summary: before === null ? 'created' : 'rewritten', diff: { path: input.path, before: before ?? '', after: input.contents } };
      }
      case 'edit_file': {
        const before = await ws.readFile(input.path);
        const count = before.split(input.old_string).length - 1;
        if (count === 0) throw new Error('old_string was not found in the file. Re-read the file and copy the text exactly.');
        if (count > 1) throw new Error(`old_string occurs ${count} times; include more surrounding context so it is unique.`);
        await this.snapshot(runId, input.path);
        const after = before.replace(input.old_string, () => input.new_string);
        await ws.writeFile(input.path, after);
        this.send('fs:changed', { path: input.path });
        return { text: `Edited ${input.path}.`, summary: 'edited', diff: { path: input.path, before, after } };
      }
      case 'run_command': {
        if (!ws.getRoot()) throw new Error('No folder is open. Ask the user to open or create a project first.');
        if (!settings.load().autoRunCommands) {
          const ok = await this.askApproval(chatId, toolId, input.command);
          if (!ok) return { text: 'The user declined to run this command.', summary: 'declined', declined: true };
        }
        if (signal.aborted) return { text: 'Cancelled.', summary: 'cancelled' };
        const res = await ws.runCommand(input.command, { onData: (d) => this.emit(chatId, { type: 'tool_output', toolId, data: d }) });
        const out = res.output.length > 30000 ? '…(truncated)…\n' + res.output.slice(-30000) : res.output;
        return { text: `Exit code: ${res.code}\n${out}`, summary: `exit ${res.code}` };
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  async serverModel(model, unsloth, signal) {
    if (model.serverModel) return model.serverModel;
    if (this.defaultModelCache.has(unsloth.url)) return this.defaultModelCache.get(unsloth.url);
    const list = await oai.listModels({ baseURL: unsloth.url, apiKey: unsloth.key, signal });
    if (!list.length) throw new oai.ProviderError(404, 'The Unsloth server did not list any models.');
    this.defaultModelCache.set(unsloth.url, list[0]);
    return list[0];
  }

  // ---- one model turn, per provider. Each appends the assistant turn to its own history. ----

  async turnAnthropic(chat, ctx) {
    const { client, model, effort, system, tools, chatId, runId, signal } = ctx;
    const params = {
      model: model.backend,
      max_tokens: 64000,
      system,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      tools,
      messages: chat.messages,
    };
    if (FALLBACK_OK.has(model.backend)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const stream = client.beta.messages.stream(params, { signal });
    stream.on('text', (delta) => this.emit(chatId, { type: 'text', runId, delta }));
    stream.on('thinking', (delta) => this.emit(chatId, { type: 'thinking', runId, delta }));
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') this.emit(chatId, { type: 'tool_pending', runId, toolId: ev.content_block.id, name: ev.content_block.name });
    });
    const sentEst = compactor.estimate(chat.messages, system, tools);
    const message = await stream.finalMessage();
    if (message.usage?.input_tokens && sentEst > 500) chat.ratio = (message.usage.input_tokens + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0)) / sentEst;
    if (message.usage) { this.emit(chatId, { type: 'usage', runId, usage: message.usage }); this.recordUsage(ctx, { input: (message.usage.input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0), output: message.usage.output_tokens || 0 }); }

    if (message.stop_reason === 'refusal') {
      const kept = message.content.filter((b) => b.type !== 'tool_use');
      chat.messages.push({ role: 'assistant', content: kept.length ? kept : [{ type: 'text', text: '(declined)' }] });
      return { stop: 'refusal', calls: [] };
    }
    if (message.stop_reason === 'pause_turn') { chat.messages.push({ role: 'assistant', content: message.content }); return { stop: 'pause', calls: [] }; }
    const uses = message.content.filter((b) => b.type === 'tool_use');
    if (uses.length && message.stop_reason === 'max_tokens') {
      const kept = message.content.filter((b) => b.type !== 'tool_use');
      if (kept.length) chat.messages.push({ role: 'assistant', content: kept });
      return { stop: 'max_tokens', calls: [] };
    }
    chat.messages.push({ role: 'assistant', content: message.content });
    return { stop: uses.length ? 'tools' : 'end', calls: uses.map((u) => ({ id: u.id, name: u.name, input: u.input })) };
  }

  async turnOpenAI(chat, ctx) {
    const { unsloth, modelId, system, tools, chatId, runId, signal } = ctx;
    const oaiTools = toOpenAITools(tools);
    const sentEst = compactor.estimate(chat.messages, system, oaiTools);
    const body = { model: modelId, messages: [{ role: 'system', content: system }, ...chat.messages], tools: oaiTools, tool_choice: 'auto', stream_options: { include_usage: true } };
    // With a context window set, give the reply whatever room the prompt leaves.
    if (ctx.window) body.max_tokens = Math.max(1024, Math.min(16384, Math.floor(ctx.window - sentEst * (chat.ratio || 1) * 1.05 - 256)));
    const r = await oai.streamChat({
      baseURL: unsloth.url,
      apiKey: unsloth.key,
      signal,
      body,
      extraHeaders: { 'X-KSTRL-Mode': ctx.mode, 'X-KSTRL-Model': ctx.model.id },
      onText: (delta) => this.emit(chatId, { type: 'text', runId, delta }),
      onThinking: (delta) => this.emit(chatId, { type: 'thinking', runId, delta }),
      onToolStart: (id, name) => this.emit(chatId, { type: 'tool_pending', runId, toolId: id, name }),
    });
    if (r.usage) this.emit(chatId, { type: 'usage', runId, usage: { output_tokens: r.usage.completion_tokens || 0 } });
    this.recordUsage(ctx, { input: r.usage?.prompt_tokens || 0, output: r.usage?.completion_tokens || 0 });
    if (r.usage?.prompt_tokens && sentEst > 500) chat.ratio = r.usage.prompt_tokens / sentEst; // calibrate the compactor's estimate to this model's tokenizer
    const calls = r.toolCalls.map((c) => {
      let input;
      let parseError = null;
      try { input = JSON.parse(c.rawArgs || '{}'); } catch (e) { parseError = `arguments were not valid JSON (${e.message})`; input = c.rawArgs; }
      return { id: c.id, name: c.name, input, parseError, rawArgs: c.rawArgs };
    });
    const msg = { role: 'assistant', content: r.text || null };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs || '{}' } }));
    if (!msg.content && !msg.tool_calls) msg.content = '';
    chat.messages.push(msg);
    if (calls.length && r.finish === 'length') return { stop: 'max_tokens', calls };
    return { stop: calls.length ? 'tools' : 'end', calls };
  }

  // Keeps the conversation inside the context window (Settings → Agents → Context Window).
  async compact(chat, ctx) {
    if (!ctx.window) return;
    const r = await compactor.fit(chat.messages, {
      window: ctx.window,
      system: ctx.system,
      tools: ctx.provider === 'unsloth' ? toOpenAITools(ctx.tools) : ctx.tools,
      ratio: chat.ratio,
      quick: ({ system, user, maxTokens }) => this.quick({ system, user, modelId: 'colossus-2.1', mode: 'plan', maxTokens, signal: ctx.signal }),
    });
    if (!r || (!r.summarised && ctx.trimNoticed)) return; // trimming is routine: say it once per run
    if (!r.summarised) ctx.trimNoticed = true;
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
    this.emit(ctx.chatId, { type: 'compact', runId: ctx.runId, summarised: r.summarised, before: r.before, after: r.after,
      message: `Context compacted to fit the ${k(ctx.window)} window: ${r.summarised ? 'summarised earlier work' : 'trimmed old tool output'} (${k(r.before)} → ${k(r.after)} tokens)` });
  }

  pushResults(chat, results) {
    const window = settings.load().contextWindow;
    if (window) results = results.map((r) => ({ ...r, content: compactor.capResult(r.content, window) }));
    if (chat.provider === 'anthropic') {
      chat.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
    } else {
      for (const r of results) chat.messages.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'Error: ' : '') + r.content });
    }
  }

  async run({ chatId, runId, text, model: modelId, effort: effortId, mode: modeId, history = [], images = [] }) {
    const s = settings.load();
    const provider = s.provider === 'anthropic' ? 'anthropic' : 'unsloth';
    const mode = (MODES.find((m) => m.id === modeId) || MODES[0]).id; // older builds sent 'agent' → Build
    const eff = EFFORTS.find((e) => e.id === effortId) || EFFORTS[1];
    // Plan mode always runs Colossus 2.1 to save usage; otherwise UltraCode effort runs Colossus 2.2 UC.
    const model = settings.backendFor(MODES.find((m) => m.id === mode).model || eff.model || modelId);
    const effort = eff.api;

    const done = () => this.emit(chatId, { type: 'done', runId, changed: this.checkpoints.has(runId) ? [...this.checkpoints.get(runId).keys()] : [] });
    if (!settings.hasUsageLeft()) { this.emit(chatId, { type: 'error', runId, limit: true, message: LIMIT_MSG() }); return done(); }
    let unsloth = null;
    let client = null;
    if (provider === 'anthropic') {
      const apiKey = settings.getApiKey();
      if (!apiKey) { this.emit(chatId, { type: 'error', runId, message: 'No API key configured. Open Settings → Model Server to connect a model backend.' }); return done(); }
      client = new Anthropic({ apiKey, baseURL: s.baseURL || process.env.KSTRL_BASE_URL || undefined, maxRetries: 2 });
    } else {
      unsloth = settings.getUnsloth();
      if (!settings.isConfigured()) { this.emit(chatId, { type: 'error', runId, message: 'You\'re not logged in yet. Click Log in to connect KSTRL with your kstrlsi account.', connect: true }); return done(); }
    }

    let chat = this.chats.get(chatId);
    if (!chat || chat.provider !== provider) {
      if (chat && chat.messages.length) this.emit(chatId, { type: 'notice', runId, message: 'Model server changed — starting a fresh context for this chat.' });
      chat = { provider, messages: seedMessages(history), controller: null };
      this.chats.set(chatId, chat);
    }
    const controller = new AbortController();
    chat.controller = controller;
    const pics = (Array.isArray(images) ? images : []).filter((im) => im && /^image\/(png|jpeg|gif|webp)$/.test(im.mediaType) && typeof im.data === 'string' && im.data.length < 7_000_000).slice(0, 6);
    if (!pics.length) chat.messages.push({ role: 'user', content: text });
    else if (provider === 'anthropic') chat.messages.push({ role: 'user', content: [...pics.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text }] });
    else chat.messages.push({ role: 'user', content: [{ type: 'text', text }, ...pics.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))] });

    const tools = [...READ_TOOLS, ...(mode === 'build' ? WRITE_TOOLS : []), ...(s.webAccess === 'off' ? [] : WEB_TOOLS)];
    const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const system = systemPrompt(model, mode, effort, provider);
    let retries = 0;
    let turns = 0;

    try {
      const ctx = { client, unsloth, model, effort, mode, system, tools, chatId, runId, provider, window: s.contextWindow || 0, signal: controller.signal };
      if (provider === 'unsloth') ctx.modelId = await this.serverModel(model, unsloth, controller.signal);
      while (true) {
        const maxSteps = Math.max(5, Math.min(500, s.maxSteps || 60));
        if (turns > 0 && !settings.hasUsageLeft()) { this.emit(chatId, { type: 'error', runId, limit: true, message: 'You ran out of usage for today, so Kestrel stopped here. ' + LIMIT_MSG(true) }); break; }
        if (++turns > maxSteps) { this.emit(chatId, { type: 'error', runId, message: `Stopped after ${maxSteps} steps. Send a follow-up to continue (limit is in Settings → Agents).` }); break; }
        this.emit(chatId, { type: 'turn_start', runId });
        await this.compact(chat, ctx);

        let turn;
        try {
          turn = provider === 'anthropic' ? await this.turnAnthropic(chat, ctx) : await this.turnOpenAI(chat, ctx);
          retries = 0;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          const apiErr = err instanceof Anthropic.APIError || (err instanceof oai.ProviderError && err.status !== 0);
          if (apiErr || retries++ >= 2) throw err;
          this.emit(chatId, { type: 'notice', runId, message: 'Connection hiccup — retrying this step…' });
          continue;
        }

        if (turn.stop === 'refusal') { this.emit(chatId, { type: 'error', runId, message: 'The model declined this request.' }); break; }
        if (turn.stop === 'pause') continue;
        if (turn.stop === 'max_tokens') {
          if (provider === 'unsloth' && turn.calls.length) this.pushResults(chat, turn.calls.map((c) => ({ id: c.id, content: 'Output limit reached before this call was complete; it was not run.', isError: true })));
          this.emit(chatId, { type: 'error', runId, message: 'The response hit the output limit mid tool call. Ask Kestrel to continue in smaller steps.' });
          break;
        }
        if (turn.stop === 'end') break;

        const results = [];
        for (const call of turn.calls) {
          const def = toolByName[call.name];
          this.emit(chatId, { type: 'tool_start', runId, toolId: call.id, name: call.name, input: typeof call.input === 'object' ? call.input : {} });
          if (controller.signal.aborted) {
            results.push({ id: call.id, content: 'Cancelled by the user.', isError: true });
            this.emit(chatId, { type: 'tool_end', runId, toolId: call.id, ok: false, summary: 'cancelled' });
            continue;
          }
          const problem = call.parseError || (def ? validate(def, call.input) : `tool ${call.name} is not available in ${mode} mode`);
          if (problem) {
            results.push({ id: call.id, content: `Invalid input: ${problem}. Input was: ${(typeof call.input === 'string' ? call.input : JSON.stringify(call.input)).slice(0, 2000)}`, isError: true });
            this.emit(chatId, { type: 'tool_end', runId, toolId: call.id, ok: false, summary: problem });
            continue;
          }
          try {
            const r = await this.execTool(chatId, runId, call.name, call.input, call.id, controller.signal);
            results.push({ id: call.id, content: r.text });
            this.emit(chatId, { type: 'tool_end', runId, toolId: call.id, ok: !r.declined, summary: r.summary, diff: r.diff, output: call.name === 'run_command' ? r.text : undefined });
          } catch (e) {
            results.push({ id: call.id, content: cleanMsg(e), isError: true });
            this.emit(chatId, { type: 'tool_end', runId, toolId: call.id, ok: false, summary: cleanMsg(e) });
          }
        }
        this.pushResults(chat, results);
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      const last = chat.messages[chat.messages.length - 1];
      if (controller.signal.aborted) {
        if (last && (last.role === 'user' || last.role === 'tool')) chat.messages.push(provider === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: '(stopped by the user)' }] } : { role: 'assistant', content: '(stopped by the user)' });
        this.emit(chatId, { type: 'notice', runId, message: 'Stopped.' });
      } else {
        if (last && last.role === 'user' && !(Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result'))) chat.messages.pop();
        else if (last && (last.role === 'user' || last.role === 'tool')) chat.messages.push(provider === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: '(error)' }] } : { role: 'assistant', content: '(error)' });
        this.emit(chatId, { type: 'error', runId, message: describeError(err) });
      }
    } finally {
      chat.controller = null;
      require('./auth.cjs').refresh().catch(() => {}); // pick up server-side usage after each run
      done();
    }
  }

  // Single-shot completion used by inline edit (Ctrl+K) — returns replacement code only.
  async inlineEdit({ instruction, code, language, path: filePath, before, after, model: modelId }) {
    const s = settings.load();
    const model = settings.backendFor(modelId);
    if (!settings.hasUsageLeft()) throw new Error(LIMIT_MSG());
    const ctx = { model, mode: 'build' };
    const system = 'You are the inline code editor inside KSTRL. Rewrite the selected code according to the instruction. Reply with ONLY the replacement code for the selection — no explanations and no Markdown fences. Preserve the surrounding indentation style.';
    const user = `File: ${filePath || 'untitled'} (${language})\n\n<before_selection>\n${before}\n</before_selection>\n<selection>\n${code}\n</selection>\n<after_selection>\n${after}\n</after_selection>\n\nInstruction: ${instruction}`;
    let out;
    try {
      if (s.provider === 'anthropic') {
        const apiKey = settings.getApiKey();
        if (!apiKey) throw new Error('No API key configured. Open Settings → Model Server.');
        const client = new Anthropic({ apiKey, baseURL: s.baseURL || process.env.KSTRL_BASE_URL || undefined, maxRetries: 2 });
        const params = { model: model.backend, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: user }] };
        if (FALLBACK_OK.has(model.backend)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
        const msg = await client.beta.messages.stream(params).finalMessage();
        if (msg.usage) this.recordUsage(ctx, { input: msg.usage.input_tokens || 0, output: msg.usage.output_tokens || 0 });
        if (msg.stop_reason === 'refusal') throw new Error('The model declined this edit.');
        out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      } else {
        const unsloth = settings.getUnsloth();
        if (!settings.isConfigured()) throw new Error('You\'re not logged in yet. Click Log in to connect KSTRL.');
        const r = await oai.streamChat({
          baseURL: unsloth.url, apiKey: unsloth.key,
          body: { model: await this.serverModel(model, unsloth), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
          onText: () => {}, onThinking: () => {}, onToolStart: () => {},
        });
        this.recordUsage(ctx, { input: r.usage?.prompt_tokens || 0, output: r.usage?.completion_tokens || 0 });
        out = r.text;
      }
    } catch (e) { throw new Error(describeError(e)); }
    out = out.replace(/^\s+|\s+$/g, (m) => (m.includes('\n') ? '' : m));
    const fence = out.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
    if (fence) out = fence[1];
    return out;
  }

  // One short, non-streaming-to-UI completion (autocomplete, commit messages). Returns text.
  async quick({ system, user, modelId, mode, maxTokens = 256, signal }) {
    const s = settings.load();
    if (!settings.isConfigured() || !settings.hasUsageLeft()) return '';
    const model = settings.backendFor(modelId);
    const ctx = { model, mode };
    if (s.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: settings.getApiKey(), baseURL: s.baseURL || process.env.KSTRL_BASE_URL || undefined, maxRetries: 0 });
      const msg = await client.messages.create({ model: model.backend, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, { signal });
      if (msg.usage) this.recordUsage(ctx, { input: msg.usage.input_tokens || 0, output: msg.usage.output_tokens || 0 });
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    const unsloth = settings.getUnsloth();
    const r = await oai.streamChat({
      baseURL: unsloth.url, apiKey: unsloth.key, signal,
      extraHeaders: { 'X-KSTRL-Mode': mode, 'X-KSTRL-Model': model.id },
      body: { model: await this.serverModel(model, unsloth, signal), max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream_options: { include_usage: true } },
      onText: () => {}, onThinking: () => {}, onToolStart: () => {},
    });
    this.recordUsage(ctx, { input: r.usage?.prompt_tokens || 0, output: r.usage?.completion_tokens || 0 });
    return r.text || '';
  }

  // Tab autocomplete (Colossus 2). Cancelled when the user keeps typing.
  async complete({ id, prefix, suffix, language, path: filePath }) {
    const controller = new AbortController();
    this.completions.set(id, controller);
    try {
      const system = 'You are the inline code completion engine in a code editor. Reply with ONLY the text to insert at <CURSOR> — no explanations, no Markdown fences, no repetition of the code before or after the cursor. Prefer completing the current line or the next few lines (at most about 12 lines). If nothing useful fits, reply with an empty message.';
      const user = `File: ${filePath} (${language})\n<code>${prefix}<CURSOR>${suffix}</code>`;
      let out = await this.quick({ system, user, modelId: 'colossus-2', mode: 'complete', maxTokens: 200, signal: controller.signal });
      out = out.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '').replace(/<\/?(code|CURSOR)>/g, '');
      // Drop any tail that just repeats what's already after the cursor.
      const next = suffix.trimStart().split('\n')[0].trim();
      if (next && out.trimEnd().endsWith(next)) out = out.trimEnd().slice(0, -next.length);
      const lines = out.split('\n');
      if (lines.length > 12) out = lines.slice(0, 12).join('\n');
      return out.trim() ? out.replace(/\s+$/, '') : '';
    } catch { return ''; }
    finally { this.completions.delete(id); }
  }

  cancelComplete(id) { this.completions.get(id)?.abort(); this.completions.delete(id); }

  async testServer({ url, key }) {
    const unsloth = settings.getUnsloth();
    const models = await oai.listModels({ baseURL: url ?? unsloth.url, apiKey: key ?? unsloth.key });
    this.defaultModelCache.clear();
    return { ok: true, url: oai.normalizeBase(url ?? unsloth.url), models };
  }
}

module.exports = { AgentManager };
