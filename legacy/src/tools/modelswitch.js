/**
 * Voice model switching — Roadmap 6 #10.
 *
 * "Legacy, switch to Haiku" / "think with Opus" / "back to Sonnet". The
 * tool fuzzy-matches against the models Shahyd's key can actually run
 * (the same live list the Settings window shows), persists the choice, and
 * the neural core on screen shifts to that model's colour.
 */
import { registerTool } from './registry.js';
import { availableModels, updateSettings } from '../settings.js';
import { config } from '../config.js';

registerTool({
  name: 'switch_model',
  description:
    'Switch which model Legacy thinks with, by voice: "switch to haiku", ' +
    '"use opus", "back to sonnet". Matches loosely against the models the ' +
    'API key can use; the change applies from the NEXT turn and the core ' +
    'changes colour to match. Use list wording ("what models can I use") ' +
    'to just show the options.',
  inputSchema: {
    type: 'object',
    properties: { model: { type: 'string', description: 'Model name or a loose fragment like "haiku", "opus", "sonnet 4".' } },
    required: ['model'],
  },
  handler: async ({ model }) => {
    const want = String(model ?? '').trim().toLowerCase();
    if (!want) throw new Error('Which model? Say something like "switch to haiku".');
    const models = await availableModels();
    const score = (m) => {
      const hay = `${m.id} ${m.label}`.toLowerCase();
      if (hay.includes(want)) return want.length + (m.id === config.model.name ? -1 : 0);
      const words = want.split(/\s+/).filter(Boolean);
      const hits = words.filter((w) => hay.includes(w)).length;
      return hits === words.length ? hits : 0;
    };
    const ranked = models.map((m) => [score(m), m]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
    if (!ranked.length) {
      throw new Error(`No model matches "${model}". Available: ${models.map((m) => m.label).join(', ')}.`);
    }
    const chosen = ranked[0][1];
    if (chosen.id === config.model.name) return `Already thinking with ${chosen.label}.`;
    await updateSettings({ model: chosen.id });
    return `Switched to ${chosen.label} — it takes over from my next reply, and the core is changing colour now.`;
  },
});
