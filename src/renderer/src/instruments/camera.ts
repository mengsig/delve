import type { PackState } from '../../../shared/instruments';
import { isoValues, shutterValues } from '../../../shared/instruments/camera';
import { button, element, header, type PackView, type Send } from './dom';
import { cyclistScene } from './cyclist';

type CameraState = Extract<PackState, { pack: 'camera-exposure@1' }>;

function exposureSelect(field: 'shutter' | 'iso', confirmed: number, values: readonly number[], send: Send): HTMLElement {
  const shutter = field === 'shutter';
  const control = element('select');
  control.dataset.control = field;
  control.setAttribute('aria-label', shutter ? 'Shutter speed' : 'ISO');
  for (const value of values) {
    const option = element('option', '', shutter ? `1/${value}` : String(value));
    option.value = String(value);
    control.append(option);
  }
  control.value = String(confirmed);
  control.addEventListener('change', () => {
    const value = Number(control.value);
    control.value = String(confirmed);
    if (value !== confirmed && values.includes(value)) send({ type: field, value });
  });
  return element('label', '', shutter ? 'Shutter ' : 'ISO ', control);
}

export function renderCamera(state: CameraState, send: Send): PackView {
  const { shutter, iso, captured } = state;
  return {
    before: [
      header(' Viewfinder', 'PLATE 02 \u00a0 / \u00a0 f/8 fixed'),
      element('h2', '', 'Freeze the rider.'),
      element('p', 'small', 'Aim for a sharp, readable subject. Compare motion trails and brightness.'),
      element('div', captured ? 'camera flash' : 'camera', cyclistScene(shutter, iso),
        element('span', 'cal', `1/${shutter} s \u00a0 · \u00a0 ISO ${iso}`)),
      element('div', 'controls',
        exposureSelect('shutter', shutter, shutterValues, send),
        exposureSelect('iso', iso, isoValues, send),
        button('Capture', 'capture', () => send({ type: 'capture' }), 'bright'),
        button('Reset', 'reset', () => send({ type: 'reset' }), 'reset'),
      ),
    ],
    receipt: captured
      ? 'Captured locally · see the observation in your field notes.'
      : 'Live preview · capture to record an observation.',
  };
}
