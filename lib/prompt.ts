// A prompt counts as the vanilla/baseline run -- pi's built-in default
// system prompt, no --system-prompt passed -- when it's empty OR
// whitespace-only. Matches the runner's actual dispatch behavior, so a
// whitespace-only submission must classify identically wherever "is this
// baseline?" is checked (submission acceptance, leaderboard grouping/display).
export function isBaselinePrompt(prompt: string): boolean {
  return prompt.trim().length === 0;
}
