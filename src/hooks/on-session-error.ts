import { handleSessionError } from './handlers.js';
import { runHookHandler } from './runner.js';

void runHookHandler('on-session-error', handleSessionError);
