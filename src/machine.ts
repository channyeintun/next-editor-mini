import { setup, assign } from "xstate";
import { applyDelta, invertDelta, type Delta } from "./delta";

interface EditorContext {
  text: string;
  history: Delta[];
  future: Delta[];
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
}

type EditorEvent =
  | { type: "EDIT"; delta: Delta }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET" }
  | { type: "SELECTION"; selectionStart: number; selectionEnd: number; selectionDirection: "forward" | "backward" | "none" };

export const editorMachine = setup({
  types: {
    context: {} as EditorContext,
    events: {} as EditorEvent,
  },
  guards: {
    isEmpty: ({ context }) => context.text.length === 0,
    hasHistory: ({ context }) => context.history.length > 0,
    hasFuture: ({ context }) => context.future.length > 0,
  },
  actions: {
    applyEdit: assign(({ context, event }) => {
      if (event.type !== "EDIT") return {};
      return {
        text: applyDelta(context.text, event.delta),
        history: [...context.history, event.delta],
        future: [], // a fresh edit invalidates any redo stack
      };
    }),
    undo: assign(({ context }) => {
      const delta = context.history.at(-1);
      if (!delta) return {};
      return {
        text: applyDelta(context.text, invertDelta(delta)),
        history: context.history.slice(0, -1),
        future: [...context.future, delta],
      };
    }),
    redo: assign(({ context }) => {
      const delta = context.future.at(-1);
      if (!delta) return {};
      return {
        text: applyDelta(context.text, delta),
        history: [...context.history, delta],
        future: context.future.slice(0, -1),
      };
    }),
    applySelection: assign(({ event }) => {
      if (event.type !== "SELECTION") return {};
      return {
        selectionStart: event.selectionStart,
        selectionEnd: event.selectionEnd,
        selectionDirection: event.selectionDirection,
      };
    }),
  },
}).createMachine({
  id: "editor",
  context: { text: "", history: [], future: [], selectionStart: 0, selectionEnd: 0, selectionDirection: "none" as const },
  initial: "idle",
  // Inherited by every child state below, so replay can reset either actor
  // (live or the one driven by the timeline) from wherever it currently is.
  on: {
    RESET: { target: ".idle", actions: assign({ text: "", history: [], future: [], selectionStart: 0, selectionEnd: 0, selectionDirection: "none" as const }) },
  },
  states: {
    idle: {
      on: {
        EDIT: { target: "dirty", actions: "applyEdit" },
        REDO: { target: "dirty", guard: "hasFuture", actions: "redo" },
        SELECTION: { actions: "applySelection" },
      },
    },
    dirty: {
      on: {
        EDIT: { actions: "applyEdit" },
        UNDO: { guard: "hasHistory", actions: "undo" },
        REDO: { guard: "hasFuture", actions: "redo" },
        SELECTION: { actions: "applySelection" },
      },
      always: { target: "idle", guard: "isEmpty" },
    },
  },
});
