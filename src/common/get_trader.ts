import { PumpTrader, PumpRunner } from '../pump/pump';
import { JupiterTrader } from '../jupiter/jupiter';
import { MeteoraRunner, MeteoraTrader } from '../meteora/meteora';
import { Program } from './common';
import { IProgramTrader } from './trade_common';
import { ISniper } from './snipe_common';
import { BonkRunner, BonkTrader } from '../bonk/bonk';
import { RaydiumRunner, RaydiumTraderInstance } from '../raydium/raydium';

export function get_trader(program: Program): IProgramTrader {
    switch (program) {
        case Program.Pump: {
            return PumpTrader;
        }
        case Program.Meteora: {
            return MeteoraTrader;
        }
        case Program.Jupiter: {
            return JupiterTrader;
        }
        case Program.Bonk: {
            return BonkTrader;
        }
        case Program.Raydium: {
            return RaydiumTraderInstance;
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}

export function get_sniper(program: Program): ISniper {
    const trader = get_trader(program);
    switch (program) {
        case Program.Pump: {
            return new PumpRunner(trader);
        }
        case Program.Meteora: {
            return new MeteoraRunner(trader);
        }
        case Program.Bonk: {
            return new BonkRunner(trader);
        }
        case Program.Jupiter: {
            throw new Error('Jupiter program is not supported for sniping.');
        }
        case Program.Raydium: {
            return new RaydiumRunner(trader);
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}
