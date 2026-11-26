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
  },
  {
    id: 'colossus-2.2-uc',
    name: 'Colossus 2.2 UC',
    tag: 'Ultracode',
    description: 'Tuned for heavy coding: refactors, multi-file changes, debugging. Used when effort is set to UltraCode.',
    backend: 'claude-sonnet-5-5',
    fallback: true,
    hidden: true, // not in the model picker — activated by the UltraCode effort level
  },
  {
    id: 'colossus-3',
    name: 'Colossus 3',
    tag: 'Flagship',
    description: 'The flagship. Maximum capability for the hardest work.',
    backend: 'claude-fable-5-2',
    fallback: true,
  },
];

// Effort levels from kstrlsi — Flash / Normal / High (+ Max for KSTRL MAX-style deep runs).
const EFFORTS = [
  { id: 'flash', name: 'Flash', api: 'low', description: 'Instant, lightweight replies' },
  { id: 'normal', name: 'Normal', api: 'medium', description: 'Balanced speed and depth' },
  { id: 'high', name: 'High', api: 'high', description: 'Takes its time on multi-step work' },
  { id: 'max', name: 'Max', api: 'max', description: 'Full effort for the hardest problems' },
  { id: 'ultracode', name: 'UltraCode', api: 'high', model: 'colossus-2.2-uc', description: 'Switches to Colossus 2.2 UC, tuned for heavy coding' },
];

module.exports = { MODELS, EFFORTS };
