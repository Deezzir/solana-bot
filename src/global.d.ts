import { Connection } from '@solana/web3.js';
import type { Interface } from 'readline';

declare global {
    var RL: Interface;
    var CONNECTION: Connection;
    var NO_COLORS: boolean;
}

export {};
