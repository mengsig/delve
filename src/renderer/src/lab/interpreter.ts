import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten-core';
import { MAX_VIEW_BYTES, viewSchema, type InstrumentView } from './view-contract';
import type { BundleConfig } from '../../../shared/lab-config';

const heapLimit = 2 * 1024 * 1024;

export class InstrumentProgram {
  private deadline = 0;
  private interrupts = 0;

  private constructor(private runtime: QuickJSRuntime, private context: QuickJSContext, private initial: string) {
    runtime.setInterruptHandler(() => ++this.interrupts > 64 || performance.now() >= this.deadline);
  }

  static async load(config: BundleConfig): Promise<InstrumentProgram> {
    const wasm = await newQuickJSWASMModuleFromVariant(variant);
    const runtime = wasm.newRuntime();
    runtime.setMemoryLimit(heapLimit);
    runtime.setMaxStackSize(128 * 1024);
    const context = runtime.newContext({ intrinsics: { BaseObjects: true, Eval: true, JSON: true, MapSet: true } });
    const program = new InstrumentProgram(runtime, context, config.parameters.initial);
    try {
      program.startBudget();
      program.evaluate(config.bundle.source).dispose();
      return program;
    } catch (error) {
      program.dispose();
      throw error;
    }
  }

  private startBudget() {
    this.deadline = performance.now() + 100;
    this.interrupts = 0;
  }

  private evaluate(source: string) {
    const result = this.context.evalCode(source, 'instrument.js', { type: 'global', strict: true });
    if (result.error) {
      result.error.dispose();
      throw new Error('The instrument stopped during execution or exceeded its computation budget.');
    }
    return result.value;
  }

  step(action: string): InstrumentView {
    this.startBudget();
    const call = 'JSON.stringify(step(' + JSON.stringify(this.initial) + ',' + JSON.stringify(action) + '))';
    const value = this.evaluate(call);
    try {
      if (this.context.typeof(value) !== 'string') throw new Error('The instrument returned an invalid view.');
      const length = this.context.getProp(value, 'length').consume(handle => this.context.getNumber(handle));
      if (!Number.isSafeInteger(length) || length > MAX_VIEW_BYTES) throw new Error('The instrument exceeded its output limit.');
      const output = this.context.getString(value);
      if (new TextEncoder().encode(output).byteLength > MAX_VIEW_BYTES) {
        throw new Error('The instrument exceeded its output limit.');
      }
      return viewSchema.parse(JSON.parse(output));
    } finally {
      value.dispose();
    }
  }

  dispose() {
    this.context.dispose();
    this.runtime.dispose();
  }
}
