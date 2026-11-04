/** Logs what the browser isn't told: the event and its details, never a request's cookie, body or credential. */
export const log = (event: string, details: Record<string, unknown>) => console.error(JSON.stringify({ event, ...details }));

/** A platform failure's details for the log, never for the browser. */
export const failure = (answer: { kind: string; status?: number; httpStatus?: number; error?: string }) =>
  ({ kind: answer.kind, ...(answer.status !== undefined && { status: answer.status }), ...(answer.httpStatus !== undefined && { httpStatus: answer.httpStatus }),
    ...(answer.error !== undefined && { error: answer.error }) });
