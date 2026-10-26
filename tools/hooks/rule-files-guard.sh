#!/usr/bin/env bash
# Claude Code PreToolUse hook (wired in .claude/settings.json) on Edit, Write, MultiEdit and NotebookEdit: the
# rule files of this repository change only with the maintainer's explicit approval (AGENTS.md, section "Rule
# files"). They are AGENTS.md, CLAUDE.md, STYLEGUIDE.md, WRITING.md and CONTRIBUTING.md at the repository root,
# and .agents/AGENTS.md, a deployment's private rules. An agent that wants one changed stops and asks.
#
# The approval is the marker file .agents/tmp/rules-unlock under the project root: whoever got the maintainer's
# yes creates it for that one change and removes it after the commit. The marker is never tracked. Without it
# the edit is refused with a reason the agent reads.
#
# Input: the hook JSON on stdin (.tool_input.file_path, or .tool_input.notebook_path). Output: nothing and exit 0
# to allow; a "deny" decision on stdout and exit 0 to refuse. Needs jq.
#
# Test by hand from the repository root (expect "deny" for the first, nothing for the second):
#   echo '{"tool_input":{"file_path":"'"$PWD"'/AGENTS.md"}}' | tools/hooks/rule-files-guard.sh
#   echo '{"tool_input":{"file_path":"'"$PWD"'/src/index.js"}}' | tools/hooks/rule-files-guard.sh
set -u

root="${CLAUDE_PROJECT_DIR:-$PWD}"
unlock="$root/.agents/tmp/rules-unlock"

command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0
[ -e "$unlock" ] && exit 0

name=$(basename "$file")
case "$name" in
  AGENTS.md | CLAUDE.md | STYLEGUIDE.md | WRITING.md | CONTRIBUTING.md) ;;
  *) exit 0 ;;
esac
# Only at the root of a checkout, worktree or clone (the folder holds a package.json), or in its .agents folder.
parent=$(dirname "$file")
[ -f "$parent/package.json" ] || [ "$(basename "$parent")" = .agents ] || exit 0

reason="$name is a rule file: AGENTS.md, CLAUDE.md, STYLEGUIDE.md, WRITING.md and CONTRIBUTING.md at the root, and .agents/AGENTS.md, change only with the maintainer's explicit approval (AGENTS.md, section Rule files). Stop and report what you wanted to change and why. With the approval, the marker .agents/tmp/rules-unlock lets one change through."
jq -cn --arg reason "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
exit 0
