import { describe, expect, it } from 'vitest';
import type { BundleConfig } from '../../../shared/lab-config';
import { hostilePrograms } from '../../../../tests/fixtures/instruments/containment';
import { InstrumentProgram } from './interpreter';

function config(source: string): BundleConfig {
  return { pack: 'bundle@1', parameters: { title: 'Instrument', initial: '3' },
    bundle: { apiVersion: 'delve.view/1', entry: 'step', sha256: '0'.repeat(64), source } };
}

describe('isolated instrument interpreter', () => {
  it('renders successive views using only the authored state and chosen control', async () => {
    const program = await InstrumentProgram.load(config(`let n = 0;
      function step(initial, action) {
        n = action === '' ? Number(initial) : n + 1;
        return {text: String(n), controls: [{id:'advance', label:'Advance'}],
          marks:[{x:n,y:0,width:10,height:10,color:'#123456'}]};
      }`));
    try {
      expect(program.step('')).toMatchObject({ text: '3', marks: [{ x: 3 }] });
      expect(program.step('advance')).toMatchObject({ text: '4', marks: [{ x: 4 }] });
    } finally { program.dispose(); }
  });

  it.each(Object.entries(hostilePrograms).filter(([name]) => name !== 'loop'))('rejects the %s fixture', async (_name, instruction) => {
    const program = await InstrumentProgram.load(config(`function step() { ${instruction}; return {text:'OK', controls:[], marks:[]} }`));
    try {
      expect(() => program.step('')).toThrow();
    } finally { program.dispose(); }
  }, 2000);
});
