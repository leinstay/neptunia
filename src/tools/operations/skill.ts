// Operations `skill.read` and `skill.disable`: her side of her skills (src/skills/). `skill.read { name }` answers the
// whole stored text of the active version of a skill: a call of a skill's entry in her tools array runs it
// (src/turn/skill-calls.ts). `skill.disable { name }` is her own switch: the skill leaves her tools until the owner
// brings it back with `/skills enable`. Both
// run against the skills the core gives the operations' environment (`env.skills`); a core with none answers
// `failed`. Neither is granted to her in the tracked config: the owner opens them with `/tools grant`. A skill that
// is not active or is disabled cannot be read.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { argsProblem, scriptManifest, snapshotDir, snapshotProblem } from '../../skills/package.ts';
import { runSkillScript } from '../../skills/run.ts';
import { skillRunSettings } from '../../skills/settings.ts';
import { log } from '../../log.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { objOf, textOf } from '../types.ts';
import type { Obj } from '../types.ts';

/** The stored credentials of a skill; none when its file is absent or broken. */
function readCredentials(skillDir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(skillDir, 'credentials.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const unavailable = () => ({
  status: 'failed',
  code: CODE.NOT_CONFIGURED,
  summary: 'skills: not available here',
  data: null,
});

const handlers = perEnv((env) => {
  /** The skill name of the arguments, or the refusal of a call without one. */
  function nameOf(args: Obj): string {
    const name = textOf(args.name).trim();
    if (!name) throw invalid('name: the skill to use');
    return name;
  }

  async function cmdRead(args: Obj) {
    const name = nameOf(args);
    const skills = env.skills;
    if (skills == null) return unavailable();
    const shown = await skills.show(name);
    const active = shown?.row.active ?? null;
    if (shown === null || active === null || shown.text === null || shown.row.disabled) {
      return { status: 'failed', code: CODE.NOT_FOUND, summary: `no active skill named ${name}`, data: null };
    }
    return {
      status: 'ok',
      code: CODE.OK,
      summary: shown.text,
      data: { name, versionId: active.versionId, text: shown.text },
    };
  }

  async function cmdDisable(args: Obj) {
    const name = nameOf(args);
    const skills = env.skills;
    if (skills == null) return unavailable();
    const done = await skills.disable(name, 'persona');
    if (!done.ok) {
      return { status: 'failed', code: CODE.NOT_FOUND, summary: `no skill named ${name}`, data: null };
    }
    const text = done.changed ? `${name} is off for you until the owner turns it on` : `${name} was already off`;
    return { status: 'ok', code: CODE.OK, summary: text, data: { name, changed: done.changed } };
  }

  /** The JSON object of `args`, or the refusal of anything else. */
  function argsOf(given: unknown): Record<string, unknown> {
    const text = textOf(given).trim();
    if (text === '') return {};
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalid('args: one JSON object');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('args: one JSON object');
    return value as Record<string, unknown>;
  }

  /**
   * `skill.run { name, script, args }`: a script of the activated version of a skill that names `skill.run` among its
   * tools and declares that script in its `setup.json`. Generic `skill.run` alone grants no script: the version the
   * owner or an agent activated decides. Only the credentials that script declares reach it.
   */
  async function cmdRun(args: Obj) {
    const name = nameOf(args);
    const script = textOf(args.script).trim();
    if (!script) throw invalid('script: the file to run');
    const { args: scriptArgs } = args;
    const given = argsOf(scriptArgs);
    const skills = env.skills;
    if (skills == null || !env.dataDir) return unavailable();
    const shown = await skills.show(name);
    const active = shown?.row.active ?? null;
    if (shown === null || active === null || shown.row.disabled || !active.tools.includes('skill.run'))
      return {
        status: 'failed',
        code: CODE.NOT_FOUND,
        summary: `no active skill named ${name} runs scripts`,
        data: null,
      };
    const skillDir = path.join(env.dataDir, 'skills', name);
    const packageDir = snapshotDir(skillDir, active.contentHash);
    const broken = snapshotProblem(packageDir, active.contentHash, script);
    if (broken !== null) {
      log.warn('skill.run: snapshot refused', { skill: name, version: active.versionId, problem: broken });
      return {
        status: 'failed',
        code: broken === 'missing' ? CODE.SKILL_MISSING : CODE.SKILL_TAMPERED,
        summary: `${name}: the activated version cannot run (${broken})`,
        data: null,
      };
    }
    const manifest = scriptManifest(packageDir, script);
    if (manifest === null) throw invalid(`${name} declares no script ${script}`);
    const problem = argsProblem(manifest, given);
    if (problem !== null) throw invalid(`args: ${problem}`);
    const known = readCredentials(skillDir);
    const absent = manifest.credentials.filter((key) => typeof known[key] !== 'string');
    if (absent.length > 0)
      return {
        status: 'failed',
        code: CODE.NOT_CONFIGURED,
        summary: `${name} needs ${absent.join(', ')}: the owner sets it with /skills set ${name}`,
        data: null,
      };
    const credentials = Object.fromEntries(manifest.credentials.map((key) => [key, String(known[key])]));
    const { timeoutMs, maxOutputBytes } = skillRunSettings(objOf(env.hot).config);
    const result = await runSkillScript({
      dataDir: env.dataDir,
      name,
      packageDir,
      script,
      args: given,
      credentials,
      timeoutMs,
      maxOutputBytes,
      runId: randomUUID(),
    });
    return {
      status: result.status,
      code: result.status === 'ok' ? CODE.OK : result.code,
      summary: result.text || `${name} ${script}: ${result.code}`,
      data: { name, script, data: result.data, outputs: result.files },
    };
  }

  return { cmdRead, cmdDisable, cmdRun };
});

defineOp({
  name: 'skill.read',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdRead(args),
});
defineOp({
  name: 'skill.run',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdRun(args),
});
defineOp({
  name: 'skill.disable',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdDisable(args),
});
