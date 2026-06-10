
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { RasterFrameProvider } from './contexts/RasterFrameContext';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {/* Above App so 500ms playback frame updates bypass the App tree */}
    <RasterFrameProvider>
      <App />
    </RasterFrameProvider>
  </React.StrictMode>
);
