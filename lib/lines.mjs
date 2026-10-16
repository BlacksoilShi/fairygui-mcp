// Bound memory BEFORE a newline arrives. Oversized lines are discarded to LF.
export function readLines(stream, {maxBytes, onLine, onOversize, onEnd}) {
  let parts = [], bytes = 0, dropping = false;
  stream.on('data', chunk => {
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== 10) continue;
      const piece = chunk.subarray(start, i);
      if (!dropping) {
        bytes += piece.length;
        if (bytes > maxBytes) {
          dropping = true; parts = []; bytes = 0; onOversize();
        } else if (piece.length) parts.push(Buffer.from(piece));
      }
      if (i < chunk.length) {
        if (!dropping) onLine(Buffer.concat(parts).toString('utf8'));
        parts = []; bytes = 0; dropping = false;
      }
      start = i + 1;
    }
  });
  stream.on('end', () => {
    if (!dropping && bytes) onLine(Buffer.concat(parts).toString('utf8'));
    parts = []; onEnd();
  });
}
