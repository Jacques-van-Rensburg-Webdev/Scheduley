// Main-thread side of the optimiser worker: one shared worker, one promise per request.

import type { ScheduleInput, ScheduleResult } from '../scheduler';
import type { OptimiseRequest, OptimiseResponse } from './optimiser.worker';
import OptimiserWorker from './optimiser.worker?worker&inline';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: { result: ScheduleResult | null; ms: number }) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new OptimiserWorker();
  worker.onmessage = (event: MessageEvent<OptimiseResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve({ result: msg.result, ms: msg.ms });
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(event.message || 'The optimiser stopped unexpectedly'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Runs the optimiser in the background. `result` is null when it couldn't improve on a valid plan. */
export function runOptimiser(input: ScheduleInput, maxNodes?: number): Promise<{ result: ScheduleResult | null; ms: number }> {
  const id = ++nextId;
  const wasmUrl = new URL('highs.wasm', document.baseURI).href;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, input, wasmUrl, maxNodes } satisfies OptimiseRequest);
  });
}
