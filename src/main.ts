import { createActor } from "xstate";
import { editorMachine } from "./machine";
import { playerMachine, type RecordedEvent } from "./player";
import { diffText } from "./delta";

const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const stateEl = document.querySelector<HTMLSpanElement>("#state")!;
const logEl = document.querySelector<HTMLDivElement>("#log")!;
const undoBtn = document.querySelector<HTMLButtonElement>("#undo")!;
const redoBtn = document.querySelector<HTMLButtonElement>("#redo")!;

const timelineEl = document.querySelector<HTMLInputElement>("#timeline")!;
const playBtn = document.querySelector<HTMLButtonElement>("#play")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;
const recordBtn = document.querySelector<HTMLButtonElement>("#record")!;
const playerStateEl = document.querySelector<HTMLSpanElement>("#player-state")!;
const caretEl = document.querySelector<HTMLDivElement>("#fake-caret")!;
const selectionOverlayEl = document.querySelector<HTMLDivElement>("#selection-overlay")!;

// --- Unified Editor Flow ---

const editorActor = createActor(editorMachine);

let recordingStart: number | null = null;
const recording: RecordedEvent[] = [];

// Create the player machine, driving the single editor actor
const player = createActor(playerMachine, { input: { recording, replayActor: editorActor } });

// Hook up typing to record edits via the player
editorEl.addEventListener("input", () => {
  if (player.getSnapshot().value !== "recording") return;
  const { text } = editorActor.getSnapshot().context;
  const delta = diffText(text, editorEl.value);
  const editEvent = { type: "EDIT" as const, delta };
  const atMs = recordingStart ? Date.now() - recordingStart : 0;
  player.send({ type: "RECORD_EDIT", atMs, editEvent });
});

// Record selection changes on the textarea
editorEl.addEventListener("selectionchange", () => {
  if (player.getSnapshot().value !== "recording") return;

  const selectionStart = editorEl.selectionStart;
  const selectionEnd = editorEl.selectionEnd;
  const selectionDirection = editorEl.selectionDirection as "forward" | "backward" | "none";

  // Check if selection actually changed from what's recorded
  const { selectionStart: prevStart, selectionEnd: prevEnd, selectionDirection: prevDir } = editorActor.getSnapshot().context;
  if (selectionStart === prevStart && selectionEnd === prevEnd && selectionDirection === prevDir) return;

  const selEvent = { type: "SELECTION" as const, selectionStart, selectionEnd, selectionDirection };
  const atMs = recordingStart ? Date.now() - recordingStart : 0;
  player.send({ type: "RECORD_EDIT", atMs, editEvent: selEvent });
});

// Map Undo and Redo buttons to Player seeking
undoBtn.addEventListener("click", () => {
  const { cursor } = player.getSnapshot().context;
  if (cursor > 0) {
    player.send({ type: "SEEK", cursor: cursor - 1 });
  }
});

redoBtn.addEventListener("click", () => {
  const { cursor, recording } = player.getSnapshot().context;
  if (cursor < recording.length) {
    player.send({ type: "SEEK", cursor: cursor + 1 });
  }
});

// Subscribe to editor actor state changes
editorActor.subscribe((snapshot) => {
  const { text } = snapshot.context;
  if (editorEl.value !== text) {
    editorEl.value = text;
  }
  stateEl.textContent = String(snapshot.value);
});

editorActor.start();

// Subscribe to player state changes
player.subscribe((snapshot) => {
  const { cursor, recording } = snapshot.context;
  const playerState = snapshot.value;

  // Update UI indicators
  playerStateEl.textContent = String(playerState);
  timelineEl.value = String(cursor);
  timelineEl.max = String(recording.length);

  // Play button state
  playBtn.textContent = playerState === "playing" ? "Pause" : "Play";
  playBtn.disabled = recording.length === 0 || playerState === "recording";

  // Record button state
  if (playerState === "recording") {
    recordBtn.textContent = "Stop";
    recordBtn.classList.add("is-recording");
    recordBtn.disabled = false;
  } else {
    recordBtn.textContent = "Record";
    recordBtn.classList.remove("is-recording");
    recordBtn.disabled = playerState === "playing";
  }

  // Make editor read-only unless we are explicitly recording
  editorEl.readOnly = playerState !== "recording";

  // Show fake caret during playing, or when paused/done (i.e. reviewing)
  const showCaret = playerState === "playing" || playerState === "done"
    || (playerState === "paused" && recording.length > 0 && cursor < recording.length);
  if (showCaret) {
    const { selectionStart, selectionEnd, selectionDirection } = editorActor.getSnapshot().context;
    updateFakeCaret(selectionStart, selectionEnd, selectionDirection);
  } else {
    hideFakeCaret();
  }

  // Enable/Disable undo & redo buttons
  undoBtn.disabled = cursor === 0 || playerState === "recording";
  redoBtn.disabled = cursor === recording.length || playerState === "recording";

  // Restart button disabled when recording
  restartBtn.disabled = playerState === "recording";

  // Timeline slider disabled when recording
  timelineEl.disabled = playerState === "recording";

  // Render high-density delta log
  updateDeltaLog(recording, cursor);
});

