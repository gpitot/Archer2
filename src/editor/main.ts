/** Map editor entry point (editor.html — dev only, never in the game build). */
import { EditorApp } from './EditorApp';

async function boot(): Promise<void> {
  const app = new EditorApp();
  (window as unknown as { __editor: EditorApp }).__editor = app;
  await app.start();
}

boot().catch((err) => {
  console.error('failed to start editor:', err);
  const el = document.createElement('pre');
  el.style.cssText = 'color:#f66;padding:20px;white-space:pre-wrap';
  el.textContent = `failed to start editor:\n${err?.stack ?? err}`;
  document.body.appendChild(el);
});
