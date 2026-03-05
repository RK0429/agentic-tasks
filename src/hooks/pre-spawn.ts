import { handlePreSpawn } from './handlers.js';
import { runHookHandler } from './runner.js';

void runHookHandler('pre-spawn', handlePreSpawn);
