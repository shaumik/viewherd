/** An honest, deterministic demo planner. A real model adapter uses the same SDK tools. */
const studioDemoHelp = 'I can create two directions, keep the dark or warm one, change the color to cobalt, sand, or midnight, edit quoted copy, open editing controls, compare, remove a direction, or prepare an export. Try “Create two directions”.';
const studioDemoThemes = { cobalt: 'cobalt', blue: 'cobalt', sand: 'sand', cream: 'sand', warm: 'sand', midnight: 'midnight', dark: 'midnight', black: 'midnight' };
const studioDemoFields = { headline: 'headline', title: 'headline', subhead: 'subhead', subtitle: 'subhead', eyebrow: 'eyebrow', cta: 'cta', 'button text': 'cta', 'button label': 'cta' };
const studioDemoLimits = { headline: 80, subhead: 140, eyebrow: 48, cta: 32 };

function studioDemoTarget(text, designs, selected) {
  const value = text.replace(/^(?:the|a)\s+/, '').replace(/\s+(?:one|design|direction|artboard|panel|version)$/, '').trim();
  if (['dark', 'midnight', 'after hours', 'second', '2nd'].includes(value)) return designs.find(design => design.id === 'design_midnight')?.id || designs[1]?.id;
  if (['warm', 'sand', 'cream', 'warm minimal', 'first', '1st'].includes(value)) return designs.find(design => design.id === 'design_sand')?.id || designs[0]?.id;
  if (['blue', 'cobalt'].includes(value)) return designs.find(design => design.theme === 'cobalt')?.id;
  if (['this', 'selected', 'current', 'it'].includes(value)) return selected;
  if (value === 'other') return designs.length === 2 ? designs.find(design => design.id !== selected)?.id : undefined;
  return designs.find(design => design.name.toLowerCase() === value || design.id.toLowerCase() === value)?.id;
}

