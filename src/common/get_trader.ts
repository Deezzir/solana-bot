import { PumpTrader, PumpRunner } from '../pump/pump';
import { JupiterTrader } from '../jupiter/jupiter';
import { MeteoraRunner, MeteoraTrader } from '../meteora/meteora';
import { Program } from './common';
import { IProgramTrader } from './trade_common';
import { ISniper } from './snipe_common';
import { BonkRunner, BonkTrader } from '../bonk/bonk';
import { RaydiumRunner, RaydiumTraderInstance } from '../raydium/raydium';
import { SubscriberType } from './subscriber';
import { PROGRAM_COMPUTE_UNIT_LIMITS } from '../constants';
import { Executor } from './executor';

type ExecutorOptions = {
    enable_funding?: boolean;
    program?: Program;
};

export function get_program_compute_unit_limit(program: Program = global.PROGRAM): number | undefined {
    return PROGRAM_COMPUTE_UNIT_LIMITS[program];
}

export function get_program_trader(program: Program = global.PROGRAM): IProgramTrader {
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

export function create_executor({ enable_funding = false, program = global.PROGRAM }: ExecutorOptions = {}): Executor {
    const trader = get_program_trader(program);
    return new Executor(trader, enable_funding);
}

export function get_sniper(subscriber_type: SubscriberType, program: Program = global.PROGRAM): ISniper {
    const trader = get_program_trader(program);
    switch (program) {
        case Program.Pump: {
            return new PumpRunner(trader, subscriber_type);
        }
        case Program.Meteora: {
            return new MeteoraRunner(trader, subscriber_type);
        }
        case Program.Bonk: {
            return new BonkRunner(trader, subscriber_type);
        }
        case Program.Jupiter: {
            throw new Error('Jupiter program is not supported for sniping.');
        }
        case Program.Raydium: {
            return new RaydiumRunner(trader, subscriber_type);
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}
