function normalize(value) {
  return value.trim().toLowerCase();
}

function rank(note, term) {
  const title = normalize(note.title);
  if (title === term) return 3;
  if (title.startsWith(term)) return 2;
  if (title.includes(term)) return 1;
  if (note.tags.some((tag) => normalize(tag).includes(term))) return 0;
  return -1;
}

// Returns matching notes in ranked order; never modifies the supplied notes.
export function searchNotes(notes, query) {
  const term = normalize(query);
  if (term.length === 0) return [];

  return notes
    .map((note) => ({ note, score: rank(note, term) }))
    .filter(({ score }) => score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.note.title.localeCompare(right.note.title),
    )
    .map(({ note }) => note);
}
