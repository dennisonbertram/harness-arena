/** Shared by every Blob writer and the GET-only operations inventory. */
export const BLOB_PATHS = Object.freeze({
  submissions: "submissions/",
  runs: "runs/",
  competitions: "competitions/",
  events: "events/",
  traces: "traces/",
  voiceManifest: "voice/manifest.json",
  voiceJudgments: "voice/judgments/",
  voiceAudioPrompts: "voice/audio/prompts/",
  voiceAudioResponses: "voice/audio/responses/",
  cleanupOperations: "archives/competition-cleanup-operations/",
  cleanupArchives: "archives/competition-cleanups/",
  competitionResets: "archives/competition-resets/",
  archives: "archives/",
});
