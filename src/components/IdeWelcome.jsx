import React from 'react';
import { FolderOpen, GitBranchPlus, SquareTerminal, FileSearch, MessageSquarePlus, TerminalSquare } from 'lucide-react';

const base = (p) => p.split(/[\\/]/).pop();

// Empty IDE window, Cursor-style: wordmark, plan line and three action cards.
export default function IdeWelcome({ settings, workspace, onOpenFolder, onClone, onSsh, onOpenRecent, onUpgrade, onFiles, onChat, onTerminal }) {
  const max = settings.plan === 'max';
  const cards = workspace
    ? [[FileSearch, 'Go to file', onFiles], [MessageSquarePlus, 'Ask Kestrel', onChat], [TerminalSquare, 'New terminal', onTerminal]]
    : [[FolderOpen, 'Open project', onOpenFolder], [GitBranchPlus, 'Clone repo', onClone], [SquareTerminal, 'Connect via SSH', onSsh]];
  const recent = workspace ? [] : (settings.recentFolders || []).slice(0, 5);
  return (
    <div className="ide-welcome">
      <div className="ide-welcome-inner">
        <div className="ide-brand"><img src="./logo.png" alt="" /><span className="wm">KSTRL</span></div>
        <div className="ide-plan">
          {max ? 'KSTRL MAX' : <>Free Plan · <button onClick={onUpgrade}>Upgrade</button></>}
        </div>
        <div className="ide-cards">
          {cards.map(([I, t, run]) => (
            <button key={t} className="ide-card" onClick={run}><I size={16} />{t}</button>
          ))}
        </div>
        {recent.length > 0 && (
          <div className="ide-recent">
            <div className="h">Recent projects</div>
            {recent.map((f) => (
              <button key={f} onClick={() => onOpenRecent(f)} title={f}><span className="n">{base(f)}</span><span className="p">{f}</span></button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
