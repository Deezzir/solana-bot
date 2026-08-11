import { Connection } from '@solana/web3.js';
import { Moonshot } from '@wen-moon-ser/moonshot-sdk';
import type { Interface } from 'readline';
import { Helius } from 'helius-sdk';

declare global {
    var RL: Interface;
    var CONNECTION: Connection;
    var HELIUS_CONNECTION: Helius;
    var NO_COLORS: boolean;
}

export {};
