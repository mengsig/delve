import type { LabManifest } from './lab-config';
import type { PackState } from './instruments';
import type { LessonAddress, ReaderLesson } from './reader';

export const LAB_LIFETIME_MS = 15 * 60_000;
export const LAB_ACTION_LIMIT = 256;

export interface LabContract {
  'lab:open': {
    request: LessonAddress & { revision: string | null; messageId: number | null; blockIndex: number };
    response: { session: string; manifest: LabManifest; state: PackState | null };
  };
  'lab:input': {
    request: { session: string; seq: number; input: unknown };
    response: { state: PackState | null; lesson?: ReaderLesson };
  };
  'lab:close': { request: { session: string }; response: boolean };
}
