// Operations: `/nep rule`: the live rules in prompts.local/rules.md (the tracked prompts/ layer is never written).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import fs from 'node:fs';
import path from 'node:path';
import { NONE, listRules, appendRule, removeRule, reloadNote } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot } = env;

  function localRulesFile() {
    return path.join(hot.localPromptsDir, 'rules.md');
  }

  function baseRulesFile() {
    return path.join(hot.promptsDir, 'rules.md');
  }

  /** The effective rules text: the local override when it exists, else the base file, else empty. */
  function readRules() {
    const localFile = localRulesFile();
    if (fs.existsSync(localFile)) return fs.readFileSync(localFile, 'utf8');
    const baseFile = baseRulesFile();
    return fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8') : '';
  }

  /** Write `text` to prompts.local/rules.md, creating the directory when needed, and reload the
   * prompts; the reload's outcome. The tracked base file is never touched. */
  function writeLocalRules(text) {
    const file = localRulesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return hot.reloadPrompts();
  }

  function cmdRuleAdd(args) {
    const rule = String(args?.text ?? '').trim();
    if (!rule) throw invalid('rule text is required');
    const ok = writeLocalRules(appendRule(readRules(), rule));
    return `Rule added: ${rule} ${reloadNote(ok)}`;
  }

  function cmdRuleList() {
    const rules = listRules(readRules());
    if (!rules.length) return NONE;
    return rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  }

  function cmdRuleRemove(args) {
    const n = args?.number;
    if (!Number.isInteger(n)) throw invalid('a rule number is required');
    const result = removeRule(readRules(), n);
    if (!result) throw invalid(`no rule #${n}`, 'not-found');
    const ok = writeLocalRules(result.text);
    return `Removed rule #${n}: ${result.removed} ${reloadNote(ok)}`;
  }

  return { localRulesFile, baseRulesFile, readRules, writeLocalRules, cmdRuleAdd, cmdRuleList, cmdRuleRemove };
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
