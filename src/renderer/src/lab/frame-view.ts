import type { InstrumentView } from './view-contract';

export function mountCustomView(root: HTMLElement, title: string, view: InstrumentView, act: (id: string) => void) {
  const heading = document.createElement('h2');
  heading.textContent = title;
  const description = document.createElement('p');
  description.className = 'receipt';
  description.textContent = view.text;
  description.setAttribute('role', 'status');
  const controls = document.createElement('div');
  controls.className = 'controls';
  const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.value : null;
  for (const { id, label } of view.controls) {
    const button = document.createElement('button');
    button.value = id;
    button.textContent = label;
    button.onclick = () => act(id);
    controls.append(button);
  }
  root.replaceChildren(heading, description);
  if (view.marks.length) {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 260;
    canvas.style.width = '100%';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The instrument canvas is unavailable.');
    ctx.scale(canvas.width / 100, canvas.height / 100);
    for (const mark of view.marks) {
      ctx.fillStyle = mark.color;
      ctx.fillRect(mark.x, mark.y, mark.width, mark.height);
    }
    root.append(canvas);
  }
  root.append(controls);
  if (focused) [...controls.querySelectorAll('button')].find(button => button.value === focused)?.focus();
}