player.start();

// Handle manual seek from timeline slider
timelineEl.addEventListener("input", () => {
  player.send({ type: "SEEK", cursor: Number(timelineEl.value) });
});

// Play/Pause button
playBtn.addEventListener("click", () => {
  const isPlaying = player.getSnapshot().value === "playing";
  player.send({ type: isPlaying ? "PAUSE" : "PLAY" });
});

// Restart button
restartBtn.addEventListener("click", () => {
  player.send({ type: "RESTART" });
});

// Record button
recordBtn.addEventListener("click", () => {
  const playerState = player.getSnapshot().value;
  if (playerState === "recording") {
    player.send({ type: "STOP_RECORDING" });
  } else {
    const { cursor, recording } = player.getSnapshot().context;
    const elapsed = cursor > 0 && recording[cursor - 1] ? recording[cursor - 1].atMs : 0;
    recordingStart = Date.now() - elapsed;
    player.send({ type: "START_RECORDING" });
    // Focus the textarea so the user can immediately type
    editorEl.focus();
  }
});

// --- Formatting Helpers ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\n/g, "↵");
}

function updateDeltaLog(recording: RecordedEvent[], cursor: number) {
  logEl.innerHTML = "";
  if (recording.length === 0) {
    logEl.innerHTML = `<div class="log-empty">No edits logged. Start typing!</div>`;
    return;
  }

  recording.forEach((item, index) => {
    const isPast = index < cursor;
    const isCurrent = index === cursor - 1;

    const row = document.createElement("div");
    row.className = `log-row ${isPast ? "is-past" : "is-future"} ${isCurrent ? "is-current" : ""}`;

    let diffHtml = "";
    let posHtml = "";

    if (item.event.type === "SELECTION") {
      const e = item.event;
      const hasRange = e.selectionStart !== e.selectionEnd;
      const dirArrow = e.selectionDirection === "backward" ? "◁" : e.selectionDirection === "forward" ? "▷" : "";
      diffHtml = `<span class="diff-tag sel">▎</span><span class="diff-content">${hasRange ? `${e.selectionStart}–${e.selectionEnd}` : String(e.selectionStart)}${dirArrow ? " " + dirArrow : ""}</span>`;
      posHtml = `<span class="log-pos">▎</span>`;
    } else if (item.event.type === "EDIT") {
      const d = item.event.delta;
      if (d.removed && d.inserted) {
        diffHtml = `<span class="diff-tag mod">~</span><span class="diff-content"><del>${escapeHtml(d.removed)}</del><ins>${escapeHtml(d.inserted)}</ins></span>`;
      } else if (d.inserted) {
        diffHtml = `<span class="diff-tag add">+</span><span class="diff-content"><ins>${escapeHtml(d.inserted)}</ins></span>`;
      } else if (d.removed) {
        diffHtml = `<span class="diff-tag del">-</span><span class="diff-content"><del>${escapeHtml(d.removed)}</del></span>`;
      } else {
        diffHtml = `<span class="diff-tag empty">ø</span><span class="diff-content">no-op</span>`;
      }
      posHtml = `<span class="log-pos">@${d.pos}</span>`;
    }

    row.innerHTML = `
      <span class="log-index">#${index}</span>
      ${posHtml}
      <span class="log-diff">${diffHtml}</span>
      <span class="log-time">${(item.atMs / 1000).toFixed(1)}s</span>
    `;

    // Click to seek to that event's state
    row.addEventListener("click", () => {
      player.send({ type: "SEEK", cursor: index + 1 });
    });

    logEl.appendChild(row);
  });

  // Keep the current active event visible
  const activeRow = logEl.querySelector(".is-current");
  if (activeRow) {
    activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// --- Fake Caret & Selection Overlay ---

// Compute the pixel (x, y) position of a character offset inside the textarea.
// Uses a hidden mirror div to measure text layout.
function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const mirror = document.createElement("div");
  const style = getComputedStyle(textarea);

  // Copy all relevant styles to the mirror
  const props = [
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "wordSpacing", "textIndent", "textTransform",
    "overflowWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "boxSizing", "tabSize",
  ] as const;
  props.forEach((p) => {
    mirror.style[p as any] = style[p as any];
  });

  // Textareas always render with pre-wrap + break-word
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";

  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.width = textarea.clientWidth + "px";
  mirror.style.height = "auto";

  const textBefore = textarea.value.substring(0, position);
  const textNode = document.createTextNode(textBefore);
  mirror.appendChild(textNode);

  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // zero-width space
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const markerRect = marker.offsetTop;
  const markerLeft = marker.offsetLeft;

  const coords = {
    top: markerRect - textarea.scrollTop,
    left: markerLeft - textarea.scrollLeft,
  };

  document.body.removeChild(mirror);
  return coords;
}

function updateFakeCaret(
  selectionStart: number,
  selectionEnd: number,
  selectionDirection: "forward" | "backward" | "none",
) {
  const hasSelection = selectionStart !== selectionEnd;

  // Determine caret position based on selectionDirection
  let caretPos: number;
  if (!hasSelection) {
    caretPos = selectionStart;
  } else if (selectionDirection === "backward") {
    caretPos = selectionStart;
  } else {
    // forward or none — caret at end
    caretPos = selectionEnd;
  }

  const coords = getCaretCoordinates(editorEl, caretPos);
  const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 18;

  caretEl.style.top = coords.top + "px";
  caretEl.style.left = coords.left + "px";
  caretEl.style.height = lineHeight + "px";
  caretEl.style.display = "block";

  // Render selection highlight if there's a range
  if (hasSelection) {
    renderSelectionOverlay(selectionStart, selectionEnd);
  } else {
    selectionOverlayEl.innerHTML = "";
    selectionOverlayEl.style.display = "none";
  }
}

function renderSelectionOverlay(start: number, end: number) {
  selectionOverlayEl.innerHTML = "";
  selectionOverlayEl.style.display = "block";

  const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 18;
  const startCoords = getCaretCoordinates(editorEl, start);
  const endCoords = getCaretCoordinates(editorEl, end);

  if (startCoords.top === endCoords.top) {
    // Single line selection
    const rect = document.createElement("div");
    rect.className = "selection-rect";
    rect.style.top = startCoords.top + "px";
    rect.style.left = startCoords.left + "px";
    rect.style.width = (endCoords.left - startCoords.left) + "px";
    rect.style.height = lineHeight + "px";
    selectionOverlayEl.appendChild(rect);
  } else {
    // Multi-line selection: first line, middle lines, last line
    const textareaWidth = editorEl.clientWidth;
    const paddingLeft = parseFloat(getComputedStyle(editorEl).paddingLeft) || 0;
    const paddingRight = parseFloat(getComputedStyle(editorEl).paddingRight) || 0;
    const contentWidth = textareaWidth - paddingLeft - paddingRight;

    // First line: from start to end of line
    const firstRect = document.createElement("div");
    firstRect.className = "selection-rect";
    firstRect.style.top = startCoords.top + "px";
    firstRect.style.left = startCoords.left + "px";
    firstRect.style.width = (contentWidth - startCoords.left + paddingLeft) + "px";
    firstRect.style.height = lineHeight + "px";
    selectionOverlayEl.appendChild(firstRect);

    // Middle lines (full width)
    const middleTop = startCoords.top + lineHeight;
    const middleHeight = endCoords.top - middleTop;
    if (middleHeight > 0) {
      const midRect = document.createElement("div");
      midRect.className = "selection-rect";
      midRect.style.top = middleTop + "px";
      midRect.style.left = paddingLeft + "px";
      midRect.style.width = contentWidth + "px";
      midRect.style.height = middleHeight + "px";
      selectionOverlayEl.appendChild(midRect);
    }

    // Last line: from start of line to end position
    const lastRect = document.createElement("div");
    lastRect.className = "selection-rect";
    lastRect.style.top = endCoords.top + "px";
    lastRect.style.left = paddingLeft + "px";
    lastRect.style.width = (endCoords.left - paddingLeft) + "px";
    lastRect.style.height = lineHeight + "px";
    selectionOverlayEl.appendChild(lastRect);
  }
}

function hideFakeCaret() {
  caretEl.style.display = "none";
  selectionOverlayEl.innerHTML = "";
  selectionOverlayEl.style.display = "none";
}
