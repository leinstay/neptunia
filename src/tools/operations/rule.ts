// Operations: `rule.*`: the owner's rules, rows of the memory table `rules` (src/memory/store-rules.ts). A rule's
// number is its place among the live rules, the first added first, counted from 1. Removing a rule deletes its row.

import { NONE } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { objOf } from '../types.ts';
import type { StoreRules } from '../../memory/store-rules.ts';

const handlers = perEnv((env) => {
  // The ops env carries the store untyped; these are the rules methods of src/memory/store.ts.
  const store = env.store as Pick<StoreRules, 'liveRules' | 'addRule' | 'removeRule'>;

  function cmdRuleAdd(args: unknown): string {
    const said = objOf(args).text;
    // A rule is one line of the list: the lines of a text given over several join with a space.
    const rule = (typeof said === 'string' ? said : '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
    if (!rule) throw invalid('rule text is required');
    store.addRule(rule);
    return `Rule added: ${rule}`;
  }

  function cmdRuleList() {
    const rules = store.liveRules();
    if (!rules.length) return NONE;
    return rules.map((rule, i) => `${i + 1}. ${rule.text}`).join('\n');
  }

  function cmdRuleRemove(args: unknown): string {
    const n = objOf(args).number;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw invalid('a rule number is required');
    const rule = n >= 1 ? store.liveRules()[n - 1] : undefined;
    if (!rule) throw invalid(`no rule #${n}`, CODE.NOT_FOUND);
    store.removeRule(rule.id);
    return `Removed rule #${n}: ${rule.text}`;
  }

  return { cmdRuleAdd, cmdRuleList, cmdRuleRemove };
});

defineOp({
  name: 'rule.add',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdRuleAdd(args),
});
defineOp({
  name: 'rule.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdRuleList(),
});
defineOp({
  name: 'rule.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdRuleRemove(args),
});
