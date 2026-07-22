// ponytail: RED-commit stub — deliberately incomplete so tests fail on
// assertions, not import errors. Replaced in the green commit.
import type { NewRunEvent, Run, RunEvent, Submission } from "./types";

export interface Storage {
  getSubmission(id: string): Promise<Submission | undefined>;
  putSubmission(submission: Submission): Promise<void>;
  listSubmissions(): Promise<Submission[]>;
  getRun(id: string): Promise<Run | undefined>;
  putRun(run: Run): Promise<void>;
  listRuns(): Promise<Run[]>;
  appendRunEvents(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
  listRunEvents(runId: string): Promise<RunEvent[]>;
  putTraceBlob(runId: string, taskId: string, name: string, data: Buffer | string): Promise<string>;
}

export class MemoryStorage implements Storage {
  async getSubmission(_id: string): Promise<Submission | undefined> {
    return undefined;
  }

  async putSubmission(_submission: Submission): Promise<void> {
    // not implemented yet
  }

  async listSubmissions(): Promise<Submission[]> {
    return [];
  }

  async getRun(_id: string): Promise<Run | undefined> {
    return undefined;
  }

  async putRun(_run: Run): Promise<void> {
    // not implemented yet
  }

  async listRuns(): Promise<Run[]> {
    return [];
  }

  async appendRunEvents(_runId: string, _events: NewRunEvent[]): Promise<RunEvent[]> {
    return [];
  }

  async listRunEvents(_runId: string): Promise<RunEvent[]> {
    return [];
  }

  async putTraceBlob(_runId: string, _taskId: string, _name: string, _data: Buffer | string): Promise<string> {
    return "";
  }
}
