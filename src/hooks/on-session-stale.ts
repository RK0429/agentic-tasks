import { handleSessionStale } from './handlers.js';
import { runHookHandler } from './runner.js';

void runHookHandler('on-session-stale', handleSessionStale);
