/**
 * Generic keyed-view diff loop. Replaces the duplicated "create on new state,
 * sync active, dispose removed" pattern repeated across projectiles, wards,
 * blasts, creeps, and runes.
 *
 * Scout vision-adapter bookkeeping moves into the `create` / `dispose`
 * callbacks — the loop itself has no knowledge of fog or scouts.
 */

/**
 * Sync a `Map<K,V>` of views against a set of active keys derived from
 * simulation state.
 *
 * - For each key in `activeKeys` not yet in `views`, calls `create(key)`
 *   and inserts the result into the map.
 * - For each key currently in `views`, calls `sync(key, view)`.
 * - For each key in `views` that is NOT in `activeKeys`, calls
 *   `dispose(key, view)` (if provided) and removes it.
 *
 * `activeKeys` is typically a `Set<string>` built from the relevant state
 * array for one tick.
 */
export function syncKeyedViews<K, V>(
  views: Map<K, V>,
  activeKeys: Set<K>,
  create: (key: K) => V,
  sync: (key: K, view: V) => void,
  dispose?: (key: K, view: V) => void,
): void {
  // Create views for new entities
  for (const key of activeKeys) {
    if (!views.has(key)) {
      views.set(key, create(key));
    }
  }

  // Sync or remove each view
  for (const [key, view] of views) {
    if (activeKeys.has(key)) {
      sync(key, view);
    } else {
      if (dispose) dispose(key, view);
      views.delete(key);
    }
  }
}

/**
 * Like `syncKeyedViews`, but for views whose keys are stable for the entire
 * match (creeps, runes). Creates once and never disposes — death/respawn is
 * just a visibility toggle inside `sync`.
 */
export function syncStableViews<K, V, S>(
  views: Map<K, V>,
  states: readonly S[],
  getKey: (state: S) => K,
  create: (state: S) => V,
  sync: (state: S, view: V) => void,
): void {
  for (const state of states) {
    const key = getKey(state);
    let view = views.get(key);
    if (!view) {
      view = create(state);
      views.set(key, view);
    }
    sync(state, view);
  }
}
