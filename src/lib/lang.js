const MAP = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua',
  sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql',
  dockerfile: 'dockerfile', graphql: 'graphql', vue: 'html', dart: 'dart', r: 'r', scala: 'scala',
};
export function languageFor(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return MAP[ext] || 'plaintext';
}
const COLORS = { javascript: '#f1e05a', typescript: '#3178c6', json: '#cbcb41', markdown: '#7fd3ff', html: '#e34c26', css: '#563d7c', scss: '#c6538c', python: '#3572a5', rust: '#dea584', go: '#00add8', java: '#b07219', csharp: '#178600', cpp: '#f34b7d', c: '#a8b9cc', shell: '#89e051', powershell: '#5391fe', yaml: '#cb171e' };
export const colorFor = (path) => COLORS[languageFor(path)] || '#8a8a93';
