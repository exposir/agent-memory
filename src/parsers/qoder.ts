import { parseClaudeLine, type ClaudeMessage } from "./claude.js";

// Qoder stores Claude-Code-shaped session files under
// ~/.qoder/projects/<project>/<session>.jsonl, so the Claude parser applies
// unchanged.
export function parseQoderLine(
  line: string,
  sid: string,
  ordinal: number,
  project: string,
): ClaudeMessage | null {
  return parseClaudeLine(line, sid, ordinal, project);
}
