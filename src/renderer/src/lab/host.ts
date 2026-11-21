import { packContracts } from '../../../shared/instruments';
import type { IpcResponse } from '../../../shared/ipc';
import type { ReaderLesson } from '../../../shared/reader';
import { call } from '../api';
import { StageChannel } from './channel';
import { LAB_LIFETIME_MS } from '../../../shared/lab-ipc';
import type { StageContent } from './frame';

type Opened = IpcResponse<'lab:open'>;
interface StageEvents {
  onUse: () => void;
  onReady: () => void;
  onLesson: (lesson: ReaderLesson) => void;
  onFailure: (reason: string) => void;
}

export class InstrumentHost {
  private readonly frame = document.createElement('iframe');
  private readonly ports = new MessageChannel();
  private readonly channel: StageChannel;
  private readonly lifetime: number;
  private readonly startup: number;
  private pending = false;
  private accepted = 0;
  private closed = false;

  constructor(container: HTMLElement, title: string, private opening: Opened, private events: StageEvents) {
    this.channel = new StageChannel(opening.session, performance.now());
    this.frame.title = title;
    this.frame.className = 'instrument-frame';
    this.frame.style.visibility = 'hidden';
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.referrerPolicy = 'no-referrer';
    this.frame.src = 'app://instrument/stage';
    this.frame.onload = () => {
      this.frame.onload = () => this.fail(new Error('The instrument document changed.'));
      this.frame.contentWindow?.postMessage({ session: opening.session }, '*', [this.ports.port2]);
    };
    this.ports.port1.onmessage = event => void this.receive(event.data).catch(error => this.fail(error));
    this.ports.port1.onmessageerror = () => this.fail(new Error('The instrument sent an unreadable message.'));
    this.startup = window.setTimeout(() => this.fail(new Error('The instrument did not start.')), 5000);
    this.lifetime = window.setTimeout(() => this.fail(new Error('This instrument session expired.')), LAB_LIFETIME_MS);
    container.replaceChildren(this.frame);
  }

  private display(content: StageContent) {
    if (!this.closed) this.ports.port1.postMessage(content);
  }

  private start() {
    window.clearTimeout(this.startup);
    const { manifest: { config }, state } = this.opening;
    if (config.pack === 'bundle@1') {
      this.display({ program: config });
    } else if (state?.pack === config.pack) {
      this.display({ config, state });
    } else throw new Error('The instrument received an incompatible initial state.');
  }

  private async receive(raw: unknown) {
    if (this.closed) return;
    const message = this.channel.read(raw, performance.now());
    if (!message) return;
    if (message.kind === 'failed') { this.fail(new Error(message.reason)); return; }
    if (message.kind === 'ready') { this.start(); this.events.onReady(); return; }
    if (message.kind === 'layout') {
      this.frame.height = String(message.height);
      this.frame.style.visibility = 'visible';
      return;
    }
    const { manifest: { config }, session } = this.opening;
    if (config.pack === 'bundle@1') {
      if (typeof message.input === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(message.input)) {
        this.events.onUse();
        this.display({ action: message.input });
      }
      return;
    }
    const valid = packContracts[config.pack].inputSchema.safeParse(message.input);
    if (!valid.success || this.pending) return;
    this.pending = true;
    try {
      const result = await call('lab:input', { session, seq: ++this.accepted, input: valid.data });
      if (this.closed) return;
      if (result.state?.pack !== config.pack) throw new Error('The instrument received an incompatible state.');
      this.events.onUse();
      this.display({ config, state: result.state });
      if (result.lesson) this.events.onLesson(result.lesson);
    } finally {
      this.pending = false;
    }
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.close();
    this.events.onFailure(error instanceof Error ? error.message : 'The instrument stopped unexpectedly.');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.startup);
    window.clearTimeout(this.lifetime);
    this.ports.port1.close();
    this.ports.port2.close();
    this.frame.remove();
    void closeLab(this.opening.session);
  }
}

export function closeLab(session: string) {
  return call('lab:close', { session }).catch(error => console.error('Could not release the instrument session', error));
}
