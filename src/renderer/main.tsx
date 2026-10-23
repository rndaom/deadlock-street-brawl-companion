import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Overlay } from './Overlay';
import { createBrowserBridge } from '../app/browser-bridge';
import type { CompanionBridge } from '../shared/types';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application mount is missing.');
const params = new URLSearchParams(window.location.search);
// The same document draws the in-game overlay (a transparent window over Deadlock) when asked to.
const overlay = params.get('view') === 'overlay';
if (overlay) document.documentElement.classList.add('overlay-mode');
const mount = (bridge: CompanionBridge) => createRoot(root).render(<StrictMode>{overlay ? <Overlay bridge={bridge} /> : <App bridge={bridge} />}</StrictMode>);

// Development preview with sample reader states (?sample=pick); removed from production builds.
const sample = import.meta.env.DEV ? params.get('sample') : null;
if (import.meta.env.DEV && sample) void import('../app/preview-bridge').then(({ createPreviewBridge }) => mount(createPreviewBridge(sample, params.has('panel'))));
else mount(window.companion ?? createBrowserBridge());
