// Isolated fresh-process restore probe: never dispatches model work.
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { restore } from '../../src/state.ts';
console.log(JSON.stringify(restore(SessionManager.open(process.argv[2]).getBranch())));
