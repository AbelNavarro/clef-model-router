// The values clef-model-router keeps in `$.state` for a session.

/** The session's routing state as JSON: mode, pin, last route, cache, history. */
export type ClefRouterSnapshot = string

declare module 'claude-code' {
  interface PluginState {
    'clef-model-router': {
      session: ClefRouterSnapshot
    }
  }
}
