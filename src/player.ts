import { setup, assign, type ActorRefFrom } from "xstate";
import { editorMachine } from "./machine";

// One entry per event sent to the live editor, timestamped relative to the
// moment recording started. This is the "tape" the timeline scrubs through.
export interface RecordedEvent {
  atMs: number;
  event: Parameters<ActorRefFrom<typeof editorMachine>["send"]>[0];
}

interface PlayerContext {
  recording: RecordedEvent[];
  replayActor: ActorRefFrom<typeof editorMachine>;
  cursor: number;
}

type PlayerEvent =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; cursor: number }
  | { type: "RESTART" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "RECORD_EDIT"; atMs: number; editEvent: Parameters<ActorRefFrom<typeof editorMachine>["send"]>[0] };

// Fast-forwards the replay actor to `cursor` by resetting it and replaying
// every event before that point instantly (no delays) — used by both
// scrubbing the timeline and restarting from zero.
function fastForward(context: PlayerContext, cursor: number) {
  context.replayActor.send({ type: "RESET" });
  for (let i = 0; i < cursor; i++) {
    context.replayActor.send(context.recording[i].event);
  }
}

export const playerMachine = setup({
  types: {
    context: {} as PlayerContext,
    events: {} as PlayerEvent,
    input: {} as { recording: RecordedEvent[]; replayActor: ActorRefFrom<typeof editorMachine> },
  },
  guards: {
    hasMore: ({ context }) => context.cursor < context.recording.length,
  },
  delays: {
    // The actual gap between this recorded event and the previous one — a
    // named, dynamic delay is what turns plain history replay into a
    // *timeline* replay.
    tick: ({ context }) =>
      context.cursor < context.recording.length
        ? context.recording[context.cursor].atMs - (context.recording[context.cursor - 1]?.atMs ?? 0)
        : 0,
  },
  actions: {
    // Sends the event *and* advances the cursor in one step, so the delay
    // computed for the next tick is always based on the up-to-date cursor.
    playNext: assign(({ context }) => {
      context.replayActor.send(context.recording[context.cursor].event);
      return { cursor: context.cursor + 1 };
    }),
    seek: assign(({ context, event }) => {
      if (event.type !== "SEEK") return {};
      fastForward(context, event.cursor);
      return { cursor: event.cursor };
    }),
    restart: assign(({ context }) => {
      fastForward(context, 0);
      return { cursor: 0 };
    }),
    recordEdit: assign(({ context, event }) => {
      if (event.type !== "RECORD_EDIT") return {};
      const nextRecording = context.recording.slice(0, context.cursor);
      const recordedEvent = {
        atMs: event.atMs,
        event: event.editEvent,
      };
      const updatedRecording = [...nextRecording, recordedEvent];
      context.replayActor.send(event.editEvent);
      return {
        recording: updatedRecording,
        cursor: updatedRecording.length,
      };
    }),
  },
}).createMachine({
  id: "player",
  context: ({ input }) => ({ recording: input.recording, replayActor: input.replayActor, cursor: 0 }),
  initial: "paused",
  states: {
    paused: {
      on: {
        PLAY: { guard: "hasMore", target: "playing" },
        START_RECORDING: { target: "recording" },
        SEEK: { actions: "seek" },
        RESTART: { actions: "restart" },
      },
    },
    recording: {
      on: {
        STOP_RECORDING: { target: "paused" },
        RECORD_EDIT: { actions: "recordEdit" },
        SEEK: { actions: "seek", target: "paused" },
        PLAY: { guard: "hasMore", target: "playing" },
        RESTART: { actions: "restart", target: "paused" },
      },
    },
    playing: {
      after: {
        tick: [
          { guard: "hasMore", actions: "playNext", target: "playing", reenter: true },
          { target: "done" },
        ],
      },
      on: {
        PAUSE: { target: "paused" },
        SEEK: { actions: "seek", target: "paused" },
        RESTART: { actions: "restart", target: "paused" },
      },
    },
    done: {
      on: {
        SEEK: { actions: "seek", target: "paused" },
        RESTART: { actions: "restart", target: "paused" },
        START_RECORDING: { target: "recording" },
      },
    },
  },
});
