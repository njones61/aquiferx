
import React, { useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea 
} from 'recharts';
import { Measurement, ChartPoint } from '../types';
import { interpolatePCHIP } from '../utils/interpolation';

interface TimeSeriesChartProps {
  measurements: Measurement[];
  wellName: string;
}

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({ measurements }) => {
  const chartData = useMemo(() => {
    if (measurements.length === 0) return [];

    // Sort by date, filtering out invalid dates
    const sorted = [...measurements]
      .filter(m => !isNaN(new Date(m.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (sorted.length === 0) return [];

    const xValues = sorted.map(m => new Date(m.date).getTime());
    const yValues = sorted.map(m => m.wte);

    // If only one point, just return it
    if (sorted.length === 1) {
      return [{
        date: xValues[0],
        wte: yValues[0],
        isInterpolated: false
      }];
    }

    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const range = maxX - minX;

    // If range is 0, just return the points
    if (range === 0) {
      return sorted.map(m => ({
        date: new Date(m.date).getTime(),
        wte: m.wte,
        isInterpolated: false
      }));
    }

    const step = range / 100; // 100 interpolation points

    const targetX: number[] = [];
    for (let x = minX; x <= maxX; x += step) {
      targetX.push(x);
    }

    const interpolatedY = interpolatePCHIP(xValues, yValues, targetX);

    // Combine for charting - keep full precision
    const points: ChartPoint[] = targetX.map((tx, i) => ({
      date: tx,
      wte: interpolatedY[i],
      isInterpolated: !xValues.includes(tx)
    }));

    // Add actual measurement markers explicitly for better precision in the chart
    sorted.forEach(m => {
      points.push({
        date: new Date(m.date).getTime(),
        wte: m.wte,
        isInterpolated: false
      });
    });

    return points.sort((a, b) => a.date - b.date);
  }, [measurements]);

  if (measurements.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
        No measurement data available for this well.
      </div>
    );
  }

  const formatXAxis = (tickItem: number) => {
    const d = new Date(tickItem);
    return `${d.getMonth() + 1}/${d.getFullYear()}`;
  };

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis 
            dataKey="date" 
            type="number" 
            domain={['auto', 'auto']}
            tickFormatter={formatXAxis}
            stroke="#94a3b8"
            fontSize={11}
          />
          <YAxis 
            domain={['auto', 'auto']}
            stroke="#94a3b8"
            fontSize={11}
            tickFormatter={(val) => val.toLocaleString()}
          />
          <Tooltip 
            labelFormatter={(label) => new Date(label).toLocaleDateString()}
            formatter={(value: number) => [`${value} ft`, 'Elevation']}
            contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
          />
          {/* Main Interpolated Line - use linear since we already did PCHIP interpolation */}
          <Line
            type="linear"
            dataKey="wte"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            animationDuration={400}
            activeDot={{ r: 6, strokeWidth: 0 }}
          />
          {/* Discrete points for actual measurements */}
          <Line
            type="linear"
            dataKey="wte"
            stroke="transparent"
            animationDuration={400}
            dot={(props) => {
              const { cx, cy, payload } = props;
              if (payload.isInterpolated) return null;
              return (
                <circle key={payload.date} cx={cx} cy={cy} r={4} fill="#1d4ed8" stroke="#fff" strokeWidth={2} />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TimeSeriesChart;
