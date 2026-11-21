import type { LabConfig } from './lab-config';
import type { PackState } from './instruments';
import type { LessonAddress, ReaderLesson } from './reader';

export interface LabContract {
  'lab:open': {
    request: LessonAddress & { revision: string | null; messageId: number | null; blockIndex: number };
    response: { session: string; config: LabConfig; state: PackState | null };
  };
  'lab:input': {
    request: { session: string; seq: number; input: unknown };
    response: { state: PackState | null; lesson?: ReaderLesson };
  };
  'lab:close': { request: { session: string }; response: boolean };
}
