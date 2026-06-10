import React, { createContext, useContext, useState } from 'react';

/**
 * Raster playback frame state, isolated from App. During playback
 * RasterOverlay publishes a new frame every 500ms — when App owned this
 * state, every tick re-rendered the entire tree (header, sidebar, map
 * props, dialogs). With the provider above App and split value/setter
 * contexts, only the components that actually display the frame
 * re-render.
 */
export interface RasterFrameDate {
  date: string;
  dateTs: number;
}

interface FrameSetters {
  set: (date: string, dateTs: number) => void;
  clear: () => void;
}

const FrameValueContext = createContext<RasterFrameDate | null>(null);
const FrameSetterContext = createContext<FrameSetters>({ set: () => {}, clear: () => {} });

export const RasterFrameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [frame, setFrame] = useState<RasterFrameDate | null>(null);
  const [setters] = useState<FrameSetters>(() => ({
    set: (date: string, dateTs: number) =>
      setFrame(prev => (prev && prev.date === date && prev.dateTs === dateTs ? prev : { date, dateTs })),
    clear: () => setFrame(null),
  }));
  return (
    <FrameSetterContext.Provider value={setters}>
      <FrameValueContext.Provider value={frame}>
        {children}
      </FrameValueContext.Provider>
    </FrameSetterContext.Provider>
  );
};

export const useRasterFrame = () => useContext(FrameValueContext);
// The setters' identity is stable, so subscribing to them does not
// re-render the subscriber on frame changes
export const useRasterFrameSetter = () => useContext(FrameSetterContext);

/** Render-prop consumer: lets a small slice of JSX track the playback
 *  frame without re-rendering the component that owns the JSX. */
export const RasterFrame: React.FC<{ children: (frame: RasterFrameDate | null) => React.ReactNode }> = ({ children }) => {
  const frame = useRasterFrame();
  return <>{children(frame)}</>;
};
