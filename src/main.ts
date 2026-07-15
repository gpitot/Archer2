import { Game } from './core/Game';

const game = new Game();
game.init().catch((err) => {
  console.error('failed to start game:', err);
  const el = document.createElement('pre');
  el.style.cssText = 'color:#f66;padding:16px;font-size:14px;';
  el.textContent = `Failed to start: ${err?.message ?? err}`;
  document.body.appendChild(el);
});
