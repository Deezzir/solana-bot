import { Connection } from '@solana/web3.js';
import type { Interface } from 'readline';
import type { TransactionRelay } from './constants';
import type { Program } from './common/common';

declare global {
    var RL: Interface;
    var CONNECTION: Connection;
    var NO_COLORS: boolean;
    var PROGRAM: Program;
    var TRANSACTION_RELAY: TransactionRelay;
    var TRANSACTION_VERSION: 0 | 1;
    var PRIORITY_FEE: number | undefined;
    var FUNDING: boolean;
}

export {};
