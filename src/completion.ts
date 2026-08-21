import type { OpenAPIDocument } from "./spec.ts";
import { listOperations } from "./spec.ts";

const ROOT = ["api", "cache", "completion", "doctor", "help", "note"];
const SUBCOMMANDS: Record<string, string[]> = {
  api: ["call", "describe", "operations", "request"],
  cache: ["clear", "status"],
  note: [
    "cat",
    "create",
    "delete",
    "diff",
    "edit",
    "list",
    "ls",
    "resolve",
    "rm",
    "update",
    "view",
  ],
};

function matching(values: string[], prefix = ""): string[] {
  return values.filter((value) => value.startsWith(prefix)).toSorted();
}

export function complete(words: string[], document?: OpenAPIDocument): string[] {
  const current = words.at(-1) || "";
  if (words.length <= 1) return matching(ROOT, current);
  const root = words[0];
  if (!root) return ROOT;
  if (words.length === 2) return matching(SUBCOMMANDS[root] || [], current);

  if (root === "api" && words[1] === "call" && words.length === 3 && document) {
    return matching(
      listOperations(document).flatMap(({ operation }) => operation.operationId || []),
      current,
    );
  }

  if (current.startsWith("-")) {
    return matching(
      ["--cache", "--fresh", "--help", "--json", "--json-errors", "--offline", "--verbose"],
      current,
    );
  }
  return [];
}

export type Shell = "bash" | "fish" | "zsh";

export function completionScript(shell: Shell): string {
  if (shell === "bash") {
    return `# hmd completion for bash
_hmd_completion() {
  local IFS=$'\\n'
  COMPREPLY=($(hmd __complete "\${COMP_WORDS[@]:1}"))
}
complete -F _hmd_completion hmd
`;
  }
  if (shell === "zsh") {
    return `#compdef hmd
_hmd_completion() {
  local -a suggestions
  suggestions=(\${(f)"$(hmd __complete "\${words[@]:1}")"})
  _describe 'hmd' suggestions
}
compdef _hmd_completion hmd
`;
  }
  return `function __hmd_complete
  set -l tokens (commandline -opc)
  set -e tokens[1]
  set -l current (commandline -ct)
  hmd __complete $tokens $current
end
complete -c hmd -f -a '(__hmd_complete)'
`;
}
