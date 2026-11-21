import type { PackConfig, PackState } from '../../../shared/instruments';
import { renderCamera } from './camera';
import { element, type PackView, type Send } from './dom';
import { renderLease } from './lease';
import { renderNetwork } from './network';

interface Stage {
  before: HTMLElement;
  receipt: HTMLElement;
  after: HTMLElement;
}

const stages = new WeakMap<HTMLElement, Stage>();

function stageFor(root: HTMLElement): Stage {
  const current = stages.get(root);
  if (current && current.receipt.parentElement === root) return current;
  const before = element('div', 'stage-content');
  const receipt = element('div', 'receipt');
  receipt.setAttribute('role', 'status');
  receipt.setAttribute('aria-atomic', 'true');
  const after = element('div', 'stage-content');
  root.replaceChildren(before, receipt, after);
  const stage = { before, receipt, after };
  stages.set(root, stage);
  return stage;
}

function render(config: PackConfig, state: PackState, send: Send): PackView {
  if (config.pack === 'lease-handoff@1' && state.pack === config.pack) return renderLease(config, state, send);
  if (config.pack === 'camera-exposure@1' && state.pack === config.pack) return renderCamera(state, send);
  if (config.pack === 'network-builder@1' && state.pack === config.pack) return renderNetwork(config, state, send);
  throw new Error('Instrument state belongs to a different pack');
}

export function mountPack(root: HTMLElement, config: PackConfig, state: PackState, send: Send): void {
  const view = render(config, state, send);
  const focused = root.ownerDocument.activeElement;
  const restore = focused instanceof HTMLElement && root.contains(focused);
  const activeControl = restore ? focused.dataset.control : undefined;
  const stage = stageFor(root);
  stage.before.replaceChildren(...view.before);
  stage.after.replaceChildren(...(view.after ?? []));
  if (stage.receipt.textContent !== view.receipt) stage.receipt.textContent = view.receipt;
  if (!restore) return;
  const controls = Array.from(root.querySelectorAll<HTMLElement>('button:enabled, select:enabled'));
  const retained = activeControl === 'reset' ? undefined : controls.find(control => control.dataset.control === activeControl);
  (retained ?? controls[0])?.focus();
}
