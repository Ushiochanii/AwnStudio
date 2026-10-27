// Bounded undo / redo of opaque snapshots.
export function createHistory({limit = 100} = {}) {
  const past = [];
  const future = [];
  const push = (stack, item) => {
    stack.push(item);
    if (stack.length > limit) stack.shift();
  };
  return {
    checkpoint(snapshot) {
      push(past, snapshot);
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      push(future, current);
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      push(past, current);
      return future.pop();
    },
    clear() {
      past.length = future.length = 0;
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get sizes() { return {past: past.length, future: future.length}; }
  };
}