function studioDemoPlan(message, snapshot) {
  const quotes = [];
  const protectedMessage = message.replace(/"([^"\n]*)"|“([^”\n]*)”|'([^'\n]*)'/g, (_, straight, curly, single) => { quotes.push(straight ?? curly ?? single); return `__quote_${quotes.length - 1}__`; });
  const expandedMessage = protectedMessage.toLowerCase().replace(/\s+with\s+(?:the\s+)?(headline|title|subhead|subtitle|eyebrow|cta|button text|button label)\s+(__quote_\d+__)/g, ' and change the $1 to $2');
  const clauses = expandedMessage.split(/\s*(?:[,;\n]+|\.\s+|\s+(?:and then|then|and)\s+)\s*/).map(clause => clause.trim().replace(/[.!?]+$/, '').replace(/^(?:(?:please|can you|could you|would you|let's|lets)\s+)+/, '').replace(/^and\s+/, '').replace(/\s+please$/, '')).filter(Boolean);
  let selected = snapshot.selectedDesignId;
  const designs = snapshot.designs.map(design => ({ ...design }));
  const plan = [];
  for (const clause of clauses) {
    if (/^(?:create|make|generate|build|give me|show me|open)\s+(?:(?:two|2|both)\s+)?(?:visual\s+|launch\s+)?(?:directions|designs|versions|variations|options)(?:\s+(?:side by side|for (?:this|the|my) (?:product|launch|campaign|headphones)|for me))?$/.test(clause)) {
      const created = !designs.some(design => design.id === 'design_midnight');
      if (!designs.some(design => design.id === 'design_sand')) designs.push({ id: 'design_sand', name: 'Warm minimal', theme: 'sand' });
      if (created) { designs.push({ id: 'design_midnight', name: 'After hours', theme: 'midnight' }); selected = 'design_midnight'; }
      plan.push({ action: 'createDirections', args: {}, label: 'Create two directions', reply: 'Opened two directions side by side.' }); continue;
    }
    if (/^(?:compare(?:\s+(?:them|both|the directions|the designs|the two))?|show\s+(?:both|them)(?:\s+(?:directions|designs))?(?:\s+side by side)?|put\s+them\s+side by side)$/.test(clause)) {
      if (!designs.some(design => design.id === 'design_sand')) designs.push({ id: 'design_sand', name: 'Warm minimal', theme: 'sand' });
      if (!designs.some(design => design.id === 'design_midnight')) { designs.push({ id: 'design_midnight', name: 'After hours', theme: 'midnight' }); selected = 'design_midnight'; }
      plan.push({ action: 'compare', args: {}, label: 'Compare directions', reply: 'Opened both directions for comparison.' }); continue;
    }
    let match = /^(?:keep|pick|choose|select|use|go with|focus on)\s+(.+)$/.exec(clause);
    if (match) {
      const designId = studioDemoTarget(match[1], designs, selected);
      if (!designId) return { reply: 'That direction is not available yet. Ask me to create two directions first.' };
      selected = designId;
      plan.push({ action: 'select', args: { designId }, label: 'Keep the chosen direction', reply: 'Kept your chosen direction and closed the comparison.' }); continue;
    }
    match = /^(?:change|set|update|make|rewrite)\s+(?:the\s+)?(headline|title|subhead|subtitle|eyebrow|cta|button text|button label)\s+(?:(?:to|as|say)\s+)?__quote_(\d+)__$/.exec(clause);
    if (match) {
      const field = studioDemoFields[match[1]], copy = quotes[Number(match[2])];
      if (typeof copy !== 'string' || copy.length > studioDemoLimits[field] || ['headline', 'cta'].includes(field) && !copy.trim()) return { reply: `Keep the ${match[1]} under ${studioDemoLimits[field]} characters${['headline', 'cta'].includes(field) ? ' and include some text' : ''}.` };
      plan.push({ action: 'refine', args: { designId: selected, [field]: copy }, label: `Update the ${match[1]}`, reply: `Updated the ${match[1]}.` }); continue;
    }
    match = /^(?:make|turn|change|set|switch)\s+(?:(?:it|this|the design|the color|the colour|the palette|the theme)\s+)?(?:(?:to|into)\s+)?(cobalt|blue|sand|cream|warm|midnight|dark|black)(?:\s+(?:blue|theme|palette))?$/.exec(clause);
    if (match) {
      const theme = studioDemoThemes[match[1]], design = designs.find(item => item.id === selected);
      if (design) design.theme = theme;
      plan.push({ action: 'refine', args: { designId: selected, theme }, label: `Change the palette to ${theme}`, reply: `Changed the palette to ${theme}.` }); continue;
    }
    match = /^(?:make|turn|change|set|switch|resize)\s+(?:(?:it|this|the design|the format|the size)\s+)?(?:(?:to|into|a)\s+)?(story|vertical|portrait|square)(?:\s+(?:format|size))?$/.exec(clause);
    if (match) {
      const format = match[1] === 'square' ? 'square' : 'story';
      plan.push({ action: 'refine', args: { designId: selected, format }, label: `Resize to ${format}`, reply: `Resized it to ${format}.` }); continue;
    }
    if (/^(?:(?:open|show|bring up)\s+(?:the\s+)?(?:editing controls|edit controls|editing panel|editor|inspector|design controls|color controls)|edit(?:\s+(?:it|the design))?)$/.test(clause)) {
      plan.push({ action: 'inspect', args: {}, label: 'Open editing controls', reply: 'Opened the editing controls beside the artboard.' }); continue;
    }
    if (/^(?:export|download|save)\s*(?:(?:it|this|the design|the winner|the selected design|the asset|assets|the assets)(?:\s+(?:as\s+)?(?:svg|png))?)?$/.test(clause)) {
      plan.push({ action: 'export', args: {}, label: 'Prepare export files', reply: 'Prepared the export. Use the download buttons to save the SVG or PNG.' }); continue;
    }
    match = /^(?:remove|delete)\s+(.+)$/.exec(clause);
    if (match) {
      const designId = studioDemoTarget(match[1], designs, selected);
      if (!designId) return { reply: 'I could not find that direction. Name the warm or dark one to remove.' };
      if (designs.length < 2) return { reply: 'Keep at least one design in the studio. Create another direction before removing this one.' };
      designs.splice(designs.findIndex(design => design.id === designId), 1);
      if (selected === designId) selected = designs[0].id;
      plan.push({ action: 'remove', args: { designId }, label: 'Remove the direction', reply: 'Removed that saved direction and its panels.' }); continue;
    }
    if (/^(?:reset(?:\s+(?:the studio|the demo|everything|it))?|start over)$/.test(clause)) {
      designs.splice(0, designs.length, { id: 'design_sand', name: 'Warm minimal', theme: 'sand' }); selected = 'design_sand';
      plan.push({ action: 'reset', args: {}, label: 'Restore the sample studio', reply: 'Restored the sample photo and original design.' }); continue;
    }
    // Preflight the whole request: an unsupported clause performs no design actions.
    return { reply: studioDemoHelp };
  }
  if (!plan.length) return { reply: studioDemoHelp };
  if (plan.length > 10) return { reply: 'That request needs more than ten actions. Split it into two messages.' };
  return { plan };
}

export function createDemoAgent() {
  return {
    mode: 'demo',
    async run({ message, snapshot, call, signal }) {
      if (signal.aborted) throw signal.reason;
      const planned = studioDemoPlan(message, await snapshot());
      if (planned.reply) return planned.reply;
      const replies = [];
      for (const step of planned.plan) {
        if (signal.aborted) throw signal.reason;
        await call({ action: step.action, args: step.args, label: step.label });
        replies.push(step.reply);
      }
      return replies.join(' ');
    },
  };
}
