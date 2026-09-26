/** TRACEFORGE_DEBUG=1 turns on extra diagnostics (the inference runtime's own logs, the shape of model responses). */
export function debugEnabled(): boolean {
  const v = process.env.TRACEFORGE_DEBUG?.trim().toLowerCase();
  return !!v && v !== "0" && v !== "false" && v !== "off";
}
