import { handleContextThreshold } from './handlers.js';
import { runHookHandler } from './runner.js';

void runHookHandler('on-context-threshold', handleContextThreshold);
