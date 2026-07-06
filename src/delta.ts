// A "delta" describes one edit as a single replace op: remove a run of
// characters at `pos` and insert another run in its place. Every keystroke
// (or paste, or cut) collapses to one of these no matter how much text moved.
export interface Delta {
  pos: number;
  removed: string;
  inserted: string;
}

// Diff two full-text snapshots into the smallest delta that turns one into
// the other, by trimming the shared prefix and shared suffix.
export function diffText(oldText: string, newText: string): Delta {
  const maxPrefix = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < maxPrefix && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return {
    pos: start,
    removed: oldText.slice(start, oldEnd),
    inserted: newText.slice(start, newEnd),
  };
}

export function applyDelta(text: string, delta: Delta): string {
  return (
    text.slice(0, delta.pos) +
    delta.inserted +
    text.slice(delta.pos + delta.removed.length)
  );
}

// Swapping removed/inserted turns "do" into "undo": applying the inverse to
// the post-edit text reproduces the pre-edit text.
export function invertDelta(delta: Delta): Delta {
  return { pos: delta.pos, removed: delta.inserted, inserted: delta.removed };
}
