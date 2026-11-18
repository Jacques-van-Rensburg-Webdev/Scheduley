// Runs the optimiser off the main thread so the page stays responsive while it searches.
// The WebAssembly solver is loaded on first use from `wasmUrl` (served next to the page).

import loadHighs, { type Highs } from 'highs';
import { optimise, type ScheduleInput } from '../scheduler';

export interface OptimiseRequest { id: number; input: ScheduleInput; wasmUrl: string; maxNodes?: number }
export type OptimiseResponse =
  | { id: number; ok: true; result: ReturnType<typeof optimise>; ms: number }
  | { id: number; ok: false; error: string };

let solver: Promise<Highs> | null = null;

self.onmessage = async (event: MessageEvent<OptimiseRequest>) => {
  const { id, input, wasmUrl, maxNodes } = event.data;
  const reply = (msg: OptimiseResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    solver ??= loadHighs({ locateFile: () => wasmUrl });
    const highs = await solver;
    const t = performance.now();
    const result = optimise(highs, input, { maxNodes });
    reply({ id, ok: true, result, ms: Math.round(performance.now() - t) });
  } catch (e) {
    solver = null;
    reply({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
