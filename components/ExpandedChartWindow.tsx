import React, { useRef, useEffect } from 'react';
import { X, Activity } from 'lucide-react';

// --- Draggable / resizable floating window for expanded chart ---
const MIN_WIN_W = 480;
const MIN_WIN_H = 320;

const ExpandedChartWindow: React.FC<{
  onClose: () => void;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}> = ({ onClose, title, subtitle, children }) => {
  const winRef = useRef<HTMLDivElement>(null);

  // Active drag teardown — without this, unmounting mid-drag (e.g. Escape
  // closes the window) leaks the window listeners, which keep mutating a
  // detached node
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Initialise centered at 80% viewport
  const initRect = useRef({
    x: Math.round(window.innerWidth * 0.1),
    y: Math.round(window.innerHeight * 0.05),
    w: Math.round(window.innerWidth * 0.8),
    h: Math.round(window.innerHeight * 0.85),
  });

  // --- Title-bar drag to move ---
  const handleTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = winRef.current;
    if (!el) return;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = el.offsetLeft, startTop = el.offsetTop;

    const onMove = (me: MouseEvent) => {
      const nx = Math.max(0, Math.min(window.innerWidth - 100, startLeft + me.clientX - startX));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, startTop + me.clientY - startY));
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = cleanup;
  };

  // --- Corner / edge resize ---
  const handleResizeMouseDown = (e: React.MouseEvent, edgeX: -1 | 0 | 1, edgeY: -1 | 0 | 1) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = winRef.current;
    if (!el) return;
    const startMX = e.clientX, startMY = e.clientY;
    const startL = el.offsetLeft, startT = el.offsetTop, startW = el.offsetWidth, startH = el.offsetHeight;

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startMX, dy = me.clientY - startMY;
      let newL = startL, newT = startT, newW = startW, newH = startH;

      if (edgeX === 1) newW = Math.max(MIN_WIN_W, startW + dx);
      if (edgeX === -1) { newW = Math.max(MIN_WIN_W, startW - dx); newL = startL + startW - newW; }
      if (edgeY === 1) newH = Math.max(MIN_WIN_H, startH + dy);
      if (edgeY === -1) { newH = Math.max(MIN_WIN_H, startH - dy); newT = startT + startH - newH; }

      el.style.left = `${newL}px`;
      el.style.top = `${newT}px`;
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = cleanup;
  };

  const r = initRect.current;
  return (
    <div
      ref={winRef}
      className="fixed z-[100] bg-white rounded-lg shadow-2xl border border-slate-300 flex flex-col overflow-hidden"
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
    >
      {/* Title bar — drag to move */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-slate-50 cursor-move select-none flex-shrink-0"
        onMouseDown={handleTitleMouseDown}
      >
        <div className="flex items-center space-x-3 min-w-0">
          <Activity size={16} className="text-blue-500 flex-shrink-0" />
          <span className="font-semibold text-sm text-slate-800 truncate">{title}</span>
          <span className="text-[11px] text-slate-400 flex-shrink-0">{subtitle}</span>
        </div>
        <button
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors flex-shrink-0"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Chart body */}
      <div className="flex-1 min-h-0 p-3">
        {children}
      </div>

      {/* Resize handles (edges + corners) */}
      {/* right */}
      <div className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize" onMouseDown={e => handleResizeMouseDown(e, 1, 0)} />
      {/* bottom */}
      <div className="absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize" onMouseDown={e => handleResizeMouseDown(e, 0, 1)} />
      {/* left */}
      <div className="absolute top-0 left-0 w-1.5 h-full cursor-ew-resize" onMouseDown={e => handleResizeMouseDown(e, -1, 0)} />
      {/* top */}
      <div className="absolute top-0 left-0 h-1.5 w-full cursor-ns-resize" onMouseDown={e => handleResizeMouseDown(e, 0, -1)} />
      {/* bottom-right corner */}
      <div className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize" onMouseDown={e => handleResizeMouseDown(e, 1, 1)} />
      {/* bottom-left corner */}
      <div className="absolute bottom-0 left-0 w-3 h-3 cursor-nesw-resize" onMouseDown={e => handleResizeMouseDown(e, -1, 1)} />
      {/* top-right corner */}
      <div className="absolute top-0 right-0 w-3 h-3 cursor-nesw-resize" onMouseDown={e => handleResizeMouseDown(e, 1, -1)} />
      {/* top-left corner */}
      <div className="absolute top-0 left-0 w-3 h-3 cursor-nwse-resize" onMouseDown={e => handleResizeMouseDown(e, -1, -1)} />
    </div>
  );
};

export default ExpandedChartWindow;
