// Kestrel agent: a streaming tool-use loop over the Anthropic Messages API.
// The renderer talks to it over IPC; every file/command action is confined to the open workspace.
const Anthropic = require('@anthropic-ai/sdk').default;
const os = require('node:os');
const ws = require('./workspace.cjs');
const settings = require('./settings.cjs');
const { EFFORTS } = require('./models.cjs');

// Backends that accept the server-side refusal fallback parameter.
const FALLBACK_OK = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const READ_TOOLS = [
  {
    name: 'list_files',
    description: 'List files in the workspace (recursively, skipping node_modules/.git/build output). Use to orient yourself in the project.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to ".".' } },
      required: [],
    },
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

const WRITE_TOOLS = [
  {
    name: 'write_file',
    description: 'Create a file or overwrite it entirely with new contents. Prefer edit_file for changes to existing files.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        contents: { type: 'string', description: 'The complete new file contents.' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact occurrence of old_string with new_string in a file. old_string must match the file exactly (including whitespace) and be unique; include surrounding lines to make it unique.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace root (PowerShell on Windows, bash elsewhere) and return its combined output and exit code. Use for builds, tests, installs, git. Do not start long-running servers or interactive programs; they are stopped after 2 minutes.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run.' } },
      required: ['command'],
    },
  },
];

function validate(tool, input) {
  if (!input || typeof input !== 'object') return 'input is not an object';
  for (const key of tool.input_schema.required) {
    if (!(key in input)) return `missing required field "${key}"`;
  }
  for (const [key, spec] of Object.entries(tool.input_schema.properties)) {
    if (!(key in input) || input[key] == null) continue;
    const v = input[key];
    if (spec.type === 'string' && typeof v !== 'string') return `"${key}" must be a string`;
    if (spec.type === 'integer' && !Number.isInteger(v)) return `"${key}" must be an integer`;
    if (spec.type === 'boolean' && typeof v !== 'boolean') return `"${key}" must be a boolean`;
  }
  return null;
}

function systemPrompt(model, mode) {
  const s = settings.load();
  const root = ws.getRoot();
  const shell = process.platform === 'win32' ? 'PowerShell' : 'bash';
  return [
    `You are Kestrel, the AI coding agent built into KSTRL, an AI-native code editor for Windows. You are running the ${model.name} model. If the user asks which model you are, say you are ${model.name} by KSTRL.`,
    root
      ? `The user's project is open at: ${root}\nAll tool paths are relative to that folder. The OS is ${os.type()} ${os.release()} and commands run in ${shell}.`
      : 'No project folder is open yet. You can still answer questions; ask the user to open a folder (File → Open Folder) before working with files.',
    mode === 'agent'
      ? 'You are in Agent mode: you can read, create and edit files and run commands to complete the task end to end. Look at the relevant code before changing it, make focused edits with edit_file, and verify your work (build, tests, or re-reading the file) when it is practical. When you finish, give a short summary of what changed and anything the user should do next.'
      : 'You are in Ask mode: you can read and search the project but not change it. Answer the question, quoting the relevant code and pointing to files with path:line references. If a change is needed, show it as a code block and suggest switching to Agent mode to apply it.',
    'Format replies in Markdown. Use fenced code blocks with a language tag. Keep explanations tight and practical.',
    s.customInstructions ? `User's custom instructions:\n${s.customInstructions}` : '',
  ].filter(Boolean).join('\n\n');
}

class AgentManager {
  constructor(send) {
    this.send = send; // (channel, payload) => void
    this.chats = new Map(); // chatId -> { messages, controller }
    this.approvals = new Map(); // approvalId -> resolve
    this.checkpoints = new Map(); // runId -> Map(path -> original|null)
  }

  emit(chatId, event) { this.send('agent:event', { chatId, ...event }); }

  resolveApproval(id, approved) {
    const r = this.approvals.get(id);
    if (r) { this.approvals.delete(id); r(approved); }
  }

  reset(chatId) {
    this.stop(chatId);
    this.chats.delete(chatId);
  }

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

