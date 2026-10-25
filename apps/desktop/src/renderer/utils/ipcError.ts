// What Electron does to an error thrown in a main-process handler: the renderer's promise rejects
// with "Error invoking remote method 'erp:create-party': LeaseError: <the message>". The operator
// should read only <the message> -- the main process already wrote it for them.

const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

/** The handler's own message, without Electron's wrapping. Anything else comes back unchanged. */
export const withoutIpcPrefix = (message: string): string => message.replace(REMOTE_PREFIX, "");
