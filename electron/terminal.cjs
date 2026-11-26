// Integrated terminal: a real PTY (ConPTY on Windows) via node-pty, with a pipe-based fallback.
const os = require('node:os');
const { spawn } = require('node:child_process');

let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

function defaultShell() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || 'bash', args: ['-l'] };
}

class TerminalManager {
  constructor(send) {
    this.send = send;
    this.terms = new Map();
    this.nextId = 1;
  }

  // ssh: { target: 'user@host', port } opens an SSH session instead of the local shell.
  create({ cwd, cols = 100, rows = 24, ssh }) {
    let { file, args } = defaultShell();
    if (ssh) {
      const target = String(ssh.target || '').trim();
      const port = ssh.port ? String(ssh.port).trim() : '';
      if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9._:\[\]-]+)?$/.test(target)) throw new Error('Enter an SSH host like user@example.com');
      if (port && !/^\d{1,5}$/.test(port)) throw new Error('The port must be a number');
      file = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
      args = [...(port ? ['-p', port] : []), '--', target];
    }
    const id = this.nextId++;
    const dir = cwd || os.homedir();
    const env = { ...process.env, TERM_PROGRAM: 'KSTRL', COLORTERM: 'truecolor' };
    if (pty) {
      const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: dir, env, useConpty: true });
      p.onData((d) => this.send('term:data', { id, data: d }));
      p.onExit(({ exitCode }) => { this.send('term:exit', { id, code: exitCode }); this.terms.delete(id); });
      this.terms.set(id, { kind: 'pty', p });
    } else {
      // Fallback: no PTY available. Line-based shell with local echo handled by the renderer.
      const p = process.platform === 'win32'
        ? spawn(ssh ? file : 'powershell.exe', ssh ? args : ['-NoLogo', '-NoExit', '-Command', '-'], { cwd: dir, env, windowsHide: true })
        : spawn(file, ssh ? args : ['-i'], { cwd: dir, env });
      p.stdout.on('data', (d) => this.send('term:data', { id, data: d.toString().replace(/\r?\n/g, '\r\n') }));
      p.stderr.on('data', (d) => this.send('term:data', { id, data: d.toString().replace(/\r?\n/g, '\r\n') }));
      p.on('close', (code) => { this.send('term:exit', { id, code }); this.terms.delete(id); });
      p.on('error', (e) => this.send('term:data', { id, data: `\r\n${e.code === 'ENOENT' ? file + ' was not found on this PC' : e.message}\r\n` }));
      this.terms.set(id, { kind: 'pipe', p });
    }
    return { id, shell: ssh ? `ssh ${ssh.target}` : file, pty: !!pty };
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.kind === 'pty') t.p.write(data);
    else t.p.stdin.write(data.replace(/\r/g, '\n'));
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t && t.kind === 'pty' && cols > 0 && rows > 0) { try { t.p.resize(cols, rows); } catch {} }
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    try { t.p.kill(); } catch {}
    this.terms.delete(id);
  }

  killAll() { for (const id of [...this.terms.keys()]) this.kill(id); }
}

module.exports = { TerminalManager };
