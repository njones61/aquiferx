/**
 * Web Worker host for the heavy analysis pipelines. Running them here keeps
 * kriging/IDW/ELM compute off the main thread entirely, and makes
 * cancellation a worker.terminate() instead of cooperative checks.
 *
 * Protocol: one job per worker instance.
 *   in:  { kind: 'raster' | 'imputation', args: {...} }
 *   out: { type: 'progress', step, pct }
 *        { type: 'log', msg }            (imputation only)
 *        { type: 'done', result }
 *        { type: 'error', message }
 */
import { runRasterAnalysis, RasterPipelineInput } from '../services/rasterAnalysis';
import { runImputationPipeline, ImputationPipelineInput } from '../services/imputationPipeline';
import { Aquifer, Region, Well, Measurement } from '../types';

export interface RasterJobArgs {
  input: RasterPipelineInput;
  dataType: string;
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
}

export interface ImputationJobArgs {
  input: ImputationPipelineInput;
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
}

export type AnalysisJob =
  | { kind: 'raster'; args: RasterJobArgs }
  | { kind: 'imputation'; args: ImputationJobArgs };

self.onmessage = async (e: MessageEvent<AnalysisJob>) => {
  const job = e.data;
  const post = (msg: object) => (self as unknown as Worker).postMessage(msg);
  try {
    if (job.kind === 'raster') {
      const { input, dataType, aquifer, region, wells, measurements } = job.args;
      const result = await runRasterAnalysis(
        input, dataType, aquifer, region, wells, measurements,
        (step, pct) => post({ type: 'progress', step, pct })
      );
      post({ type: 'done', result });
    } else {
      const { input, aquifer, region, wells, measurements } = job.args;
      const result = await runImputationPipeline(
        input, aquifer, region, wells, measurements,
        (msg) => post({ type: 'log', msg }),
        (step, pct) => post({ type: 'progress', step, pct })
      );
      post({ type: 'done', result });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
