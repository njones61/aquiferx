import { Matrix, solve, CholeskyDecomposition } from 'ml-matrix';

export interface ElmModel {
  W_in: number[][];   // [inputDim x hiddenUnits]
  b: number[];         // [hiddenUnits]
  W_out: number[];     // [hiddenUnits]
}

export interface ElmTrainResult {
  model: ElmModel;
  trainPredictions: number[];  // predictions on training set (same scale as input y)
}

/**
 * Box-Muller transform for generating random normal numbers
 */
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * ReLU activation: max(0, x) applied element-wise
 */
function relu(matrix: Matrix): Matrix {
  const data = matrix.to2DArray();
  for (let i = 0; i < data.length; i++) {
    for (let j = 0; j < data[i].length; j++) {
      if (data[i][j] < 0) data[i][j] = 0;
    }
  }
  return new Matrix(data);
}

/**
 * Compute hidden layer activation: H = ReLU(X · W_in + b)
 * Matches Python: input_to_hidden(x, Win, b) → np.maximum(np.dot(x, Win) + b, 0)
 */
function computeHidden(X: Matrix, W_in: Matrix, b: number[]): Matrix {
  const H = X.mmul(W_in);
  for (let i = 0; i < H.rows; i++) {
    for (let j = 0; j < H.columns; j++) {
      H.set(i, j, H.get(i, j) + b[j]);
    }
  }
  return relu(H);
}

/**
 * Train an ELM on pre-normalized features and targets.
 *
 * Data should already be z-scored/normalized before calling this function,
 * matching the Python notebook's flow where zscore_training_data is applied
 * globally before impute_data is called.
 *
 * X: feature matrix [n x inputDim] (z-scored GLDAS + year + month + bias)
 * y: target values (z-scored)
 *
 * Matches Python:
 *   X = input_to_hidden(tx, W_in, b)
 *   I = np.identity(X.shape[1]); I[-1,-1]=0; I[-2,-2]=0
 *   W_out = np.linalg.lstsq(X.T.dot(X) + lamb_value * I, X.T.dot(ty))[0]
 */
export function trainElm(
  X: number[][],
  y: number[],
  hiddenUnits: number,
  lambda: number,
): ElmTrainResult {
  const n = X.length;
  const inputDim = X[0].length;

  // Generate random input weights and biases (Box-Muller)
  const W_inArr: number[][] = [];
  for (let i = 0; i < inputDim; i++) {
    const row: number[] = [];
    for (let j = 0; j < hiddenUnits; j++) {
      row.push(randn());
    }
    W_inArr.push(row);
  }
  const bArr: number[] = [];
  for (let j = 0; j < hiddenUnits; j++) {
    bArr.push(randn());
  }

  const XMat = new Matrix(X);
  const W_in = new Matrix(W_inArr);

  // Compute hidden layer: H = ReLU(X · W_in + b)
  const H = computeHidden(XMat, W_in, bArr);

  // Ridge regression: W_out = lstsq(H^T·H + λI, H^T·y)
  const HtH = H.transpose().mmul(H);

  // Build regularization matrix: λI with last 2 diagonal entries zeroed
  // Matches Python: I[-1,-1]=0; I[-2,-2]=0
  for (let i = 0; i < hiddenUnits; i++) {
    if (i < hiddenUnits - 2) {
      HtH.set(i, i, HtH.get(i, i) + lambda);
    }
  }

  const yMat = Matrix.columnVector(y);
  const HtY = H.transpose().mmul(yMat);

  // HtH + λI is symmetric positive definite for λ > 0, so Cholesky solves
  // it directly — roughly 40x faster than the SVD path for a 500x500
  // system, and unlike ml-matrix's SVD (whose convergence loop has no
  // iteration cap) it cannot spin forever on ill-conditioned input. The
  // SVD lstsq (numpy-equivalent) remains as fallback for the rare
  // non-PD case.
  let W_outArr: number[];
  const chol = new CholeskyDecomposition(HtH);
  if (chol.isPositiveDefinite()) {
    W_outArr = chol.solve(HtY).getColumn(0);
  } else {
    W_outArr = solve(HtH, HtY, true).getColumn(0);
  }

  // Compute training predictions
  const trainPredictions = H.mmul(Matrix.columnVector(W_outArr)).getColumn(0);

  return {
    model: {
      W_in: W_inArr,
      b: bArr,
      W_out: W_outArr,
    },
    trainPredictions,
  };
}

/**
 * Predict using a trained ELM model.
 * X: pre-normalized feature matrix [n x inputDim]
 * Returns raw predictions (same scale as training targets — caller must denormalize).
 *
 * Matches Python: predict(in_values, W_in, b, W_out) → np.dot(input_to_hidden(x, W_in, b), W_out)
 */
export function predictElm(model: ElmModel, X: number[][]): number[] {
  const XMat = new Matrix(X);
  const W_in = new Matrix(model.W_in);
  const H = computeHidden(XMat, W_in, model.b);
  return H.mmul(Matrix.columnVector(model.W_out)).getColumn(0);
}
