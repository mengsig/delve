export type Send = (input: unknown) => void;

export interface PackView {
  before: HTMLElement[];
  receipt: string;
  after?: HTMLElement[];
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

export function header(label: string, caseId: string): HTMLElement {
  const light = element('i', 'light');
  light.setAttribute('aria-hidden', 'true');
  return element('div', 'top', element('span', '', light, label), element('span', 'caseid', caseId));
}

export function button(
  label: string, control: string, activate: () => void, className = '',
): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.dataset.control = control;
  node.addEventListener('click', activate);
  return node;
}
