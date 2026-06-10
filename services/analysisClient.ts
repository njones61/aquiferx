/**
 * Client wrapper for the analysis Web Worker. Each run gets its own worker;
 * cancel() terminates it immediately (no cooperative checks needed) and
 * rejects the run promise with PipelineCancelledError so callers can treat
 * it as a quiet abort. Falls back to the main-thread pipeline (with
 * cooperative cancellation) if worker construction fails.
 */
import { RasterAnalysisResult, ImputationModelResult } from '../types';
import { runRasterAnalysis } from './rasterAnalysis';
import { runImputationPipeline } from './imputationPipeline';
import { PipelineCancelledError } from './pipelineCancel';
import type { AnalysisJob, RasterJobArgs, ImputationJobArgs } from '../workers/analysisWorker';

export interface AnalysisRun<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('../workers/analysisWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('Analysis worker unavailable — running on the main thread:', err);
    return null;
  }
}

function runJob<T>(
  job: AnalysisJob,
  worker: Worker,
  onProgress: (step: string, pct: number) => void,
  onLog?: (msg: string) => void,
): AnalysisRun<T> {
  let settled = false;
  let rejectFn!: (err: unknown) => void;

  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<any>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.step, msg.pct);
      } else if (msg.type === 'log') {
        onLog?.(msg.msg);
      } else if (msg.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(msg.result as T);
      } else if (msg.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker crashed'));
    };
    worker.postMessage(job);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectFn(new PipelineCancelledError());
    },
  };
}

export function startRasterAnalysis(
  args: RasterJobArgs,
  onProgress: (step: string, pct: number) => void,
): AnalysisRun<RasterAnalysisResult> {
  const worker = createWorker();
  if (!worker) {
    let cancelled = false;
    return {
      promise: runRasterAnalysis(
        args.input, args.dataType, args.aquifer, args.region, args.wells, args.measurements,
        onProgress, () => cancelled
      ),
      cancel: () => { cancelled = true; },
    };
  }
  return runJob<RasterAnalysisResult>({ kind: 'raster', args }, worker, onProgress);
}

export function startImputation(
  args: ImputationJobArgs,
  onLog: (msg: string) => void,
  onProgress: (step: string, pct: number) => void,
): AnalysisRun<ImputationModelResult> {
  const worker = createWorker();
  if (!worker) {
    let cancelled = false;
    return {
      promise: runImputationPipeline(
        args.input, args.aquifer, args.region, args.wells, args.measurements,
        onLog, onProgress, () => cancelled
      ),
      cancel: () => { cancelled = true; },
    };
  }
  return runJob<ImputationModelResult>({ kind: 'imputation', args }, worker, onProgress, onLog);
}
