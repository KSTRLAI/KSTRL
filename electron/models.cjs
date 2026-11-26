// KSTRL model catalog. Each Colossus model is served by a configurable backend model ID
// (Settings → Models). Defaults map the line-up onto the Claude family via the Anthropic API.
const MODELS = [
  {
    id: 'colossus-2',
    name: 'Colossus 2',
    tag: 'Fast',
    description: 'Quick edits, explanations and everyday questions.',
    backend: 'claude-haiku-5-5',
    fallback: false,
    weight: 0.5,
  },
  {
    id: 'colossus-2.1',
    name: 'Colossus 2.1',
    tag: 'Balanced',
    description: 'Balanced speed and quality for everyday coding.',
    backend: 'claude-sonnet-5-5',
    fallback: true,
    weight: 1,
  },
  {
    id: 'colossus-2.2',
    name: 'Colossus 2.2',
    tag: 'Coding',
    description: 'Stronger coding and reasoning for larger tasks.',
    backend: 'claude-sonnet-5-5',
    fallback: true,
    weight: 1.6,
  },
  {
    id: 'colossus-2.2-uc',
    name: 'Colossus 2.2 UC',
    tag: 'Ultracode',
    description: 'Tuned for heavy coding: refactors, multi-file changes, debugging. Used when effort is set to UltraCode.',
    backend: 'claude-sonnet-5-5',
    fallback: true,
    hidden: true, // not in the model picker — activated by the UltraCode effort level
    weight: 2.5,
  },
  {
    id: 'colossus-3',
    name: 'Colossus 3',
    tag: 'Flagship',
    description: 'The flagship. Maximum capability for the hardest work.',
    backend: 'claude-fable-5-2',
    fallback: true,
    weight: 4,
  },
];

// Effort levels from kstrlsi — Flash / Normal / High (+ Max for KSTRL MAX-style deep runs).
const EFFORTS = [
  { id: 'flash', name: 'Flash', api: 'low', description: 'Instant, lightweight replies' },
  { id: 'normal', name: 'Normal', api: 'medium', description: 'Balanced speed and depth' },
  { id: 'high', name: 'High', api: 'high', description: 'Takes its time on multi-step work' },
  { id: 'max', name: 'Max', api: 'max', description: 'Full effort for the hardest problems' },
  { id: 'ultracode', name: 'UltraCode', api: 'high', model: 'colossus-2.2-uc', description: 'Heavy coding: refactors and multi-file work' },
];

// Daily usage. A request costs credits = (input tokens + 3 × output tokens) / 1000
// × the model's weight (above) × the mode's weight (below). Build costs the most.
const MODES = [
  { id: 'build', name: 'Build', weight: 1 },
  { id: 'plan', name: 'Plan', weight: 0.5, model: 'colossus-2.1' }, // planning always runs Colossus 2.1 to save usage
  { id: 'ask', name: 'Ask', weight: 0.35 },
];
const PLANS = {
  free: { id: 'free', name: 'Free', daily: 2500 },
  max: { id: 'max', name: 'KSTRL MAX', daily: 50000 }, // 20× Free
};

module.exports = { MODELS, EFFORTS, MODES, PLANS };