  async askApproval(chatId, toolId, command) {
    const id = `${chatId}:${toolId}`;
    this.emit(chatId, { type: 'approval', id, toolId, command });
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

  async run({ chatId, runId, text, model: modelId, effort: effortId, mode }) {
    const apiKey = settings.getApiKey();
    if (!apiKey) {
      this.emit(chatId, { type: 'error', runId, message: 'No API key configured. Open Settings (Ctrl+,) and add your key to start using the Colossus models.' });
      this.emit(chatId, { type: 'done', runId });
      return;
    }
    const s = settings.load();
    const model = settings.backendFor(modelId);
    const effort = (EFFORTS.find((e) => e.id === effortId) || EFFORTS[1]).api;
    const client = new Anthropic({ apiKey, baseURL: s.baseURL || process.env.KSTRL_BASE_URL || undefined, maxRetries: 2 });

    if (!this.chats.has(chatId)) this.chats.set(chatId, { messages: [], controller: null });
    const chat = this.chats.get(chatId);
    const controller = new AbortController();
    chat.controller = controller;
    chat.messages.push({ role: 'user', content: text });

    const tools = mode === 'agent' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const useFallback = FALLBACK_OK.has(model.backend);
    let jsonRetries = 0;
    let turns = 0;

    try {
      while (true) {
        if (++turns > 60) { this.emit(chatId, { type: 'error', runId, message: 'Stopped after 60 steps. Send a follow-up to continue.' }); break; }
        this.emit(chatId, { type: 'turn_start', runId });

        const params = {
          model: model.backend,
          max_tokens: 64000,
          system: systemPrompt(model, mode),
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort },
          tools,
          messages: chat.messages,
        };
        if (useFallback) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }

        const stream = client.beta.messages.stream(params, { signal: controller.signal });
        stream.on('text', (delta) => this.emit(chatId, { type: 'text', runId, delta }));
        stream.on('thinking', (delta) => this.emit(chatId, { type: 'thinking', runId, delta }));
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            this.emit(chatId, { type: 'tool_pending', runId, toolId: ev.content_block.id, name: ev.content_block.name });
          }
        });

        let message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          this.emit(chatId, { type: 'notice', runId, message: 'Connection hiccup — retrying this step…' });
          continue;
        }

        if (message.usage) this.emit(chatId, { type: 'usage', runId, usage: message.usage });

        if (message.stop_reason === 'refusal') {
          chat.messages.push({ role: 'assistant', content: message.content.filter((b) => b.type !== 'tool_use') .length ? message.content.filter((b) => b.type !== 'tool_use') : [{ type: 'text', text: '(declined)' }] });
          this.emit(chatId, { type: 'error', runId, message: 'The model declined this request.' });
          break;
        }
        if (message.stop_reason === 'pause_turn') { chat.messages.push({ role: 'assistant', content: message.content }); continue; }

        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (toolUses.length && message.stop_reason === 'max_tokens') {
          chat.messages.push({ role: 'assistant', content: message.content.filter((b) => b.type !== 'tool_use') });
          if (chat.messages[chat.messages.length - 1].content.length === 0) chat.messages.pop();
          this.emit(chatId, { type: 'error', runId, message: 'The response hit the output limit mid tool call. Ask Kestrel to continue in smaller steps.' });
          break;
        }

        chat.messages.push({ role: 'assistant', content: message.content });
        if (!toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          const def = toolByName[tu.name];
          this.emit(chatId, { type: 'tool_start', runId, toolId: tu.id, name: tu.name, input: tu.input });
          if (controller.signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Cancelled by the user.' });
            this.emit(chatId, { type: 'tool_end', runId, toolId: tu.id, ok: false, summary: 'cancelled' });
            continue;
          }
          const problem = def ? validate(def, tu.input) : `tool ${tu.name} is not available in ${mode} mode`;
          if (problem) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Invalid input: ${problem}. Input was: ${JSON.stringify(tu.input).slice(0, 2000)}` });
            this.emit(chatId, { type: 'tool_end', runId, toolId: tu.id, ok: false, summary: problem });
            continue;
          }
          try {
            const r = await this.execTool(chatId, runId, tu.name, tu.input, tu.id, controller.signal);
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.text });
            this.emit(chatId, { type: 'tool_end', runId, toolId: tu.id, ok: !r.declined, summary: r.summary, diff: r.diff, output: tu.name === 'run_command' ? r.text : undefined });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(e.message || e) });
            this.emit(chatId, { type: 'tool_end', runId, toolId: tu.id, ok: false, summary: String(e.message || e) });
          }
        }
        chat.messages.push({ role: 'user', content: results });
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      if (controller.signal.aborted) {
        const last = chat.messages[chat.messages.length - 1];
        if (last && last.role === 'user') chat.messages.push({ role: 'assistant', content: [{ type: 'text', text: '(stopped by the user)' }] });
        this.emit(chatId, { type: 'notice', runId, message: 'Stopped.' });
      } else {
        // Keep history valid: drop the unanswered user turn so the user can retry.
        const last = chat.messages[chat.messages.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') chat.messages.pop();
        else if (last && last.role === 'user') chat.messages.push({ role: 'assistant', content: [{ type: 'text', text: '(error)' }] });
        this.emit(chatId, { type: 'error', runId, message: describeError(err) });
      }
    } finally {
      chat.controller = null;
      this.emit(chatId, { type: 'done', runId, changed: this.checkpoints.has(runId) ? [...this.checkpoints.get(runId).keys()] : [] });
    }
  }

  // Single-shot completion used by inline edit (Ctrl+K) — returns replacement code only.
  async inlineEdit({ instruction, code, language, path: filePath, before, after, model: modelId }) {
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error('No API key configured. Open Settings to add one.');
    const s = settings.load();
    const model = settings.backendFor(modelId);
    const client = new Anthropic({ apiKey, baseURL: s.baseURL || process.env.KSTRL_BASE_URL || undefined, maxRetries: 2 });
    const params = {
      model: model.backend,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: 'You are the inline code editor inside KSTRL. Rewrite the selected code according to the instruction. Reply with ONLY the replacement code for the selection — no explanations and no Markdown fences. Preserve the surrounding indentation style.',
      messages: [{
        role: 'user',
        content: `File: ${filePath || 'untitled'} (${language})\n\n<before_selection>\n${before}\n</before_selection>\n<selection>\n${code}\n</selection>\n<after_selection>\n${after}\n</after_selection>\n\nInstruction: ${instruction}`,
      }],
    };
    if (FALLBACK_OK.has(model.backend)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const msg = await client.beta.messages.stream(params).finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('The model declined this edit.');
    let out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const fence = out.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
    if (fence) out = fence[1];
    return out;
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to the selected model. Try another Colossus model or change its backend in Settings → Models.';
  if (err instanceof Anthropic.NotFoundError) return 'The backend model for this Colossus model was not found. Check Settings → Models.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited — wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the model service. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Model service error (${err.status ?? 'unknown'}): ${err.message}`;
  return String(err && err.message ? err.message : err);
}

module.exports = { AgentManager };
